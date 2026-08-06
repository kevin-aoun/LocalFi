/**
 * Pure logic behind the Budgets UI.
 *
 * WHY THIS FILE EXISTS: there is no jsdom in this repo, so anything in the
 * budgets page that can be *arithmetically* wrong is kept out of the JSX and
 * unit-tested here: form -> FormData transport, period selection, rollover
 * presentation, over/under classification, sorting and the history grouping.
 *
 * It deliberately re-uses `lib/budgets.ts` (period maths, carry-over) and
 * `lib/dates.ts` (calendar days) rather than re-deriving either. The numbers on
 * screen come from `getSpendVsBudget` / `getBudgetHistory`; this module only
 * decides how to *present* them.
 *
 * Conventions honoured here:
 *   - money is integer cents everywhere; only `formatMoney` / `centsToDecimal`
 *     ever produce a decimal;
 *   - a limit of 0 is a REAL ceiling, never "no limit" (a budgets row cannot have
 *     a null limit at all, so a blank field is a validation error, not a NULL);
 *   - calendar days are 'YYYY-MM-DD' keys built from LOCAL components — no
 *     `toISOString()` anywhere near a date.
 */
import {
  budgetPeriods,
  periodContaining,
  type BudgetPeriod,
  type BudgetPeriodResult,
  type PeriodRange,
} from "@/lib/budgets";
import { fromDateKey, isDateKey, toDateKey, type DateKey } from "@/lib/dates";
import { centsToDecimal, formatMoney, sumCents, tryParseAmount, type Cents } from "@/lib/money";

/** Usage at or above this percentage of the available amount is "near limit". */
export const NEAR_LIMIT_PERCENT = 80;

/**
 * A performance row plus the category's display fields — structurally the same
 * as `BudgetPerformanceRow` from `app/actions/budgets`, restated here so this
 * module never imports a `"use server"` file (which would drag `next/cache` into
 * the unit tests).
 */
export type BudgetRowView = BudgetPeriodResult & {
  categoryName: string;
  categoryType: string;
  categoryColor: string;
  categoryIcon: string;
  /** True when the row came from the legacy `categories.monthly_limit_cents`. */
  legacy: boolean;
  /** Original storage window, when supplied by the server. */
  effectiveFrom?: DateKey;
  effectiveTo?: DateKey | null;
};

/** Minimal category shape the budgets page needs. */
export type CategoryOption = { id: number; name: string; type: string };

export type PeriodFilter = BudgetPeriod | "all";

export const periodFilters: readonly PeriodFilter[] = ["all", ...budgetPeriods];

/**
 * Where a row stands.
 *   - Expense/Investment: `over` (spent more than available) > `near` > `on-track`
 *   - Income: `ignored`. AN INCOME CATEGORY CANNOT HAVE A BUDGET — a budget is a
 *     spending limit, and a paycheque is not spending. `createBudget` /
 *     `updateBudget` refuse one and the UI never offers one, so this status only
 *     ever appears for a row that predates the rule or was written straight into
 *     the database. Such a row is shown as ignored and kept out of every total,
 *     rather than being folded into the over-budget count as if the money had
 *     been spent.
 */
export type BudgetStatus = "over" | "near" | "on-track" | "ignored";

/**
 * The one refusal message, shared by the form and the server action so a caller
 * reaching the action directly (the agent, the CLI) reads the same sentence.
 */
export const INCOME_BUDGET_REFUSAL =
  "Income categories can't have a budget: a budget is a spending limit.";

export function incomeBudgetRefusal(categoryName?: string): string {
  return categoryName
    ? `${categoryName} is an Income category. ${INCOME_BUDGET_REFUSAL}`
    : INCOME_BUDGET_REFUSAL;
}

/** True when a category cannot hold a budget at all. */
export function isIncomeCategory(category: Pick<CategoryOption, "type">): boolean {
  return category.type === "Income";
}

/** The categories a budget may be created for — everything except Income. */
export function budgetableCategories<T extends { type: string }>(
  categories: readonly T[],
): T[] {
  return categories.filter((category) => !isIncomeCategory(category));
}

