import { vaultCookie } from "@/lib/vault/access";
import {
  consumeVaultBootstrapCredential,
  verifyVaultBootstrapCredential,
} from "@/lib/vault/bootstrap";
import { validatePassphraseSubmission } from "@/lib/vault/passphrase";
import { vaultSessionManager } from "@/lib/vault/session";
import { setupFailureDetail } from "@/lib/vault/setup-failure";
import {
  failureKey,
  json,
  mutationGuard,
  smallJson,
  vaultFailureLimiter,
} from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const rejected = mutationGuard(request);
  if (rejected) return rejected;
  const key = failureKey(request, "setup");
  if (vaultFailureLimiter.blocked(key)) return json({ error: "unable_to_setup" }, 429);
  const body = await smallJson(request);
  if (!body) return json({ error: "invalid_request" }, 400);
  if (!verifyVaultBootstrapCredential(body.bootstrapCredential)) {
    vaultFailureLimiter.fail(key);
    return json({ error: "unable_to_setup" }, 401);
  }
  const passphrase = body.passphrase;
  const assessment = validatePassphraseSubmission(passphrase, body.acknowledgeWeak);
  if (!assessment.valid) {
    return json({ error: "invalid_passphrase", detail: assessment.error }, 400);
  }
  if (body.confirmPassphrase !== passphrase) {
    return json({ error: "passphrases_do_not_match" }, 400);
  }

  try {
    const result = await vaultSessionManager.setup(passphrase as string);
    consumeVaultBootstrapCredential();
    vaultFailureLimiter.succeed(key);
    return json(
      { status: "unlocked", recoverySecret: result.recoverySecret },
      200,
      { "set-cookie": vaultCookie(result.token, request) },
    );
  } catch (error) {
    vaultFailureLimiter.fail(key);
    const detail = setupFailureDetail(error);
    console.error("[vault] setup failed", {
      category: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ error: "unable_to_setup", ...(detail ? { detail } : {}) }, 400);
  }
}
