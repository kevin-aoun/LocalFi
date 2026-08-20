
import { periodContaining, type PeriodRange } from "@/lib/budgets";
import { fromDateKey, isDateKey, toDateKey, type DateKey } from "@/lib/dates";
import { centsToDecimal, formatMoney, type Cents } from "@/lib/money";
import {
  previousPeriodRange,
  sameRangeLastYear,
  type CashFlowRow,
  type FlowTotals,
  type KeyRange,
  type ReportCurrencyScope,
  type ReportPeriod,
} from "@/lib/reports";

export const RANGE_PRESETS = [
  "this-month",
  "last-month",
  "last-3-months",
  "year-to-date",
  "last-12-months",
  "last-year",
  "all-time",
  "custom",
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  "this-month": "This month",
  "last-month": "Last month",
  "last-3-months": "Last 3 months",
  "year-to-date": "Year to date",
  "last-12-months": "Last 12 months",
  "last-year": "Last year",
  "all-time": "All time",
  custom: "Custom range",
};

function assertKey(key: DateKey, label: string): DateKey {
  if (!isDateKey(key)) {
    throw new Error(`Invalid ${label}: expected 'YYYY-MM-DD', received ${JSON.stringify(key)}`);
  }
  return key;
}


function monthRange(key: DateKey, offset: number): PeriodRange {
  const d = fromDateKey(key);


  const shifted = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  return periodContaining("monthly", toDateKey(shifted));
}


export type LedgerBounds = { earliestKey?: DateKey | null; latestKey?: DateKey | null };


export function rangeForPreset(
  preset: RangePreset,
  today: DateKey,
  bounds?: LedgerBounds,
): KeyRange | null {
  assertKey(today, "today");
  const year = Number(today.slice(0, 4));

  switch (preset) {
    case "this-month": {
      const month = monthRange(today, 0);
      return { startKey: month.startKey, endKey: month.endKey };
    }
    case "last-month": {
      const month = monthRange(today, -1);
      return { startKey: month.startKey, endKey: month.endKey };
    }
    case "last-3-months":
      return { startKey: monthRange(today, -2).startKey, endKey: monthRange(today, 0).endKey };
    case "last-12-months":
      return { startKey: monthRange(today, -11).startKey, endKey: monthRange(today, 0).endKey };
    case "year-to-date":
      return { startKey: `${year}-01-01`, endKey: today };
    case "last-year":
      return { startKey: `${year - 1}-01-01`, endKey: `${year - 1}-12-31` };
    case "all-time": {
      const earliest =
        bounds?.earliestKey && isDateKey(bounds.earliestKey)
          ? bounds.earliestKey
          : monthRange(today, 0).startKey;

      const latest =
        bounds?.latestKey && isDateKey(bounds.latestKey) && bounds.latestKey > today
          ? bounds.latestKey
          : today;
      return { startKey: earliest, endKey: latest };
    }
    case "custom":
      return null;
  }
}


export function suggestPeriod(range: KeyRange): ReportPeriod {
  assertKey(range.startKey, "start date key");
  assertKey(range.endKey, "end date key");
  const start = fromDateKey(range.startKey);
  const end = fromDateKey(range.endKey);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days <= 70) return "weekly";
  if (days <= 900) return "monthly";
  return "yearly";
}






export function periodLabel(key: string, period: ReportPeriod): string {
  if (period === "yearly") return key;
  if (period === "monthly") {
    const [year, month] = key.split("-");
    return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
    });
  }

  return isDateKey(key)
    ? fromDateKey(key).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : key;
}


export function formatRangeLabel(range: KeyRange): string {
  const start = fromDateKey(assertKey(range.startKey, "start date key"));
  const end = fromDateKey(assertKey(range.endKey, "end date key"));
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  return `${start.toLocaleDateString("en-US", options)} - ${end.toLocaleDateString("en-US", options)}`;
}


