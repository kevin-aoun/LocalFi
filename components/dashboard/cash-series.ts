/**
 * The cash-balance series behind the dashboard candlestick chart, and the
 * "vs. last month" figure next to it.
 *
 * WHY THIS FILE EXISTS
 *
 * 1. **The chart used to contradict its own headline.** The series builder did
 *    `else return; // skip Investment`, while the `cashBalance` printed
 *    immediately above it (lib/cash-balance.ts) SUBTRACTS Investment rows. On
 *    the user's real ledger the final candle's close therefore never matched the
 *    number on the same card. There is now exactly one rule — this module's
 *    `cashContributionCents` — and a test asserts that summing it reproduces
 *    `deriveCashBalanceCents` exactly, so they cannot drift apart again.
 *
 * 2. **The grouping keys were built with `toISOString()`**, so east of UTC every
 *    transaction fell into the previous day's (and, at a month boundary, the
 *    previous month's) candle. All keys now come from lib/dates.ts.
 *
 * 3. **`growth` / `growthAmount` were hardcoded to `0`** on the dashboard, i.e.
 *    the "vs. last month" block was decoration. `computeCashGrowth` computes it.
 */
import {
  deriveCashBalanceCents,
  isTransfer,
  type CashLedgerCategory,
  type CashLedgerTransaction,
} from "@/lib/cash-balance";
import { monthKey, startOfMonth, toDateKey, type DateKey } from "@/lib/dates";
import { negateCents, sumCents, type Cents } from "@/lib/money";

export type ChartPeriod = "daily" | "weekly" | "monthly";

export type SeriesTransaction = CashLedgerTransaction & {
  /** Stored timestamp; may arrive as a Date or as something Date-constructible. */
  date: Date | string | number;
};

/**
 * Signed contribution of ONE transaction to the cash balance, in exact cents.
 *
 * This is the per-row form of the rule in lib/cash-balance.ts and it must stay
 * in lockstep with it: Income adds, Expense and Investment subtract, a
 * transaction whose category is missing (or a transfer between the user's own
 * accounts) contributes nothing. Pending and transfer rows are filtered by the
 * caller (`countsTowardsCash`), exactly as `deriveCashBalanceCents` does
 * internally.
 */
export function cashContributionCents(
  tx: CashLedgerTransaction,
  categories: readonly CashLedgerCategory[],
): Cents {
  if (isTransfer(tx)) return 0;
  if (tx.categoryId == null) return 0;
  const category = categories.find((c) => c.id === tx.categoryId);
  if (category?.type === "Income") return tx.amountCents;
  if (category?.type === "Expense" || category?.type === "Investment") {
    return negateCents(tx.amountCents);
  }
  return 0;
}

/** Only rows that count towards cash — same predicate as `deriveCashBalanceCents`. */
export function countsTowardsCash<T extends CashLedgerTransaction>(
  transactions: readonly T[],
): T[] {
  return transactions.filter((tx) => !tx.pending && !isTransfer(tx));
}

function asDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Bucket key for a transaction's LOCAL calendar day. Never `toISOString()`.
 * Weekly buckets start on the local Sunday, matching the previous behaviour.
 */
export function groupKey(date: Date, period: ChartPeriod): string {
  if (period === "monthly") return monthKey(date);
  if (period === "weekly") {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - d.getDay());
    return toDateKey(d);
  }
  return toDateKey(date);
}

export type Candle = {
  period: string;
  openCents: Cents;
  closeCents: Cents;
  highCents: Cents;
  lowCents: Cents;
};

/**
 * Running cash balance grouped into OHLC candles.
 *
 * The close of the LAST candle equals `deriveCashBalanceCents(transactions,
 * categories)` by construction, which is the number printed above the chart.
 */
export function buildCashCandles(
  transactions: readonly SeriesTransaction[],
  categories: readonly CashLedgerCategory[],
  period: ChartPeriod,
): Candle[] {
  const sorted = countsTowardsCash(transactions)
    .slice()
    .sort((a, b) => asDate(a.date).getTime() - asDate(b.date).getTime());

  if (sorted.length === 0) return [];

  const points: Array<{ key: string; balanceCents: Cents }> = [];
  let balanceCents: Cents = 0;
  for (const tx of sorted) {
    balanceCents = sumCents([balanceCents, cashContributionCents(tx, categories)]);
    points.push({ key: groupKey(asDate(tx.date), period), balanceCents });
  }

  const buckets: Array<{ key: string; openCents: Cents; balances: Cents[] }> = [];
  let prevClose: Cents = 0;
  for (const point of points) {
    const last = buckets[buckets.length - 1];
    if (last && last.key === point.key) {
      last.balances.push(point.balanceCents);
    } else {
      buckets.push({ key: point.key, openCents: prevClose, balances: [point.balanceCents] });
    }
    prevClose = point.balanceCents;
  }

  return buckets.map((bucket) => ({
    period: bucket.key,
    openCents: bucket.openCents,
    closeCents: bucket.balances[bucket.balances.length - 1],
    highCents: Math.max(bucket.openCents, ...bucket.balances),
    lowCents: Math.min(bucket.openCents, ...bucket.balances),
  }));
}

export type CashGrowth = {
  /** Change in cash since the end of last month, in exact cents (signed). */
  growthAmountCents: Cents;
  /** Percentage change, or null when last month closed at exactly zero. */
  growthPercent: number | null;
  /** Cash balance as at the end of last month. */
  baselineCents: Cents;
};

/**
 * "vs. last month": how much the cash balance has moved since the last day of
 * the previous month.
 *
 * The current figure is the balance over the WHOLE ledger — the same value the
 * dashboard headline prints — so the two can never disagree. The baseline is
 * that same rule applied to transactions dated before the first of this month.
 * The percentage is a ratio, not money, so plain division is correct; it is
 * `null` (not `Infinity`, not `0`) when the baseline is zero, because "up 100%
 * from nothing" is not a fact we can state.
 */
export function computeCashGrowth(
  transactions: readonly SeriesTransaction[],
  categories: readonly CashLedgerCategory[],
  now: Date = new Date(),
): CashGrowth {
  const firstOfThisMonth = startOfMonth(now).getTime();
  const priorMonths = transactions.filter((tx) => asDate(tx.date).getTime() < firstOfThisMonth);

  const currentCents = deriveCashBalanceCents(transactions, categories);
  const baselineCents = deriveCashBalanceCents(priorMonths, categories);
  const growthAmountCents = sumCents([currentCents, negateCents(baselineCents)]);

  return {
    growthAmountCents,
    growthPercent:
      baselineCents === 0 ? null : (growthAmountCents / Math.abs(baselineCents)) * 100,
    baselineCents,
  };
}

/** Human label for a bucket key, in the user's LOCAL calendar. */
export function formatPeriodLabel(key: string, period: ChartPeriod): string {
  if (period === "monthly") {
    const [year, month] = key.split("-");
    return new Date(Number(year), Number(month) - 1).toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
    });
  }
  return localDayFromKey(key).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** 'YYYY-MM-DD' -> local midnight, without `new Date(string)`'s UTC surprise. */
export function localDayFromKey(key: DateKey): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}
