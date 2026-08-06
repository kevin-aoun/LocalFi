/**
 * The runnable half of historical reconstruction: read the database, fetch each
 * price series ONCE, compute the series, and — only if explicitly asked — write it.
 *
 * ORDER OF OPERATIONS IS THE SAFETY PROPERTY. Everything that can fail (the
 * network, a missing price for a day a holding was held, a bad range) happens in
 * `planNetWorthReconstruction`, which touches nothing. `applyNetWorthReconstruction`
 * takes a finished plan and writes it inside ONE `withDb` call, so a failure
 * cannot leave the table half-backfilled: either every row lands or none does.
 *
 * WRITE RULES
 *   - A day that already has a `recorded` row is SKIPPED, never replaced. A real
 *     measurement always outranks an estimate; the count of skips is reported.
 *   - A day whose `reconstructed` row already holds the same figures and note is
 *     left completely alone — not even `updated_at` moves — so re-running is a
 *     true no-op and the table cannot drift.
 *   - Anything else is inserted (or updated) with `source = 'reconstructed'`.
 *
 * `today` is a PARAMETER, never a clock read in a helper: the test suite runs at
 * UTC+14 and UTC−11 and every day boundary here has to be the caller's.
 */
import { and, asc, eq, gte, lte } from "drizzle-orm";

import { readDb, withDb } from "@/lib/db/client";
import {
  accounts as accountsTable,
  assetHistory,
  assets as assetsTable,
  categories as categoriesTable,
  netWorthSnapshots,
  transactions as transactionsTable,
} from "@/lib/db/schema";
import { fromDateKey, isDateKey, todayKey, type DateKey } from "@/lib/dates";
import { type Cents } from "@/lib/money";
import { isPriceSymbol, type PriceFetchLike, type PriceSymbol } from "@/lib/prices";
import { toReportTransactions } from "@/lib/reports";

import {
  MAX_HISTORY_DAYS,
  fetchPriceSeries,
  describeHistoryError,
  HISTORICAL_PRICE_SOURCES,
  type HistoryError,
  type PriceSeries,
} from "./prices";
import {
  reconstructNetWorthSeries,
  type HistoryAsset,
  type HoldingPlan,
  type PurchaseContinuity,
  type ReconstructedDay,
  type ReconstructionWarning,
} from "./reconstruct";

export type ExistingSnapshot = {
  dateKey: DateKey;
  source: string;
  netWorthCents: Cents;
};

export type SeriesInfo = {
  symbol: PriceSymbol;
  coinGeckoId: string;
  proxy: boolean;
  firstKey: DateKey;
  lastKey: DateKey;
  points: number;
};

export type ReconstructionPlan = {
  fromKey: DateKey;
  toKey: DateKey;
  today: DateKey;
  /** The first day the ledger has anything to say. Null when there are no rows. */
  ledgerFirstKey: DateKey | null;
  days: ReconstructedDay[];
  holdings: HoldingPlan[];
  continuity: PurchaseContinuity[];
  warnings: ReconstructionWarning[];
  series: SeriesInfo[];
  /** Snapshot rows that already exist in the range, as seen while planning. */
  existing: ExistingSnapshot[];
};

export type PlanError =
  | { code: "price_fetch_failed"; message: string; errors: HistoryError[] }
  | { code: "bad_range" | "no_price_for_day" | "no_history_source" | "empty"; message: string };

export type PlanResult = { ok: true; plan: ReconstructionPlan } | { ok: false; error: PlanError };

export type WriteReport = {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Days left alone because a REAL snapshot already exists for them. */
  skippedRecorded: number;
  total: number;
};

export type PlanOptions = {
  fromKey?: DateKey;
  toKey?: DateKey;
  /** The caller's today. Defaults to the local calendar day. */
  today?: DateKey;
  /** Price window to request, capped at the keyless tier's 365. */
  days?: number;
  /** Injected in tests; there is no live network in the test suite. */
  fetchImpl?: PriceFetchLike;
  /** Carry a holding's stored value when its price cannot be known. Off by default. */
  carryUnpriced?: boolean;
  /** Report a provider throttle while the price layer waits and retries. */
  onPriceRateLimitRetry?: (symbol: PriceSymbol, delayMs: number) => void;
};

