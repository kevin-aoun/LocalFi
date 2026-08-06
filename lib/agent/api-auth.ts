/**
 * Shared bearer-token auth for the app's write endpoints.
 *
 * Extracted from `app/api/agent/route.ts` when `app/api/snapshot/route.ts`
 * needed the same rules. A security check copy-pasted into two routes drifts —
 * one gets a fix and the other quietly does not.
 *
 * The rules, and why:
 *
 *  - **Fails closed.** An unset `AGENT_API_TOKEN` refuses every request with 503
 *    rather than serving openly. This app has no user accounts; an endpoint that
 *    silently opened when a secret was missing would be the worst kind of bug.
 *  - **The configured-check runs BEFORE the compare**, so a misconfigured
 *    deployment cannot be probed for valid tokens.
 *  - **Constant-time compare over fixed-width digests.** `timingSafeEqual`
 *    throws on a length mismatch, and comparing lengths first would leak the
 *    token's length; hashing both sides to 32 bytes removes that signal.
 *  - **401 carries no detail** — not the reason, not the expected format.
 */
import { createHash, timingSafeEqual } from "node:crypto";

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** The configured token, or null when endpoints must refuse to serve. */
function configuredToken(): string | null {
  const raw = process.env.AGENT_API_TOKEN;
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  return token === "" ? null : token;
}

/** Whether a token is configured. Never exposes the token itself. */
export function agentAuthConfigured(): boolean {
  return configuredToken() !== null;
}

function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function bearerFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export type AuthOutcome = { ok: true } | { ok: false; response: Response };

/**
 * Authorize a request. `{ ok: true }` means it may proceed; otherwise return
 * `response` as-is.
 */
export function authorizeAgentRequest(request: Request): AuthOutcome {
  const expected = configuredToken();
  if (!expected) {
    // 503, not 401: the fault is the server's configuration, and telling a local
    // operator that is worth more than hiding it. It reveals nothing secret —
    // the route refuses every request either way.
    return {
      ok: false,
      response: json(
        {
          error: "agent_api_disabled",
          detail:
            "AGENT_API_TOKEN is not set, so this endpoint refuses to serve. Set it to a long " +
            "random string (e.g. `openssl rand -hex 32`) and restart the app.",
        },
        503,
      ),
    };
  }

  const presented = bearerFrom(request);
  if (!presented || !secretsMatch(presented, expected)) {
    return { ok: false, response: json({ error: "unauthorized" }, 401) };
  }
  return { ok: true };
}

/** The 503 body, for a GET health check that must not serve when unconfigured. */
export function agentAuthDisabledResponse(): Response {
  return json(
    { error: "agent_api_disabled", detail: "AGENT_API_TOKEN is not set." },
    503,
  );
}
