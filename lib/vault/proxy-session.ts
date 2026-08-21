import { VAULT_SESSION_COOKIE } from "./constants";

type StatusFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function localStatusUrl(portValue = process.env.PORT): string | null {
  const raw = portValue?.trim() || "1313";
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  if (port < 1 || port > 65_535) return null;
  return `http://127.0.0.1:${port}/api/vault/status`;
}

export async function proxyVaultSessionIsUnlocked(
  token: string | null | undefined,
  fetchStatus: StatusFetch = fetch,
  portValue = process.env.PORT,
): Promise<boolean> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const statusUrl = localStatusUrl(portValue);
  if (!statusUrl) return false;

  try {
    const response = await fetchStatus(statusUrl, {
      method: "GET",
      headers: { cookie: `${VAULT_SESSION_COOKIE}=${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const payload = await response.json() as { status?: unknown };
    return payload.status === "unlocked";
  } catch {
    return false;
  }
}
