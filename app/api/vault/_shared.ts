import {
  assertSameOriginJsonPost,
  rateLimitKey,
  VaultFailureRateLimiter,
} from "@/lib/vault/access";

export const NO_STORE = { "cache-control": "no-store" } as const;
export const vaultFailureLimiter = new VaultFailureRateLimiter();

export function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function mutationGuard(request: Request): Response | null {
  try {
    assertSameOriginJsonPost(request);
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > 16_384) throw new Error("request_too_large");
    return null;
  } catch {
    return json({ error: "invalid_request" }, 403);
  }
}

export async function smallJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > 16_384) return null;
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function failureKey(request: Request, operation: string): string {
  return rateLimitKey(request, operation);
}