/** True when a row somehow sits on an Income category, so it must be ignored. */
export function isIgnoredRow(row: Pick<BudgetRowView, "categoryType">): boolean {
  return row.categoryType === "Income";
}

// ---------------------------------------------------------------------------
// Progress and classification
// ---------------------------------------------------------------------------

/**
 * Spend as a percentage of what was available. NOT clamped — the caller clamps
 * for the progress bar and shows the true figure in text.
 *
 * `availableCents === 0` is a real ceiling of zero: any spend at all is 100%
 * used. The old card divided by the limit directly and produced Infinity/NaN.
 */
export function usagePercent(spentCents: Cents, availableCents: Cents): number {
  if (availableCents <= 0) return spentCents > 0 ? 100 : 0;
  // A ratio, not money: float division is correct here.
  return (spentCents / availableCents) * 100;
}

/**
 * Card-only usage after budget has been moved out of this category.
 *
 * A reallocation is not a transaction, so it must not inflate actual spending.
 * It does commit part of the category's original capacity elsewhere, though, and
 * the progress bar should fill accordingly. Adding the outgoing amount back to
 * the adjusted availability reconstructs the capacity that could have been used
 * here; adding it to spend shows how much of that capacity is now committed.
 */
export function visualBudgetUsage(
  spentCents: Cents,
  adjustedAvailableCents: Cents,
  outgoingCents: Cents,
): { usedCents: Cents; capacityCents: Cents; percent: number } {
  const usedCents = sumCents([spentCents, outgoingCents]);
  const capacityCents = sumCents([adjustedAvailableCents, outgoingCents]);
  return {
    usedCents,
    capacityCents,
    percent: usagePercent(usedCents, capacityCents),
  };
}

export function classifyBudgetRow(
  row: Pick<BudgetRowView, "categoryType" | "spentCents" | "availableCents" | "remainingCents">,
): BudgetStatus {
  // Defensive: an Income row cannot be created any more, but one that already
  // exists must not be read as an overspend.
  if (isIgnoredRow(row)) return "ignored";
  if (row.remainingCents < 0) return "over";
  return usagePercent(row.spentCents, row.availableCents) >= NEAR_LIMIT_PERCENT
    ? "near"
    : "on-track";
}

/**
 * Over budget in the sense the summary counts: a ceiling that has been breached.
 * An ignored income row is never over budget.
 */
export function isOverBudget(
  row: Pick<BudgetRowView, "categoryType" | "spentCents" | "availableCents" | "remainingCents">,
): boolean {
  return classifyBudgetRow(row) === "over";
}

export function isNearLimit(
  row: Pick<BudgetRowView, "categoryType" | "spentCents" | "availableCents" | "remainingCents">,
): boolean {
  return classifyBudgetRow(row) === "near";
}

export type BudgetSummary = {
  /** Budget rows counted — an ignored income row is NOT one of them. */
  trackedCount: number;
  /** Spending rows (Expense/Investment) that are over their ceiling. */
  overCount: number;
  nearCount: number;
  /** Totals across countable rows only — an income row would lie in every one. */
  totalLimitCents: Cents;
  totalAvailableCents: Cents;
  totalSpentCents: Cents;
  totalRemainingCents: Cents;
  /**
   * Rows sitting on an Income category. Always 0 in practice — the actions
   * refuse to create one — but a hand-written row is reported rather than
   * silently added to `overCount` or `totalSpentCents`.
   */
  ignoredIncomeCount: number;
};

/** The figures for the alert strip at the top of the page. */
export function summarizeBudgets(rows: readonly BudgetRowView[]): BudgetSummary {
  const spending = rows.filter((row) => !isIgnoredRow(row));
  const ignored = rows.filter(isIgnoredRow);

  return {
    trackedCount: spending.length,
    overCount: spending.filter(isOverBudget).length,
    nearCount: spending.filter(isNearLimit).length,
    totalLimitCents: sumCents(spending.map((r) => r.limitCents)),
    totalAvailableCents: sumCents(spending.map((r) => r.availableCents)),
    totalSpentCents: sumCents(spending.map((r) => r.spentCents)),
    totalRemainingCents: sumCents(spending.map((r) => r.remainingCents)),
    ignoredIncomeCount: ignored.length,
  };
}

