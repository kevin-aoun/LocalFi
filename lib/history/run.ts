
import { and, asc, eq, gte, lte } from "drizzle-orm";

import { readDb, withDb } from "@/lib/db/client";
import {
  assetHistory,
  netWorthSnapshots,
} from "@/lib/db/schema";
import { fromDateKey, isDateKey, todayKey, type DateKey } from "@/lib/dates";
import { sumCents, type Cents } from "@/lib/money";
import { isPriceSymbol, type PriceFetchLike, type PriceSymbol } from "@/lib/prices";
import {
  readAccountBalances,
  readCurrentMovements,
  readPositionValuations,
  readUnassignedAccountMovements,
} from "@/lib/ledger";
import type { Database } from "sql.js";

import {
  type HistoryError,
} from "./prices";
import {
  eachDay,
  type HistoryAsset,
  type HoldingPlan,
  type PurchaseContinuity,
  type ReconstructedDay,
  type ReconstructionWarning,
} from "./reconstruct";

function firstLedgerKey(raw: Database): DateKey | null {
  return readCurrentMovements(raw).map((movement) => movement.dateKey).sort()[0] ?? null;
}

function reconstructJournalDays(raw: Database, fromKey: DateKey, toKey: DateKey): ReconstructedDay[] | PlanError {
  const days: ReconstructedDay[] = [];
  const currentMovements = readCurrentMovements(raw);
  for (const dateKey of eachDay(fromKey, toKey)) {
    const buckets = new Map<string, { assets: Cents[]; liabilities: Cents[]; accounts: Cents[]; holdings: Cents[] }>();
    const bucket = (currency: string) => {
      const found = buckets.get(currency);
      if (found) return found;
      const created = { assets: [] as Cents[], liabilities: [] as Cents[], accounts: [] as Cents[], holdings: [] as Cents[] };
      buckets.set(currency, created);
      return created;
    };
    for (const balance of readAccountBalances(raw, { asOfKey: dateKey, currentMovements })) {
      const target = bucket(balance.currency);
      target.accounts.push(balance.balanceCents as Cents);
      if (balance.balanceCents < 0) target.liabilities.push(-balance.balanceCents as Cents);
      else target.assets.push(balance.balanceCents as Cents);
    }
    const unassigned = new Map<string, Cents[]>();
    for (const movement of readUnassignedAccountMovements(raw, { toKey: dateKey, currentMovements })) {
      const parts = unassigned.get(movement.currency) ?? [];
      parts.push(movement.amountCents as Cents);
      unassigned.set(movement.currency, parts);
    }
    for (const [currency, movements] of unassigned) {
      const balance = sumCents(movements);
      const target = bucket(currency);
      target.accounts.push(balance);
      if (balance < 0) target.liabilities.push(-balance as Cents);
      else target.assets.push(balance);
    }
    const valuations = readPositionValuations(raw, dateKey, currentMovements)
      .filter((position) => !position.archived);
    for (const valuation of valuations) {
      const target = bucket(valuation.currency);
      target.holdings.push(valuation.valueMinor as Cents);
      if (valuation.valueMinor < 0) target.liabilities.push(-valuation.valueMinor as Cents);
      else target.assets.push(valuation.valueMinor as Cents);
    }
    if (buckets.size === 0) bucket("USD");
    if (buckets.size > 1) {
      return {
        code: "mixed_currencies",
        message: `Cannot reconstruct one aggregate net-worth series for mixed currencies (${[...buckets.keys()].sort().join(", ")}). LocalFi has no historical FX model, so nothing was written.`,
      };
    }
    const [currency, parts] = [...buckets.entries()][0];
    const totalAssetsCents = sumCents(parts.assets);
    const totalLiabilitiesCents = sumCents(parts.liabilities);
    const holdings = valuations
      .filter((valuation) => valuation.assetId !== null)
      .map((valuation) => ({
        assetId: valuation.assetId!,
        label: valuation.label,
        symbol: null,
        currency: valuation.currency,
        held: true,
        valueCents: valuation.valueMinor as Cents,
        priceUsd: null,
        priceAsOfKey: valuation.observedDay,
        priceCarriedForward: valuation.observedDay !== dateKey,
        basis: valuation.observationKind === "price" ? "priced" as const : "carried-stored-value" as const,
      }));
    days.push({
      dateKey,
      currency,
      totalAssetsCents,
      totalLiabilitiesCents,
      netWorthCents: (totalAssetsCents - totalLiabilitiesCents) as Cents,
      accountsCents: sumCents(parts.accounts),
      holdingsCents: sumCents(parts.holdings),
      holdings,
      sourceNote: "Exact ledger position replay; valuations use the latest timestamped observation at or before this day.",
    });
  }
  return days;
}

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

  ledgerFirstKey: DateKey | null;
  days: ReconstructedDay[];
  holdings: HoldingPlan[];
  continuity: PurchaseContinuity[];
  warnings: ReconstructionWarning[];
  series: SeriesInfo[];

  existing: ExistingSnapshot[];
};

