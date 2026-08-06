import { centsToDecimal, type Cents } from "@/lib/money";
import { fromDateKey, isDateKey, type DateKey } from "@/lib/dates";

export type InvestmentHistoryInput = {
  assetId: number;
  dateKey: string;
  valueCents: Cents;
  category: string;
  currency: string;
  label: string;
};

export type InvestmentSeries = {
  assetId: number;
  key: string;
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

export function buildInvestmentHistory(
  rows: readonly InvestmentHistoryInput[],
  range?: { startKey: DateKey; endKey: DateKey },
) {
  const usable = rows.filter(
    (row) =>
      isDateKey(row.dateKey) &&
      (!range || (row.dateKey >= range.startKey && row.dateKey <= range.endKey)),
  );
  const droppedCount = rows.length - rows.filter((row) => isDateKey(row.dateKey)).length;

  const metadata = new Map<number, Omit<InvestmentSeries, "key" | "color">>();
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
    label: labelCounts.get(item.label)! > 1 ? `${item.label} (#${item.assetId})` : item.label,
    color: COLORS[index % COLORS.length],
  }));

  const byDate = new Map<DateKey, InvestmentPoint>();
  const years = new Set(usable.map((row) => row.dateKey.slice(0, 4)));
  for (const row of usable) {
    const dateKey = row.dateKey as DateKey;
    const point = byDate.get(dateKey) ?? {
      dateKey,
      label: dateLabel(dateKey, years.size > 1),
    };
    point[`holding_${row.assetId}`] = centsToDecimal(row.valueCents);
    byDate.set(dateKey, point);
  }

  const points = [...byDate.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const currencies = [...new Set(series.map((item) => item.currency))].sort();

  return {
    points,
    series,
    currencies,
    mixedCurrency: currencies.length > 1,
    droppedCount,
  };
}