// ---------------------------------------------------------------------------
// Rollover presentation
// ---------------------------------------------------------------------------

export type RolloverPresentation = {
  enabled: boolean;
  carriedInCents: Cents;
  carriedOutCents: Cents;
  availableCents: Cents;
  /** Human sentence for the surplus carried IN, or null when there is none. */
  carriedInLabel: string | null;
  /** Human sentence for the surplus that will carry OUT, or null. */
  carriedOutLabel: string | null;
  availableLabel: string;
  /**
   * True when rollover is on, the period is over budget, and therefore NOTHING is
   * carried: the deficit is absorbed here rather than deducted next period.
   */
  deficitAbsorbed: boolean;
};

/**
 * Explains carry-over in words, so the effective limit is never mysterious.
 *
 * CHOSEN SEMANTIC (the one `lib/budgets.ts` implements): a SURPLUS carries
 * forward, a DEFICIT does not. `carriedOut = rollover && remaining > 0 ?
 * remaining : 0`.
 */
export function describeRollover(
  row: Pick<
    BudgetRowView,
    "rollover" | "carriedInCents" | "carriedOutCents" | "availableCents" | "limitCents" | "remainingCents"
  >,
  currency?: string,
): RolloverPresentation {
  const enabled = row.rollover;
  return {
    enabled,
    carriedInCents: row.carriedInCents,
    carriedOutCents: row.carriedOutCents,
    availableCents: row.availableCents,
    carriedInLabel:
      enabled && row.carriedInCents > 0
        ? `${formatMoney(row.carriedInCents, currency)} carried in from the previous period`
        : null,
    carriedOutLabel:
      enabled && row.carriedOutCents > 0
        ? `${formatMoney(row.carriedOutCents, currency)} will carry into the next period`
        : null,
    availableLabel: enabled
      ? `${formatMoney(row.limitCents, currency)} limit + ${formatMoney(
          row.carriedInCents,
          currency,
        )} carried = ${formatMoney(row.availableCents, currency)} available`
      : `${formatMoney(row.limitCents, currency)} available`,
    deficitAbsorbed: enabled && row.remainingCents < 0,
  };
}

// ---------------------------------------------------------------------------
// Sorting and filtering
// ---------------------------------------------------------------------------

const STATUS_RANK: Record<BudgetStatus, number> = {
  over: 0,
  near: 1,
  "on-track": 2,
  // An ignored income row sits last: it is not a budget, and the alarms stay
  // at the top.
  ignored: 3,
};

const PERIOD_RANK: Record<BudgetPeriod, number> = { weekly: 0, monthly: 1, yearly: 2 };

/** Problems first, then heaviest usage, then alphabetical. Never mutates. */
export function sortBudgetRows(rows: readonly BudgetRowView[]): BudgetRowView[] {
  return [...rows].sort((a, b) => {
    const byStatus = STATUS_RANK[classifyBudgetRow(a)] - STATUS_RANK[classifyBudgetRow(b)];
    if (byStatus !== 0) return byStatus;
    const byUsage =
      usagePercent(b.spentCents, b.availableCents) - usagePercent(a.spentCents, a.availableCents);
    if (byUsage !== 0) return byUsage;
    const byName = a.categoryName.localeCompare(b.categoryName);
    if (byName !== 0) return byName;
    return PERIOD_RANK[a.period] - PERIOD_RANK[b.period];
  });
}

export function rowsForPeriodFilter(
  rows: readonly BudgetRowView[],
  filter: PeriodFilter,
): BudgetRowView[] {
  return filter === "all" ? [...rows] : rows.filter((row) => row.period === filter);
}

/**
 * Categories that COULD have a budget but do not, in id order — shown, not
 * hidden, so an untracked category is an invitation rather than a blank.
 *
 * Income categories are never listed: they cannot have a budget, so offering
 * one would be an invitation the action refuses.
 */
export function unbudgetedCategories<T extends { id: number; type: string }>(
  categories: readonly T[],
  rows: readonly Pick<BudgetRowView, "categoryId">[],
): T[] {
  const budgeted = new Set(rows.map((row) => row.categoryId));
  return budgetableCategories(categories).filter((category) => !budgeted.has(category.id));
}