/** Which symbols this database actually needs a series for. */
export function neededSymbols(assets: readonly HistoryAsset[]): PriceSymbol[] {
  const wanted = new Set<PriceSymbol>();
  for (const asset of assets) {
    if (asset.category === "Cash") continue;
    const symbol = asset.priceSymbol;
    if (typeof symbol !== "string" || !isPriceSymbol(symbol)) continue;
    const quantity = asset.quantity;
    if (quantity === null || quantity === undefined || !Number.isFinite(quantity)) continue;
    wanted.add(symbol);
  }
  return [...wanted];
}

/**
 * Everything except the write. Reads the database, fetches each series once, and
 * returns the day-by-day reconstruction — or an error, having written nothing.
 */
export async function planNetWorthReconstruction(options: PlanOptions = {}): Promise<PlanResult> {
  const today = options.today ?? todayKey();
  if (!isDateKey(today)) {
    return { ok: false, error: { code: "bad_range", message: `Invalid today: ${String(today)}` } };
  }

  const loaded = await readDb(async (db) => {
    const accounts = await db.select().from(accountsTable);
    const txRows = await db.select().from(transactionsTable).orderBy(asc(transactionsTable.date));
    const categories = await db.select().from(categoriesTable);
    const assets = await db.select().from(assetsTable);
    return { accounts, txRows, categories, assets };
  });

  const transactions = toReportTransactions(loaded.txRows);
  const ledgerFirstKey =
    transactions.length === 0
      ? null
      : transactions.reduce<DateKey>((min, tx) => (tx.dateKey < min ? tx.dateKey : min), transactions[0].dateKey);

  const fromKey = options.fromKey ?? ledgerFirstKey ?? today;
  // Never past today: reconstruction computes what WAS, and tomorrow has no was.
  const requestedTo = options.toKey ?? today;
  const toKey = requestedTo > today ? today : requestedTo;

  if (!isDateKey(fromKey) || !isDateKey(toKey)) {
    return {
      ok: false,
      error: { code: "bad_range", message: `Invalid range: ${String(fromKey)}..${String(toKey)}` },
    };
  }
  if (fromKey > toKey) {
    return {
      ok: false,
      error: { code: "bad_range", message: `Range runs backwards: ${fromKey} is after ${toKey}` },
    };
  }

  const assets: HistoryAsset[] = loaded.assets.map((row) => ({
    id: row.id,
    category: row.category,
    currentValueCents: row.currentValueCents,
    quantity: row.quantity,
    unit: row.unit,
    priceSymbol: row.priceSymbol,
    notes: row.notes,
    linkedTransactionIds: row.linkedTransactionIds,
    createdAt: row.createdAt,
  }));

  const carryUnpriced = options.carryUnpriced === true;
  const symbols = neededSymbols(assets).filter(
    // With --carry-unpriced, a symbol nobody can serve history for is not an
    // error; it falls through to the carried stored value and is disclosed there.
    (symbol) => !carryUnpriced || HISTORICAL_PRICE_SOURCES[symbol] !== null,
  );

  const seriesBySymbol = new Map<PriceSymbol, PriceSeries>();
  if (symbols.length > 0) {
    const days = Math.min(options.days ?? MAX_HISTORY_DAYS, MAX_HISTORY_DAYS);
    const fetched = await fetchPriceSeries(symbols, {
      fetchImpl: options.fetchImpl,
      days,
      // Three requests in a burst exceed CoinGecko's public/keyless allowance.
      spacingMs: options.fetchImpl ? 0 : 15_000,
      onRateLimitRetry: options.onPriceRateLimitRetry,
    });
    if (!fetched.ok) {
      return {
        ok: false,
        error: {
          code: "price_fetch_failed",
          message:
            `Could not load price history, so NOTHING was written: ` +
            fetched.errors.map(describeHistoryError).join(" "),
          errors: fetched.errors,
        },
      };
    }
    for (const [symbol, series] of fetched.series) seriesBySymbol.set(symbol, series);
  }

  const result = reconstructNetWorthSeries({
    accounts: loaded.accounts,
    transactions,
    categories: loaded.categories,
    assets,
    seriesBySymbol,
    fromKey,
    toKey,
    carryUnpriced,
  });

  if (!result.ok) return { ok: false, error: result.error };

  const existing = await readDb(async (db) => {
    const rows = await db
      .select()
      .from(netWorthSnapshots)
      .where(and(gte(netWorthSnapshots.date, fromKey), lte(netWorthSnapshots.date, toKey)))
      .orderBy(asc(netWorthSnapshots.date));
    return rows.map((row) => ({
      dateKey: row.date,
      source: row.source,
      netWorthCents: row.netWorthCents,
    }));
  });

  return {
    ok: true,
    plan: {
      fromKey,
      toKey,
      today,
      ledgerFirstKey,
      days: result.days,
      holdings: result.holdings,
      continuity: result.continuity,
      warnings: result.warnings,
      series: [...seriesBySymbol.values()].map((series) => ({
        symbol: series.symbol,
        coinGeckoId: series.source.coinGeckoId,
        proxy: series.source.proxy,
        firstKey: series.firstKey,
        lastKey: series.lastKey,
        points: series.points.length,
      })),
      existing,
    },
  };
}