export type PlanError =
  | { code: "price_fetch_failed"; message: string; errors: HistoryError[] }
  | {
      code:
        | "bad_range"
        | "no_price_for_day"
        | "no_history_source"
        | "mixed_currencies"
        | "empty";
      message: string;
    };

export type PlanResult = { ok: true; plan: ReconstructionPlan } | { ok: false; error: PlanError };

export type WriteReport = {
  inserted: number;
  updated: number;
  unchanged: number;

  skippedRecorded: number;
  total: number;
};

export type PlanOptions = {
  fromKey?: DateKey;
  toKey?: DateKey;

  today?: DateKey;

  days?: number;

  fetchImpl?: PriceFetchLike;

  carryUnpriced?: boolean;

  onPriceRateLimitRetry?: (symbol: PriceSymbol, delayMs: number) => void;
};


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


export async function planNetWorthReconstruction(options: PlanOptions = {}): Promise<PlanResult> {
  const today = options.today ?? todayKey();
  if (!isDateKey(today)) {
    return { ok: false, error: { code: "bad_range", message: `Invalid today: ${String(today)}` } };
  }

  const ledgerFirstKey = await readDb((_db, raw) => firstLedgerKey(raw));

  const fromKey = options.fromKey ?? ledgerFirstKey ?? today;

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

  const exact = await readDb((_db, raw) => reconstructJournalDays(raw, fromKey, toKey));
  if (!Array.isArray(exact)) return { ok: false, error: exact };

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
      days: exact,
      holdings: [],
      continuity: [],
      warnings: [],
      series: [],
      existing,
    },
  };
}


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


      if (existing && existing.source !== "reconstructed") {
        report.skippedRecorded++;
        continue;
      }




      const recordedAt = fromDateKey(day.dateKey);
      await db.delete(assetHistory).where(eq(assetHistory.recordedDay, day.dateKey));
      const holdingRows = day.holdings
        .filter((holding) => holding.held)
        .map((holding) => ({
          assetId: holding.assetId,
          valueCents: holding.valueCents,
          currency: holding.currency,
          recordedDay: day.dateKey,
          recordedAt,
        }));
      if (holdingRows.length > 0) await db.insert(assetHistory).values(holdingRows);

      const values = {
        date: day.dateKey,
        currency: day.currency,
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
        existing.currency === values.currency &&
        existing.sourceNote === values.sourceNote;

      if (same) {

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


export async function runNetWorthReconstruction(
  options: PlanOptions & { apply?: boolean } = {},
): Promise<RunResult> {
  const planned = await planNetWorthReconstruction(options);
  if (!planned.ok) return planned;
  const write = options.apply === true ? await applyNetWorthReconstruction(planned.plan) : null;
  return { ok: true, plan: planned.plan, write };
}