/**
 * Budget rows that sit on an Income category — impossible to create now, so
 * this is only ever non-empty for a row that predates the rule or was written
 * straight into the database. The page reports them and ignores their numbers.
 */
export function strandedIncomeBudgets<
  B extends { categoryId: number },
  C extends { id: number; name: string; type: string },
>(budgets: readonly B[], categories: readonly C[]): Array<B & { categoryName: string }> {
  const byId = new Map(categories.map((category) => [category.id, category]));
  return budgets
    .filter((budget) => byId.get(budget.categoryId)?.type === "Income")
    .map((budget) => ({
      ...budget,
      categoryName: byId.get(budget.categoryId)?.name ?? `Category ${budget.categoryId}`,
    }));
}

// ---------------------------------------------------------------------------
// Period labels and ranges
// ---------------------------------------------------------------------------

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function periodLabel(period: BudgetPeriod): string {
  switch (period) {
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    case "yearly":
      return "Yearly";
  }
}

/** "per week" / "per month" / "per year", for a limit shown next to a period. */
export function periodUnitLabel(period: BudgetPeriod): string {
  switch (period) {
    case "weekly":
      return "per week";
    case "monthly":
      return "per month";
    case "yearly":
      return "per year";
  }
}

/**
 * A readable label for one period. Deliberately not `Intl.DateTimeFormat`: that
 * varies with the ICU build, and these labels are asserted in tests.
 */
export function formatPeriodRange(
  period: BudgetPeriod,
  periodKey: string,
  startKey: DateKey,
  endKey: DateKey,
): string {
  switch (period) {
    case "yearly":
      return periodKey;
    case "monthly": {
      const start = fromDateKey(startKey);
      return `${MONTHS[start.getMonth()]} ${start.getFullYear()}`;
    }
    case "weekly": {
      const start = fromDateKey(startKey);
      const end = fromDateKey(endKey);
      const head = `${MONTHS[start.getMonth()]} ${start.getDate()}`;
      const tail =
        start.getMonth() === end.getMonth()
          ? String(end.getDate())
          : `${MONTHS[end.getMonth()]} ${end.getDate()}`;
      const year =
        start.getFullYear() === end.getFullYear()
          ? String(end.getFullYear())
          : `${start.getFullYear()}/${end.getFullYear()}`;
      return `${head} - ${tail}, ${year}`;
    }
  }
}

/** The day before `key`, built from LOCAL components only. */
function previousDayKey(key: DateKey): DateKey {
  const d = fromDateKey(key);
  return toDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
}

/**
 * The last `count` periods of type `period`, oldest first, ending with the one
 * that contains `dateKey`.
 *
 * Walking back via "the day before this period started" keeps every boundary on
 * the calendar — a month end, a leap day and a year end all fall out correctly,
 * in any timezone.
 */
export function previousPeriods(
  period: BudgetPeriod,
  dateKey: DateKey,
  count: number,
): PeriodRange[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`previousPeriods needs at least one period, received ${String(count)}`);
  }
  const out: PeriodRange[] = [periodContaining(period, dateKey)];
  while (out.length < count) {
    out.unshift(periodContaining(period, previousDayKey(out[0].startKey)));
  }
  return out;
}

/** The inclusive date window covering the last `count` periods. */
export function historyRange(
  period: BudgetPeriod,
  dateKey: DateKey,
  count: number,
): { fromKey: DateKey; toKey: DateKey } {
  const periods = previousPeriods(period, dateKey, count);
  return { fromKey: periods[0].startKey, toKey: periods[periods.length - 1].endKey };
}

// ---------------------------------------------------------------------------
// Historical performance
// ---------------------------------------------------------------------------

export type HistoryStatus = "over" | "under" | "exact" | "ignored";

export type HistoryVerdict = {
  status: HistoryStatus;
  /** Magnitude of the miss/margin, always non-negative. */
  deltaCents: Cents;
  /** True while the period has not finished, so "stayed under" is not yet final. */
  inProgress: boolean;
  label: string;
};

