import { vaultCookie } from "@/lib/vault/access";
import { validatePassphraseSubmission } from "@/lib/vault/passphrase";
import { vaultSessionManager } from "@/lib/vault/session";
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
  const key = failureKey(request, "recovery");
  if (vaultFailureLimiter.blocked(key)) return json({ error: "unable_to_recover" }, 429);
  const body = await smallJson(request);
  const assessment = validatePassphraseSubmission(body?.passphrase, body?.acknowledgeWeak);
  if (
    !body ||
    typeof body.recoverySecret !== "string" ||
    body.recoverySecret.length === 0 ||
    body.recoverySecret.length > 512 ||
    !assessment.valid ||
    body.confirmPassphrase !== body.passphrase
  ) {
    vaultFailureLimiter.fail(key);
    return json({ error: "unable_to_recover" }, 401);
  }

  try {
    const result = await vaultSessionManager.recover(
      body.recoverySecret,
      body.passphrase as string,
    );
    vaultFailureLimiter.succeed(key);
    return json(
      { status: "unlocked", recoverySecret: result.recoverySecret },
      200,
      { "set-cookie": vaultCookie(result.token, request) },
    );
  } catch {
    vaultFailureLimiter.fail(key);
    return json({ error: "unable_to_recover" }, 401);
  }
}
