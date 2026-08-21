import { clearVaultCookie, vaultStatusForRequest } from "@/lib/vault/access";
import { json, mutationGuard, smallJson } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function statusResponse(request: Request, touch: boolean): Promise<Response> {
  try {
    const status = await vaultStatusForRequest({ touch });
    return json(
      { status },
      200,
      status === "unlocked" ? undefined : { "set-cookie": clearVaultCookie(request) },
    );
  } catch {
    return json(
      { status: "locked", error: "vault_unavailable" },
      503,
      { "set-cookie": clearVaultCookie(request) },
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  return statusResponse(request, false);
}

export async function POST(request: Request): Promise<Response> {
  const rejected = mutationGuard(request);
  if (rejected) return rejected;
  if (!await smallJson(request)) return json({ error: "invalid_request" }, 400);
  return statusResponse(request, true);
}
