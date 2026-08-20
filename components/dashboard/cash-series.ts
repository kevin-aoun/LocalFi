
import {
  deriveCashBalanceCents,
  isTransfer,
  normalizeLedgerCurrency,
  transactionCashDirection,
  type CashLedgerCategory,
  type CashLedgerTransaction,
} from "@/lib/cash-balance";
import { monthKey, startOfMonth, toDateKey, type DateKey } from "@/lib/dates";
import { negateCents, sumCents, type Cents } from "@/lib/money";

export type ChartPeriod = "daily" | "weekly" | "monthly";

export type SeriesTransaction = CashLedgerTransaction & {

  date: Date | string | number;
};

export function cashContributionCents(
  tx: CashLedgerTransaction,
  categories: readonly CashLedgerCategory[],
): Cents {
  if (isTransfer(tx)) return 0;
  const categoryType =
    tx.categoryId == null ? undefined : categories.find((c) => c.id === tx.categoryId)?.type;
  switch (transactionCashDirection(tx, categoryType)) {
    case "inflow":
      return tx.amountCents;
    case "outflow":
      return negateCents(tx.amountCents);
    default:
      return 0;
  }
}

export function countsTowardsCash<T extends CashLedgerTransaction>(
  transactions: readonly T[],
  currency?: string,
): T[] {
  const selectedCurrency =
    currency === undefined ? undefined : normalizeLedgerCurrency(currency);
  return transactions.filter(
    (tx) =>
      !tx.pending &&
      !isTransfer(tx) &&
      (selectedCurrency === undefined ||
        normalizeLedgerCurrency(tx.currency, "USD") === selectedCurrency),
  );
}

function asDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

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

export function buildCashCandles(
  transactions: readonly SeriesTransaction[],
  categories: readonly CashLedgerCategory[],
  period: ChartPeriod,
  currency?: string,
): Candle[] {
  const sorted = countsTowardsCash(transactions, currency)
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

  growthAmountCents: Cents;

  growthPercent: number | null;

  baselineCents: Cents;
};

export function computeCashGrowth(
  transactions: readonly SeriesTransaction[],
  categories: readonly CashLedgerCategory[],
  now: Date = new Date(),
  currency?: string,
): CashGrowth {
  const firstOfThisMonth = startOfMonth(now).getTime();
  const priorMonths = transactions.filter((tx) => asDate(tx.date).getTime() < firstOfThisMonth);

  const options = currency === undefined ? undefined : { currency };
  const currentCents = deriveCashBalanceCents(transactions, categories, options);
  const baselineCents = deriveCashBalanceCents(priorMonths, categories, options);
  const growthAmountCents = sumCents([currentCents, negateCents(baselineCents)]);

  return {
    growthAmountCents,
    growthPercent:
      baselineCents === 0 ? null : (growthAmountCents / Math.abs(baselineCents)) * 100,
    baselineCents,
  };
}

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

export function localDayFromKey(key: DateKey): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}
