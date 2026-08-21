import { vaultCookie } from "@/lib/vault/access";
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
  const key = failureKey(request, "unlock");
  if (vaultFailureLimiter.blocked(key)) return json({ error: "unable_to_unlock" }, 429);
  const body = await smallJson(request);
  if (
    !body ||
    typeof body.passphrase !== "string" ||
    body.passphrase.length < 12 ||
    body.passphrase.length > 256
  ) {
    vaultFailureLimiter.fail(key);
    return json({ error: "unable_to_unlock" }, 401);
  }
  try {
    const token = await vaultSessionManager.unlock(body.passphrase);
    vaultFailureLimiter.succeed(key);
    return json(
      { status: "unlocked" },
      200,
      { "set-cookie": vaultCookie(token, request) },
    );
  } catch {
    vaultFailureLimiter.fail(key);
    return json({ error: "unable_to_unlock" }, 401);
  }
}