/**
 * Write a finished plan. One `withDb`, so it is all-or-nothing, and the existing
 * rows are re-read INSIDE it rather than trusted from planning time.
 */
export async function applyNetWorthReconstruction(plan: ReconstructionPlan): Promise<WriteReport> {
  return withDb(async (db) => {
    const rows = await db
      .select()
      .from(netWorthSnapshots)
      .where(and(gte(netWorthSnapshots.date, plan.fromKey), lte(netWorthSnapshots.date, plan.toKey)));
    const byDate = new Map(rows.map((row) => [row.date, row]));

    const report: WriteReport = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skippedRecorded: 0,
      total: plan.days.length,
    };

    for (const day of plan.days) {
      const existing = byDate.get(day.dateKey);

      // A measurement always outranks an estimate.
      if (existing && existing.source !== "reconstructed") {
        report.skippedRecorded++;
        continue;
      }

      // Keep the per-holding child ledger aligned with this reconstructed
      // net-worth day. The normalized local-midnight timestamp gives a stable,
      // idempotent day key without changing the legacy table's schema.
      const recordedAt = fromDateKey(day.dateKey);
      await db.delete(assetHistory).where(eq(assetHistory.recordedAt, recordedAt));
      const holdingRows = day.holdings
        .filter((holding) => holding.held)
        .map((holding) => ({
          assetId: holding.assetId,
          valueCents: holding.valueCents,
          recordedAt,
        }));
      if (holdingRows.length > 0) await db.insert(assetHistory).values(holdingRows);

      const values = {
        date: day.dateKey,
        totalAssetsCents: day.totalAssetsCents,
        totalLiabilitiesCents: day.totalLiabilitiesCents,
        netWorthCents: day.netWorthCents,
        source: "reconstructed" as const,
        sourceNote: day.sourceNote,
      };

      if (!existing) {
        await db.insert(netWorthSnapshots).values(values);
        report.inserted++;
        continue;
      }

      const same =
        existing.totalAssetsCents === values.totalAssetsCents &&
        existing.totalLiabilitiesCents === values.totalLiabilitiesCents &&
        existing.netWorthCents === values.netWorthCents &&
        existing.sourceNote === values.sourceNote;

      if (same) {
        // Identical: leave updated_at alone so a re-run is a true no-op.
        report.unchanged++;
        continue;
      }

      await db
        .update(netWorthSnapshots)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(netWorthSnapshots.id, existing.id));
      report.updated++;
    }

    return report;
  });
}

export type RunResult =
  | { ok: true; plan: ReconstructionPlan; write: WriteReport | null }
  | { ok: false; error: PlanError };

/** Plan, and write only when `apply` is explicitly true. */
export async function runNetWorthReconstruction(
  options: PlanOptions & { apply?: boolean } = {},
): Promise<RunResult> {
  const planned = await planNetWorthReconstruction(options);
  if (!planned.ok) return planned;
  const write = options.apply === true ? await applyNetWorthReconstruction(planned.plan) : null;
  return { ok: true, plan: planned.plan, write };
}
