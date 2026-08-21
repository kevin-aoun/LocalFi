import { clearVaultCookie, currentVaultToken } from "@/lib/vault/access";
import { vaultSessionManager } from "@/lib/vault/session";
import { json, mutationGuard, smallJson } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const rejected = mutationGuard(request);
  if (rejected) return rejected;
  if (!await smallJson(request)) return json({ error: "invalid_request" }, 400);
  await vaultSessionManager.lock(await currentVaultToken());
  return json(
    { status: "locked" },
    200,
    { "set-cookie": clearVaultCookie(request) },
  );
}
