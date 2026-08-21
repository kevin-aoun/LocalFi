/**
 * The HTTP door to chat capture.
 *
 * ============================================================================
 * WHY AN HTTP ROUTE AND NOT A SECOND PROCESS
 * ============================================================================
 *
 * `lib/db/client.ts` serializes writers with an IN-PROCESS lock, and `saveDb()`
 * rewrites the whole database file. Two processes writing `data/budget.db` means
 * last-writer-wins on the ENTIRE ledger, not on a row. So the Telegram worker
 * (and anything else) must not import the database client; it posts here, and the
 * Next.js process stays the sole writer. That is the whole point of this file.
 *
 * ============================================================================
 * WHY IT IS AUTHENTICATED WHEN NOTHING ELSE IN THE APP IS
 * ============================================================================
 *
 * The rest of this app has no auth because it is a local, single-user desktop
 * thing with no inbound port. This route breaks both halves of that: it accepts
 * a message from outside the browser and it WRITES. An unauthenticated write
 * endpoint on a financial ledger is not acceptable at any deployment size.
 *
 * So:
 *   - a bearer token from `AGENT_API_TOKEN` is required;
 *   - it is compared in constant time (a byte-by-byte compare leaks the prefix
 *     to anyone who can time responses);
 *   - and **an unset token means the route refuses to serve at all.** Fail
 *     closed. "No secret configured" must never be reachable as "no secret
 *     required" — that inversion is how staging environments end up open.
 *
 * A mismatch returns a bare 401: no hint about length, format or whether the
 * token exists, because each of those is a free guess for an attacker.
 */

import { handleMessage, type AgentReply } from "@/lib/agent/handle";
import { AGENT_TOOLS } from "@/lib/agent/tools";
import { needleBudget } from "@/lib/agent/tool-schema";
import { isDateKey } from "@/lib/dates";
import { agentAuthConfigured, authorizeAgentRequest } from "@/lib/agent/api-auth";
import { withActiveVaultAuthorization } from "@/lib/vault/access";
import { VaultLockedError } from "@/lib/vault/errors";

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** Writes must never be cached or statically evaluated at build time. */
export const dynamic = "force-dynamic";

/** Node APIs (`node:crypto`, the sql.js database) are not available on edge. */
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

// Auth lives in lib/agent/api-auth.ts so this route and /api/snapshot cannot
// drift apart on a security check.


// ---------------------------------------------------------------------------
// GET /api/agent — readiness
// ---------------------------------------------------------------------------

/**
 * Is the agent surface configured and internally consistent?
 *
 * Deliberately says nothing sensitive: no database path, no token, no balances,
 * no model output. Just enough for a supervisor to know whether posting a
 * message could possibly work.
 */
export async function GET(): Promise<Response> {
  const configured = agentAuthConfigured();
  const budget = needleBudget();

  try {
    await withActiveVaultAuthorization(async () => undefined, { touch: false });
  } catch (error) {
    if (error instanceof VaultLockedError) return json({ error: "vault_locked" }, 423);
    throw error;
  }

  return json(
    {
      ok: configured,
      service: "agent",
      /** Whether AGENT_API_TOKEN is set. Never the token itself. */
      configured,
      authRequired: true,
      toolCount: AGENT_TOOLS.length,
      /** The 1024-token encoder budget. `fits: false` means model calls are refused. */
      toolPayload: {
        estimatedTokens: budget.estimatedTokens,
        limit: budget.limit,
        fits: budget.fits,
      },
    },
    configured ? 200 : 503,
  );
}

// ---------------------------------------------------------------------------
// POST /api/agent — one message
// ---------------------------------------------------------------------------

type AgentRequestBody = {
  message?: unknown;
  debug?: unknown;
  today?: unknown;
};

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeAgentRequest(request);
  if (!auth.ok) return auth.response;

  let body: AgentRequestBody;
  try {
    body = (await request.json()) as AgentRequestBody;
  } catch {
    return json({ error: "invalid_json", detail: "The body must be a JSON object." }, 400);
  }

  if (typeof body?.message !== "string") {
    return json(
      { error: "invalid_request", detail: 'Expected {"message": "<text>"}.' },
      400,
    );
  }

  // An explicit `today` is accepted so a caller in another timezone (the Telegram
  // worker knows the user's day) can be authoritative. It is validated, never
  // coerced — a bad value must not silently become the server's day.
  //
  // KNOWN LIMIT, so nobody trusts this further than it goes: `today` fixes
  // relative phrases ("yesterday") and the period wording in replies, but a call
  // carrying NO date is defaulted inside `dateArg` in lib/agent/tools.ts, which
  // reads the clock itself. So "10 groceries" lands on the SERVER's day
  // regardless of what is sent here. Closing that gap means changing tools.ts.
  if (body.today !== undefined && !isDateKey(body.today)) {
    return json(
      { error: "invalid_request", detail: '"today" must be a YYYY-MM-DD date.' },
      400,
    );
  }

  let reply: AgentReply;
  try {
    reply = await withActiveVaultAuthorization(() => handleMessage(body.message as string, {
      debug: body.debug === true,
      ...(typeof body.today === "string" ? { today: body.today } : {}),
    }));
  } catch (error) {
    if (error instanceof VaultLockedError) return json({ error: "vault_locked" }, 423);
    throw error;
  }

  // Always 200 for a handled message: `status` inside the payload is the result,
  // and an HTTP error code here would conflate "the ledger refused this" with
  // "the request was malformed". `handleMessage` does not throw.
  return json(reply, 200);
}
