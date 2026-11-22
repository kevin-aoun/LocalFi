import { centsToDecimal, negateCents, sumCents, type Cents } from "@/lib/money";
import { fromDateKey, isDateKey, type DateKey } from "@/lib/dates";

export type InvestmentHistoryInput = {
  assetId: number;
  dateKey: string;
  valueCents: Cents;
  /** Average cost of the units still held; null when an opening has no cash cost. */
  costBasisCents?: Cents | null;
  realizedGainCents?: Cents | null;
  /** Every unit has been sold. */
  closed?: boolean;
  category: string;
  currency: string;
  label: string;
};

export type InvestmentSeries = {
  assetId: number;
  key: string;
  costKey: string;
  label: string;
  category: string;
  currency: string;
  color: string;
};

export type InvestmentPoint = {
  dateKey: DateKey;
  label: string;
  [seriesKey: string]: string | number;
};

export type InvestmentSummary = InvestmentSeries & {
  valueCents: Cents;
  costBasisCents: Cents | null;
  /** Value minus the cost of the units still held. */
  unrealizedGainCents: Cents | null;
  realizedGainCents: Cents | null;
  /** Unrealized plus realized gain. */
  totalReturnCents: Cents | null;
  closed: boolean;
  asOfKey: string;
};

const COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--chart-6))",
  "hsl(var(--chart-7))",
  "hsl(var(--chart-8))",
] as const;

function dateLabel(key: DateKey, withYear: boolean) {
  return fromDateKey(key).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

function summarize(series: InvestmentSeries, row: InvestmentHistoryInput): InvestmentSummary {
  const costBasisCents = row.costBasisCents ?? null;
  const realizedGainCents = row.realizedGainCents ?? null;
  const unrealizedGainCents = costBasisCents === null
    ? null
    : sumCents([row.valueCents, negateCents(costBasisCents)]);
  return {
    ...series,
    valueCents: row.valueCents,
    costBasisCents,
    unrealizedGainCents,
    realizedGainCents,
    totalReturnCents: unrealizedGainCents === null || realizedGainCents === null
      ? null
      : sumCents([unrealizedGainCents, realizedGainCents]),
    closed: row.closed === true,
    asOfKey: row.dateKey,
  };
}

/**
 * Pivots per-holding daily rows into chart points. Each holding plots its
 * market value against the average cost of the units it still holds, so the
 * gap is the unrealized gain; realized gains are reported in the summaries.
 * A sold-out holding draws its drop to zero once, then its lines end.
 */
export function buildInvestmentHistory(
  rows: readonly InvestmentHistoryInput[],
  range?: { startKey: DateKey; endKey: DateKey },
) {
  const usable = rows.filter(
    (row) =>
      isDateKey(row.dateKey) &&
      (!range || row.dateKey <= range.endKey),
  );
  const droppedCount = rows.length - rows.filter((row) => isDateKey(row.dateKey)).length;

  const metadata = new Map<number, Omit<InvestmentSeries, "key" | "costKey" | "color">>();
  for (const row of usable) {
    if (!metadata.has(row.assetId)) {
      metadata.set(row.assetId, {
        assetId: row.assetId,
        label: row.label.trim() || `${row.category} #${row.assetId}`,
        category: row.category,
        currency: row.currency.trim().toUpperCase() || "USD",
      });
    }
  }

  const labelCounts = new Map<string, number>();
  for (const item of metadata.values()) {
    labelCounts.set(item.label, (labelCounts.get(item.label) ?? 0) + 1);
  }
  const series: InvestmentSeries[] = [...metadata.values()].map((item, index) => ({
    ...item,
    key: `holding_${item.assetId}`,
    costKey: `cost_${item.assetId}`,
    label: labelCounts.get(item.label)! > 1 ? `${item.label} (#${item.assetId})` : item.label,
    color: COLORS[index % COLORS.length],
  }));

  const byDate = new Map<string, InvestmentHistoryInput[]>();
  for (const row of usable) {
    const bucket = byDate.get(row.dateKey) ?? [];
    bucket.push(row);
    byDate.set(row.dateKey, bucket);
  }
  const days = [...new Set([...byDate.keys(), ...(range ? [range.startKey, range.endKey] : [])])].sort();
  const years = new Set(days.map((day) => day.slice(0, 4)));
  const latest = new Map<number, InvestmentHistoryInput>();
  const closedOn = new Map<number, string>();
  const points: InvestmentPoint[] = [];
  for (const day of days) {
    for (const row of byDate.get(day) ?? []) {
      if (!row.closed) closedOn.delete(row.assetId);
      else if (!closedOn.has(row.assetId)) closedOn.set(row.assetId, day);
      latest.set(row.assetId, row);
    }
    if ((range && day < range.startKey) || latest.size === 0) continue;
    const point: InvestmentPoint = { dateKey: day as DateKey, label: dateLabel(day as DateKey, years.size > 1) };
    for (const row of latest.values()) {
      if (row.closed && closedOn.get(row.assetId) !== day) continue;
      point[`holding_${row.assetId}`] = centsToDecimal(row.valueCents);
      if (row.costBasisCents != null) point[`cost_${row.assetId}`] = centsToDecimal(row.costBasisCents);
    }
    points.push(point);
  }
  const summaries = series.map((item) => summarize(item, latest.get(item.assetId)!));
  const currencies = [...new Set(series.map((item) => item.currency))].sort();

  return {
    points,
    series,
    summaries,
    currencies,
    mixedCurrency: currencies.length > 1,
    droppedCount,
  };
}