export function describeExclusions(totals: FlowTotals): string[] {
  const notes: string[] = [];
  if (totals.pendingCount > 0) {
    const money = [
      totals.pendingIncomeCents > 0 ? `${formatMoney(totals.pendingIncomeCents)} in` : null,
      totals.pendingExpenseCents > 0 ? `${formatMoney(totals.pendingExpenseCents)} out` : null,
    ].filter((part): part is string => part !== null);
    notes.push(
      `${totals.pendingCount} pending transaction${totals.pendingCount === 1 ? "" : "s"} excluded` +
        (money.length > 0 ? ` (${money.join(", ")} once cleared)` : "") +
        ": the same rule the balance uses.",
    );
  }
  if (totals.transferCount > 0) {
    notes.push(
      `${totals.transferCount} transfer${totals.transferCount === 1 ? "" : "s"} excluded: ` +
        "moving money between your own accounts is neither income nor an expense.",
    );
  }
  if (totals.uncategorizedCount > 0) {
    notes.push(
      `${totals.uncategorizedCount} transaction${totals.uncategorizedCount === 1 ? "" : "s"} ` +
        "have no category, so they count towards nothing. Give them a category to include them.",
    );
  }
  return notes;
}


export function describeCurrencyCaveat(scope: ReportCurrencyScope): string | null {
  if (!scope.mixed) return null;
  return (
    `These transactions span ${scope.currencies.join(", ")}. There are no exchange rates in ` +
    `this app, so nothing is converted: figures are shown for ONE currency at a time.`
  );
}


export function describeUnassigned(scope: ReportCurrencyScope): string | null {
  if (scope.unassignedCount <= 0) return null;
  const n = scope.unassignedCount;
  return (
    `${n} transaction${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} not assigned to an account, ` +
    `so ${n === 1 ? "it has" : "they have"} no currency of ${n === 1 ? "its" : "their"} own. ` +
    `${n === 1 ? "It is" : "They are"} counted under ${scope.primary}.`
  );
}





export const COMPARISON_MODES = ["previous-period", "year-over-year"] as const;
export type ComparisonMode = (typeof COMPARISON_MODES)[number];

export const COMPARISON_MODE_LABELS: Record<ComparisonMode, string> = {
  "previous-period": "vs. previous period",
  "year-over-year": "vs. same period last year",
};


export function comparisonRange(
  mode: ComparisonMode,
  range: KeyRange,
  period: ReportPeriod,
): KeyRange {
  assertKey(range.startKey, "start date key");
  assertKey(range.endKey, "end date key");

  if (mode === "year-over-year") return sameRangeLastYear(range);

  const whole = periodContaining(period, range.startKey);
  if (whole.startKey === range.startKey && whole.endKey === range.endKey) {
    const previous = previousPeriodRange(period, range);
    return { startKey: previous.startKey, endKey: previous.endKey };
  }


  const start = fromDateKey(range.startKey);
  const end = fromDateKey(range.endKey);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const newEnd = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
  const newStart = new Date(newEnd.getFullYear(), newEnd.getMonth(), newEnd.getDate() - (days - 1));
  return { startKey: toDateKey(newStart), endKey: toDateKey(newEnd) };
}





export type CashFlowChartRow = {
  label: string;
  periodKey: string;

  income: number;
  expense: number;
  net: number;

  incomeCents: Cents;
  expenseCents: Cents;
  netCents: Cents;
  savingsRate: number | null;
};


export function toCashFlowChartRows(
  flows: readonly CashFlowRow[],
  period: ReportPeriod,
): CashFlowChartRow[] {
  return flows.map((flow) => ({
    label: periodLabel(flow.key, period),
    periodKey: flow.key,
    income: centsToDecimal(flow.incomeCents),


    expense: -centsToDecimal(flow.expenseCents),
    net: centsToDecimal(flow.netCents),
    incomeCents: flow.incomeCents,
    expenseCents: flow.expenseCents,
    netCents: flow.netCents,
    savingsRate: flow.savingsRate,
  }));
}


export function deltaTone(
  metric: "income" | "expense" | "net",
  absoluteCents: Cents,
): "good" | "bad" | "neutral" {
  if (absoluteCents === 0) return "neutral";
  const up = absoluteCents > 0;
  if (metric === "expense") return up ? "bad" : "good";
  return up ? "good" : "bad";
}


export function formatDelta(absoluteCents: Cents, currency = "USD"): string {
  const body = formatMoney(Math.abs(absoluteCents), currency);
  if (absoluteCents === 0) return body;
  return `${absoluteCents > 0 ? "+" : "-"}${body}`;
}
