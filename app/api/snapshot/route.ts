/**
 * Record today's net-worth snapshot.
 *
 * ## Why this endpoint exists
 *
 * `net_worth_snapshots` is what the dashboard's net-worth-over-time chart reads,
 * and `snapshotNetWorth()` is the only thing that writes it. Until now the sole
 * trigger was a button on /accounts, so the table stayed nearly empty and the
 * chart had nothing to draw. History you have to remember to record is history
 * you do not get.
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
 * `snapshotNetWorth()` is idempotent per calendar day — re-running updates that
 * day's row rather than adding another. That is what lets the scheduler fire
 * every few hours instead of once at midnight: a machine asleep at 00:00 would
 * miss the day entirely, whereas any waking moment captures it.
 *
 * It deliberately does **not** backfill. A snapshot records *today's* derived
 * figures, so writing them under a past date would assert a net worth that was
 * never true. Days the machine was off stay honest gaps in the chart.
 */
import { snapshotNetWorth } from "@/app/actions/accounts";
import { refreshLivePricedAssets } from "@/app/actions/crypto";
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

  // Re-price live holdings FIRST, or the snapshot records stale values.
  //
  // `snapshotNetWorth()` reads `assets.current_value_cents` as stored and fetches
  // nothing, so without this a scheduled snapshot of a gold or crypto holding
  // records whatever number was last written — for a never-priced holding, the
  // figure from the original migration. A chart of stale numbers is worse than an
  // empty chart, because it looks like data.
  //
  // Deliberately NON-FATAL: an offline machine should still record a snapshot of
  // the values it has and say so, rather than skipping the day entirely.
  let priced: Awaited<ReturnType<typeof refreshLivePricedAssets>> | null = null;
  let priceError: string | null = null;
  try {
    priced = await refreshLivePricedAssets();
  } catch (cause) {
    priceError = (cause as Error).message || "price refresh failed";
    console.warn("snapshot: price refresh failed, recording stored values:", priceError);
  }

  try {
    const result = await snapshotNetWorth();

    if ("error" in result) {
      return Response.json({ ok: false, error: result.error }, { status: 400, headers: NO_STORE });
    }

    const snap = result.data as {
      date: string;
      netWorthCents: number;
      totalAssetsCents: number;
      totalLiabilitiesCents: number;
    };

    return Response.json(
      {
        ok: true,
        date: snap.date,
        netWorthCents: snap.netWorthCents,
        // A readable line so `docker compose logs snapshot` is actually useful.
        prices: priceError
          ? { ok: false, error: priceError }
          : { ok: true, refreshed: priced?.refreshed ?? 0, skipped: priced?.skipped ?? 0,
              // Reported every run, never folded into `failed`: a symbol with no
              // price source is a standing fact, not an outage, and the holding
              // is carrying whatever value was last entered by hand.
              unpriceable: priced?.unpriceable ?? [],
              failed: priced?.failed ?? [] },
        summary:
          `${snap.date}: net worth ${formatMoney(snap.netWorthCents)} ` +
          `(assets ${formatMoney(snap.totalAssetsCents)}, ` +
          `liabilities ${formatMoney(snap.totalLiabilitiesCents)})` +
          (priceError
            ? `: prices NOT refreshed (${priceError}), stored values used`
            : `, repriced ${priced?.refreshed ?? 0} holding(s)` +
              ((priced?.failed.length ?? 0) > 0
                ? `, ${priced!.failed.length} failed: ${priced!.failed.map((f) => f.label).join(", ")}`
                : "") +
              ((priced?.unpriceable.length ?? 0) > 0
                ? `, ${priced!.unpriceable.length} have no price source and kept their stored ` +
                  `value: ${priced!.unpriceable.map((u) => `${u.label} (${u.symbol})`).join(", ")}`
                : "")),
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
