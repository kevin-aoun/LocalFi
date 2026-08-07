/**
 * Record today's net-worth snapshot.
 *
 * ## Why this endpoint exists
 *
 * `net_worth_snapshots` is what the dashboard's net-worth-over-time chart reads.
 * The endpoint and both visible buttons call the same refresh-and-record service,
 * so scheduled observations cannot drift from manual ones.
 *
 * ## Why an HTTP endpoint rather than a cron that opens the database
 *
 * `lib/db/client.ts` serialises writers with an **in-process** lock and
 * `saveDb()` rewrites the whole file, so a second process writing `budget.db`
 * means last-writer-wins on the entire ledger. The scheduler is therefore an
 * HTTP client and the app remains the only writer.
 *
 * ## Why it is safe to call often
 *
 * `recordNetWorthToday()` is idempotent per calendar day — re-running updates that
 * day's row rather than adding another. That is what lets the scheduler fire
 * every few hours instead of once at midnight: a machine asleep at 00:00 would
 * miss the day entirely, whereas any waking moment captures it.
 *
 * It deliberately does **not** backfill. A snapshot records *today's* derived
 * figures, so writing them under a past date would assert a net worth that was
 * never true. Days the machine was off stay honest gaps in the chart.
 */
import { recordNetWorthToday } from "@/app/actions/accounts";
import { todayKey } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import {
  agentAuthConfigured,
  agentAuthDisabledResponse,
  authorizeAgentRequest,
} from "@/lib/agent/api-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;

/** Readiness, without revealing anything about the ledger. */
export async function GET(): Promise<Response> {
  if (!agentAuthConfigured()) return agentAuthDisabledResponse();
  return Response.json({ ok: true, today: todayKey() }, { headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeAgentRequest(request);
  if (!auth.ok) return auth.response;

  try {
    const result = await recordNetWorthToday();

    if ("error" in result) {
      return Response.json({ ok: false, error: result.error }, { status: 400, headers: NO_STORE });
    }

    const snap = result.data;

    return Response.json(
      {
        ok: true,
        date: snap.date,
        netWorthCents: snap.netWorthCents,
        prices: snap.prices,
        // A readable line so `docker compose logs snapshot` is actually useful.
        summary:
          `${snap.date}: net worth ${formatMoney(snap.netWorthCents)} ` +
          `(assets ${formatMoney(snap.totalAssetsCents)}, ` +
          `liabilities ${formatMoney(snap.totalLiabilitiesCents)}). ${snap.priceSummary}`,
      },
      { headers: NO_STORE },
    );
  } catch (cause) {
    console.error("snapshot failed:", cause);
    return Response.json(
      { ok: false, error: (cause as Error).message || "snapshot failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}