/**
 * "Did I stay under in March?" for one (category, period) row.
 *
 * A period that includes `todayKey` is still IN PROGRESS: the verdict is a
 * running figure, not a result, and the UI says so.
 */
export function historyVerdict(
  row: Pick<
    BudgetRowView,
    "categoryType" | "spentCents" | "availableCents" | "remainingCents" | "endKey"
  >,
  todayKey: DateKey,
  currency?: string,
): HistoryVerdict {
  const inProgress = row.endKey >= todayKey;
  const remaining = row.remainingCents;

  // Defensive: an Income category cannot have a budget, so a row on one has no
  // verdict to give. Saying so is honest; calling it "over by X" is not.
  if (isIgnoredRow(row)) {
    return {
      status: "ignored",
      deltaCents: 0,
      inProgress,
      label: "Ignored: an income category has no budget",
    };
  }

  if (remaining === 0) return { status: "exact", deltaCents: 0, inProgress, label: "Exactly on budget" };
  if (remaining < 0) {
    const delta = -remaining;
    return {
      status: "over",
      deltaCents: delta,
      inProgress,
      label: `Over by ${formatMoney(delta, currency)}`,
    };
  }
  return {
    status: "under",
    deltaCents: remaining,
    inProgress,
    label: `Under by ${formatMoney(remaining, currency)}`,
  };
}

export type HistoryPeriodGroup = {
  periodKey: string;
  period: BudgetPeriod;
  startKey: DateKey;
  endKey: DateKey;
  label: string;
  /** Rows in the period, alphabetical by category. */
  rows: BudgetRowView[];
  overCount: number;
  totalLimitCents: Cents;
  totalSpentCents: Cents;
};

/**
 * Groups history rows into periods, NEWEST FIRST — the answer to "how did last
 * month go?" should be the first thing on screen.
 */
