/** Fail-closed bearer authentication for the optional snapshot endpoint. */
import { createHash, timingSafeEqual } from "node:crypto";

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function configuredToken(): string | null {
  const raw = process.env.SNAPSHOT_API_TOKEN;
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  return token === "" ? null : token;
}

export function snapshotAuthConfigured(): boolean {
  return configuredToken() !== null;
}

function secretsMatch(presented: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(presented, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function bearerFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export type SnapshotAuthOutcome = { ok: true } | { ok: false; response: Response };

export function authorizeSnapshotRequest(request: Request): SnapshotAuthOutcome {
  const expected = configuredToken();
  if (!expected) return { ok: false, response: snapshotAuthDisabledResponse() };

  const presented = bearerFrom(request);
  if (!presented || !secretsMatch(presented, expected)) {
    return { ok: false, response: json({ error: "unauthorized" }, 401) };
  }
  return { ok: true };
}

export function snapshotAuthDisabledResponse(): Response {
  return json(
    {
      error: "snapshot_api_disabled",
      detail:
        "SNAPSHOT_API_TOKEN is not set. Configure a long random token before enabling snapshots.",
    },
    503,
  );
}
