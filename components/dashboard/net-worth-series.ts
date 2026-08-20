
import { normalizeCurrency } from "@/components/assets/currency-totals";
import { fromDateKey, isDateKey, startOfMonth, toDateKey, type DateKey } from "@/lib/dates";
import { centsToDecimal, formatMoney, negateCents, sumCents, type Cents } from "@/lib/money";

export type NetWorthSnapshotRow = {

  date: string;

  currency?: string | null;
  totalAssetsCents: Cents;

  totalLiabilitiesCents: Cents;

  netWorthCents: Cents;
};

export type NetWorthPoint = {
  dateKey: DateKey;
  currency: string;

  label: string;
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;

  netWorth: number;
  assets: number;
  liabilities: number;
};

export type NetWorthSeriesStatus =

  | "empty"

  | "single"

  | "ready"

  | "mixed";

export type NetWorthSeries = {
  status: NetWorthSeriesStatus;

  points: NetWorthPoint[];

  message: string | null;

  droppedCount: number;
  first: NetWorthPoint | null;
  latest: NetWorthPoint | null;

  spanChangeCents: Cents | null;
  currency: string | null;
  currencies: string[];
};

export function formatSnapshotLabel(key: string, options?: { withYear?: boolean }): string {
  if (!isDateKey(key)) return key;
  return fromDateKey(key).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(options?.withYear ? { year: "numeric" } : {}),
  });
}

export function buildNetWorthSeries(
  rows: readonly NetWorthSnapshotRow[],
  currency?: string,
): NetWorthSeries {
  const requested = currency === undefined ? null : normalizeCurrency(currency);
  const inCurrency =
    requested === null
      ? rows
      : rows.filter((row) => normalizeCurrency(row.currency) === requested);
  const usable = inCurrency.filter((row) => isDateKey(row.date));
  const droppedCount = inCurrency.length - usable.length;

  const currencies = [
    ...new Set(usable.map((row) => normalizeCurrency(row.currency))),
  ].sort();
  if (currencies.length > 1) {
    return {
      status: "mixed",
      points: [],
      message:
        `History contains ${currencies.join(", ")}. Choose one currency; ` +
        "LocalFi never plots them on one numeric axis.",
      droppedCount,
      first: null,
      latest: null,
      spanChangeCents: null,
      currency: null,
      currencies,
    };
  }

  const sorted = [...usable].sort((a, b) => a.date.localeCompare(b.date));



  const years = new Set(sorted.map((row) => row.date.slice(0, 4)));
  const withYear = years.size > 1;

  const points: NetWorthPoint[] = sorted.map((row) => ({
    dateKey: row.date,
    currency: normalizeCurrency(row.currency),
    label: formatSnapshotLabel(row.date, { withYear }),
    totalAssetsCents: row.totalAssetsCents,
    totalLiabilitiesCents: row.totalLiabilitiesCents,
    netWorthCents: row.netWorthCents,
    netWorth: centsToDecimal(row.netWorthCents),
    assets: centsToDecimal(row.totalAssetsCents),
    liabilities: centsToDecimal(row.totalLiabilitiesCents),
  }));

  const first = points[0] ?? null;
  const latest = points[points.length - 1] ?? null;

  const status: NetWorthSeriesStatus =
    points.length === 0 ? "empty" : points.length === 1 ? "single" : "ready";

  const message =
    status === "empty"
      ? "No net-worth history yet: record a snapshot to start tracking."
      : status === "single"
        ? `Only ${formatSnapshotLabel(first!.dateKey, { withYear: true })} is recorded. ` +
          "Record another day to see how your net worth moves."
        : null;

  return {
    status,
    points,
    message,
    droppedCount,
    first,
    latest,
    spanChangeCents:
      points.length >= 2 && first && latest
        ? sumCents([latest.netWorthCents, negateCents(first.netWorthCents)])
        : null,
    currency: currencies[0] ?? requested ?? "USD",
    currencies,
  };
}

export type NetWorthChange = {

  baselineCents: Cents;

  baselineDateKey: DateKey;

  changeCents: Cents;

  changePercent: number | null;
};


export function netWorthChangeVsLastMonth(
  rows: readonly NetWorthSnapshotRow[],
  currentCents: Cents,
  now: Date = new Date(),
  currency?: string,
): NetWorthChange | null {
  const firstOfThisMonth = toDateKey(startOfMonth(now));
  const requested = currency === undefined ? null : normalizeCurrency(currency);
  const earlier = rows
    .filter(
      (row) =>
        isDateKey(row.date) &&
        row.date < firstOfThisMonth &&
        (requested === null || normalizeCurrency(row.currency) === requested),
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  const baseline = earlier[earlier.length - 1];
  if (!baseline) return null;

  const changeCents = sumCents([currentCents, negateCents(baseline.netWorthCents)]);
  return {
    baselineCents: baseline.netWorthCents,
    baselineDateKey: baseline.date,
    changeCents,
    changePercent:
      baseline.netWorthCents === 0
        ? null
        : (changeCents / Math.abs(baseline.netWorthCents)) * 100,
  };
}


export function describeSnapshotDrift(
  liveNetWorthCents: Cents,
  latest: NetWorthPoint | null,
  currency = "USD",
): string | null {
  if (!latest) return null;
  if (latest.netWorthCents === liveNetWorthCents) return null;
  const code = normalizeCurrency(currency);
  return (
    `Last recorded ${formatMoney(latest.netWorthCents, code)} on ${latest.label}; ` +
    `live figure is ${formatMoney(liveNetWorthCents, code)}. Record today to add it to the chart.`
  );
}


export function netWorthDomain(points: readonly NetWorthPoint[]): [number, number] {
  if (points.length === 0) return [0, 100];

  const values = points.map((point) => point.netWorth);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min < 0) max = Math.max(max, 0);
  if (max > 0) min = Math.min(min, 0);

  const span = max - min;
  const pad = span === 0 ? Math.max(Math.abs(max) * 0.1, 1) : span * 0.1;
  return [min - pad, max + pad];
}


export type LiabilityRow = {
  id: number;
  name: string;
  kind: string;
  owedCents: Cents;
};


export function liabilitiesForDisplay<T extends LiabilityRow>(
  accounts: readonly T[],
): T[] {
  return accounts
    .filter((account) => account.kind === "liability")
    .sort((a, b) => b.owedCents - a.owedCents || a.name.localeCompare(b.name, "en") || a.id - b.id);
}


export function netWorthCurrencies(
  rows: readonly { currency?: string | null }[],
): { currency: string; mixed: boolean; currencies: string[] } {
  const codes = [...new Set(rows.map((row) => normalizeCurrency(row.currency)))].sort();
  if (codes.length === 0) return { currency: "USD", mixed: false, currencies: [] };
  return {
    currency: codes.length === 1 ? codes[0] : "USD",
    mixed: codes.length > 1,
    currencies: codes,
  };
}