export function groupHistory(rows: readonly BudgetRowView[]): HistoryPeriodGroup[] {
  const groups = new Map<string, BudgetRowView[]>();
  for (const row of rows) {
    const key = `${row.period}|${row.periodKey}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.values()]
    .map((bucket) => {
      const first = bucket[0];
      // Ignored income rows are listed but contribute to no total.
      const spending = bucket.filter((row) => !isIgnoredRow(row));
      return {
        periodKey: first.periodKey,
        period: first.period,
        startKey: first.startKey,
        endKey: first.endKey,
        label: formatPeriodRange(first.period, first.periodKey, first.startKey, first.endKey),
        rows: [...bucket].sort((a, b) => a.categoryName.localeCompare(b.categoryName)),
        overCount: spending.filter(isOverBudget).length,
        totalLimitCents: sumCents(spending.map((row) => row.limitCents)),
        totalSpentCents: sumCents(spending.map((row) => row.spentCents)),
      };
    })
    .sort((a, b) => (a.startKey === b.startKey ? 0 : a.startKey < b.startKey ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Create/edit form
// ---------------------------------------------------------------------------

export type BudgetRuleFormState = {
  /** Stringified category id; "" when nothing is chosen yet. */
  categoryId: string;
  period: BudgetPeriod;
  /** Decimal string for the `<input type="number">`. "" is INVALID, not "none". */
  limit: string;
  effectiveFrom: DateKey;
  /** "" means open-ended. */
  effectiveTo: string;
  rollover: boolean;
  /** Close the previously-open budget for this category+period the day before. */
  closePrevious: boolean;
};

/** The budget row shape the dialog is handed when editing. */
export type EditableBudget = {
  id: number;
  categoryId: number;
  period: BudgetPeriod;
  limitCents: Cents;
  effectiveFrom: DateKey;
  effectiveTo: DateKey | null;
  rollover: boolean;
};

/**
 * Validation, so the dialog never sends something the action will reject with a
 * message the user cannot act on. Returns the message, or null when valid.
 *
 * Pass `categories` to also refuse an Income category here. The server action
 * refuses it regardless — this only saves a round trip and gives the same
 * sentence.
 */
export function validateBudgetForm(
  state: BudgetRuleFormState,
  categories?: readonly CategoryOption[],
): string | null {
  const categoryId = Number(state.categoryId);
  if (!state.categoryId.trim() || !Number.isInteger(categoryId) || categoryId <= 0) {
    return "Choose a category for this budget.";
  }
  const chosen = categories?.find((category) => category.id === categoryId);
  if (chosen && isIncomeCategory(chosen)) return incomeBudgetRefusal(chosen.name);
  if (!(budgetPeriods as readonly string[]).includes(state.period)) {
    return `Choose a period: ${budgetPeriods.join(", ")}.`;
  }

  // A budgets row has a NOT NULL limit, so blank is a mistake — but "0" is a
  // perfectly good ceiling and must pass. (`tryParseAmount("0")` is 0, which is
  // falsy: never gate on truthiness here.)
  const limitCents = tryParseAmount(state.limit.trim());
  if (limitCents === null) {
    return "Enter a limit for this budget (0 is allowed and means \"spend nothing\").";
  }
  if (limitCents < 0) return "A budget limit cannot be negative.";

  if (!isDateKey(state.effectiveFrom)) return "Enter a valid start date (YYYY-MM-DD).";
  const to = state.effectiveTo.trim();
  if (to !== "") {
    if (!isDateKey(to)) return "Enter a valid end date (YYYY-MM-DD), or leave it blank.";
    if (to < state.effectiveFrom) return "The end date cannot be before the start date.";
  }
  return null;
}

/**
 * Exactly the keys the dialog appends to FormData.
 *
 * `limit` is ALWAYS present — including as "0" — because a budget has no "no
 * limit" state; that is the whole point of the separate table. `effectiveTo` is
 * always present too, as "" when open-ended: `updateBudget` only touches a field
 * when `formData.has(...)` and reads "" as null, so omitting the key would make
 * "open-ended again" impossible to express.
 */
export function buildBudgetFormValues(state: BudgetRuleFormState): Record<string, string> {
  return {
    categoryId: state.categoryId.trim(),
    period: state.period,
    limit: state.limit.trim(),
    effectiveFrom: state.effectiveFrom,
    effectiveTo: state.effectiveTo.trim(),
    rollover: state.rollover ? "true" : "false",
    closePrevious: state.closePrevious ? "true" : "false",
  };
}

export function toBudgetFormData(state: BudgetRuleFormState): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(buildBudgetFormValues(state))) {
    formData.append(key, value);
  }
  return formData;
}

/**
 * Form state for a budget being edited, or the defaults for a new one.
 *
 * A new budget starts at the FIRST DAY OF THE CURRENT PERIOD (from `todayKey`, a
 * local calendar day) so "monthly, from now" means the whole month rather than a
 * stub period starting mid-month.
 */
export function budgetFormStateFrom(
  budget: EditableBudget | null,
  todayKey: DateKey,
  defaults?: { period?: BudgetPeriod; categoryId?: number },
): BudgetRuleFormState {
  if (budget) {
    return {
      categoryId: String(budget.categoryId),
      period: budget.period,
      // Decimal string for the number input; the action parses it with
      // parseAmount. A 0 limit must stay visible as "0", not become "".
      limit: centsToDecimal(budget.limitCents).toString(),
      effectiveFrom: budget.effectiveFrom,
      effectiveTo: budget.effectiveTo ?? "",
      rollover: budget.rollover,
      // Editing a row in place must not close it against itself.
      closePrevious: false,
    };
  }

  const period = defaults?.period ?? "monthly";
  return {
    categoryId: defaults?.categoryId === undefined ? "" : String(defaults.categoryId),
    period,
    limit: "",
    effectiveFrom: periodContaining(period, todayKey).startKey,
    effectiveTo: "",
    rollover: false,
    closePrevious: true,
  };
}

/**
 * Keeps the effective-from date snapped to the start of the chosen period while
 * the user is still creating the budget (it is left alone when editing).
 */
export function withPeriod(state: BudgetRuleFormState, period: BudgetPeriod): BudgetRuleFormState {
  return {
    ...state,
    period,
    effectiveFrom: isDateKey(state.effectiveFrom)
      ? periodContaining(period, state.effectiveFrom).startKey
      : state.effectiveFrom,
  };
}
