/**
 * Pure logic behind the Reports UI.
 *
 * WHY THIS FILE EXISTS: there is no jsdom in this repo, so anything on the reports
 * page that can be *arithmetically* wrong is kept out of the JSX and unit-tested
 * here — which range a preset means, which period a range should be summarised by,
 * how a comparison baseline is chosen, and the one conversion from integer cents to
 * chart floats.
 *
 * It composes `lib/reports.ts` and `lib/budgets.ts` rather than re-deriving
 * anything, and every calendar day is a 'YYYY-MM-DD' key built from LOCAL
 * components. No `toISOString()` goes anywhere near a date here.
 *
 * It deliberately does NOT import `app/actions/export.ts` (or any `"use server"`
 * file): that would drag `next/cache` into the unit tests.
 */
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

// ---------------------------------------------------------------------------
// Date-range presets
// ---------------------------------------------------------------------------

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

/** The calendar month `offset` months away from `key`'s month, as a period range. */
function monthRange(key: DateKey, offset: number): PeriodRange {
  const d = fromDateKey(key);
  // Day 1 of the shifted month: `new Date(y, m + offset, 1)` cannot roll over,
  // because the day is 1. Never do this with the original day-of-month.
  const shifted = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  return periodContaining("monthly", toDateKey(shifted));
}

/** Bounds of the data itself, for the "All time" preset. */
export type LedgerBounds = { earliestKey?: DateKey | null; latestKey?: DateKey | null };

/**
 * The inclusive range a preset means, as of `today`. `null` for "custom", which by
 * definition is whatever the user typed.
 *
 * "Last 3 / 12 months" mean whole CALENDAR months ending with the current one, not
 * a rolling 90/365 days: the cash-flow chart buckets by month, so a range that
 * starts mid-month would render a stub first bar that reads like a collapse in
 * spending.
 */
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
      // A future-dated transaction is real data; the range must reach it.
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

/**
 * Which period length to bucket a range by, so a chart neither shows one bar nor
 * four hundred. Purely presentational; the user can override it.
 */
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

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** A period key ('2026-03', '2026-01-12', '2026') as a short human label. */
export function periodLabel(key: string, period: ReportPeriod): string {
  if (period === "yearly") return key;
  if (period === "monthly") {
    const [year, month] = key.split("-");
    return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
    });
  }
  // Weekly keys are the Monday, as a DateKey.
  return isDateKey(key)
    ? fromDateKey(key).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : key;
}

/** An inclusive range in the user's locale, never through UTC. */
export function formatRangeLabel(range: KeyRange): string {
  const start = fromDateKey(assertKey(range.startKey, "start date key"));
  const end = fromDateKey(assertKey(range.endKey, "end date key"));
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  return `${start.toLocaleDateString("en-US", options)} - ${end.toLocaleDateString("en-US", options)}`;
}

/**
 * What the reports left out, said plainly.
 *
 * Pending rows and transfers are excluded from every figure on the page — the same
 * rule the balance uses. Saying so is the difference between a report the user can
 * reconcile and one they merely hope is right.
 */
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

/** The mixed-currency caveat, or null when the range sits in one currency. */
export function describeCurrencyCaveat(scope: ReportCurrencyScope): string | null {
  if (!scope.mixed) return null;
  return (
    `These transactions span ${scope.currencies.join(", ")}. There are no exchange rates in ` +
    `this app, so nothing is converted: figures are shown for ONE currency at a time.`
  );
}

/** The unassigned-account note, or null. */
export function describeUnassigned(scope: ReportCurrencyScope): string | null {
  if (scope.unassignedCount <= 0) return null;
  const n = scope.unassignedCount;
  return (
    `${n} transaction${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} not assigned to an account, ` +
    `so ${n === 1 ? "it has" : "they have"} no currency of ${n === 1 ? "its" : "their"} own. ` +
    `${n === 1 ? "It is" : "They are"} counted under ${scope.primary}.`
  );
}

// ---------------------------------------------------------------------------
// Comparison baseline
// ---------------------------------------------------------------------------

export const COMPARISON_MODES = ["previous-period", "year-over-year"] as const;
export type ComparisonMode = (typeof COMPARISON_MODES)[number];

export const COMPARISON_MODE_LABELS: Record<ComparisonMode, string> = {
  "previous-period": "vs. previous period",
  "year-over-year": "vs. same period last year",
};

/**
 * The baseline range for a comparison.
 *
 * "Previous period" uses the period machinery (so the month before January is
 * December of the previous year, and the week before is Monday..Sunday), which is
 * only meaningful when the selected range IS a whole period. When it is an
 * arbitrary custom range, the baseline is the equally-long window immediately
 * before it — because "the previous 17 days" is at least a comparable quantity.
 */
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

  // Arbitrary range: shift it back by its own length, in whole days.
  const start = fromDateKey(range.startKey);
  const end = fromDateKey(range.endKey);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const newEnd = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
  const newStart = new Date(newEnd.getFullYear(), newEnd.getMonth(), newEnd.getDate() - (days - 1));
  return { startKey: toDateKey(newStart), endKey: toDateKey(newEnd) };
}

// ---------------------------------------------------------------------------
// Chart boundary — the ONLY place cents become floats
// ---------------------------------------------------------------------------

export type CashFlowChartRow = {
  label: string;
  periodKey: string;
  /** Decimals, for recharts. Never used for arithmetic. */
  income: number;
  expense: number;
  net: number;
  /** Kept in cents for the tooltip, which formats with `formatMoney`. */
  incomeCents: Cents;
  expenseCents: Cents;
  netCents: Cents;
  savingsRate: number | null;
};

/**
 * Cash-flow rows as chart rows. `centsToDecimal` is called here and nowhere else
 * on this page: recharts needs plain numbers for its axes, and the tooltip reads
 * the cents fields so what the user sees is still exact.
 */
export function toCashFlowChartRows(
  flows: readonly CashFlowRow[],
  period: ReportPeriod,
): CashFlowChartRow[] {
  return flows.map((flow) => ({
    label: periodLabel(flow.key, period),
    periodKey: flow.key,
    income: centsToDecimal(flow.incomeCents),
    // Money out is plotted DOWNWARDS, so income and expense read as a flow rather
    // than as two positive bars that look like they add up to something.
    expense: -centsToDecimal(flow.expenseCents),
    net: centsToDecimal(flow.netCents),
    incomeCents: flow.incomeCents,
    expenseCents: flow.expenseCents,
    netCents: flow.netCents,
    savingsRate: flow.savingsRate,
  }));
}

/**
 * Whether a change is good news, for colouring. More income is good; more spending
 * is not; a bigger surplus is good. Returns "neutral" for no change at all, so a
 * flat month is not painted green.
 */
export function deltaTone(
  metric: "income" | "expense" | "net",
  absoluteCents: Cents,
): "good" | "bad" | "neutral" {
  if (absoluteCents === 0) return "neutral";
  const up = absoluteCents > 0;
  if (metric === "expense") return up ? "bad" : "good";
  return up ? "good" : "bad";
}

/** A signed money delta with an explicit sign, e.g. "+$120.00" / "-$45.50". */
export function formatDelta(absoluteCents: Cents, currency = "USD"): string {
  const body = formatMoney(Math.abs(absoluteCents), currency);
  if (absoluteCents === 0) return body;
  return `${absoluteCents > 0 ? "+" : "-"}${body}`;
}
