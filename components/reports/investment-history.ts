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

/** A plotted line the legend can show, hide, or isolate. */
export type InvestmentLine = Pick<InvestmentSeries, "key" | "label" | "color" | "currency">;

export const TOTAL_KEY = "total";

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

// Stock holdings are labelled by ticker; these keep their brand color.
const BRAND_COLORS: Readonly<Record<string, string>> = { NVDA: "#76B900" };

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
    color: BRAND_COLORS[item.label.toUpperCase()] ?? COLORS[index % COLORS.length],
  }));

  const currencies = [...new Set(series.map((item) => item.currency))].sort();
  // Values in different currencies cannot be added without exchange rates.
  const total: InvestmentLine | null = series.length > 0 && currencies.length === 1
    ? { key: TOTAL_KEY, label: "Total portfolio", color: "hsl(var(--foreground))", currency: currencies[0] }
    : null;

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
    const values: Cents[] = [];
    for (const row of latest.values()) {
      if (row.closed && closedOn.get(row.assetId) !== day) continue;
      point[`holding_${row.assetId}`] = centsToDecimal(row.valueCents);
      values.push(row.valueCents);
      if (row.costBasisCents != null) point[`cost_${row.assetId}`] = centsToDecimal(row.costBasisCents);
    }
    if (total) point[TOTAL_KEY] = centsToDecimal(sumCents(values));
    points.push(point);
  }
  const summaries = series.map((item) => summarize(item, latest.get(item.assetId)!));

  return {
    points,
    series,
    total,
    summaries,
    currencies,
    mixedCurrency: currencies.length > 1,
    droppedCount,
  };
}

/** Shows only `key`; isolating the line that is already alone shows every line again. */
export function isolateLine(
  keys: readonly string[],
  hidden: ReadonlySet<string>,
  key: string,
): Set<string> {
  const alone = !hidden.has(key) && keys.every((candidate) => candidate === key || hidden.has(candidate));
  return alone ? new Set() : new Set(keys.filter((candidate) => candidate !== key));
}

export type InvestmentTotals = {
  currency: string;
  valueCents: Cents;
  costBasisCents: Cents | null;
  unrealizedGainCents: Cents | null;
  realizedGainCents: Cents | null;
  totalReturnCents: Cents | null;
};

function allKnown(values: ReadonlyArray<Cents | null>): Cents[] | null {
  return values.every((value) => value !== null) ? (values as Cents[]) : null;
}

/**
 * Portfolio totals for the summary table; null across currencies. A total that
 * depends on an unknown cost stays unknown instead of silently skipping it.
 */
export function summarizeTotals(summaries: readonly InvestmentSummary[]): InvestmentTotals | null {
  const currencies = [...new Set(summaries.map((item) => item.currency))];
  if (currencies.length !== 1) return null;
  const open = summaries.filter((item) => !item.closed);
  const valueCents = sumCents(open.map((item) => item.valueCents));
  const costs = allKnown(open.map((item) => item.costBasisCents));
  const costBasisCents = costs === null ? null : sumCents(costs);
  const unrealizedGainCents = costBasisCents === null ? null : sumCents([valueCents, negateCents(costBasisCents)]);
  const realized = allKnown(summaries.map((item) => item.realizedGainCents));
  const realizedGainCents = realized === null ? null : sumCents(realized);
  return {
    currency: currencies[0],
    valueCents,
    costBasisCents,
    unrealizedGainCents,
    realizedGainCents,
    totalReturnCents: unrealizedGainCents === null || realizedGainCents === null
      ? null
      : sumCents([unrealizedGainCents, realizedGainCents]),
  };
}
