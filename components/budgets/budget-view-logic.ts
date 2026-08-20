
import {
  budgetPeriods,
  periodContaining,
  type BudgetPeriod,
  type BudgetPeriodResult,
  type PeriodRange,
} from "@/lib/budgets";
import { fromDateKey, isDateKey, toDateKey, type DateKey } from "@/lib/dates";
import { centsToDecimal, formatMoney, sumCents, tryParseAmount, type Cents } from "@/lib/money";

export const NEAR_LIMIT_PERCENT = 80;

export type BudgetRowView = BudgetPeriodResult & {
  categoryName: string;
  categoryType: string;
  categoryColor: string;
  categoryIcon: string;

  displayOrder: number;

  legacy: boolean;

  effectiveFrom?: DateKey;
  effectiveTo?: DateKey | null;
};

export type CategoryOption = { id: number; name: string; type: string };

export type PeriodFilter = BudgetPeriod | "all";

export const periodFilters: readonly PeriodFilter[] = ["all", ...budgetPeriods];

export type BudgetStatus = "over" | "near" | "on-track" | "ignored";

export const INCOME_BUDGET_REFUSAL =
  "Income categories can't have a budget: a budget is a spending limit.";

export function incomeBudgetRefusal(categoryName?: string): string {
  return categoryName
    ? `${categoryName} is an Income category. ${INCOME_BUDGET_REFUSAL}`
    : INCOME_BUDGET_REFUSAL;
}


export function isIncomeCategory(category: Pick<CategoryOption, "type">): boolean {
  return category.type === "Income";
}


export function budgetableCategories<T extends { type: string }>(
  categories: readonly T[],
): T[] {
  return categories.filter((category) => !isIncomeCategory(category));
}


export function isIgnoredRow(row: Pick<BudgetRowView, "categoryType">): boolean {
  return row.categoryType === "Income";
}






export function usagePercent(spentCents: Cents, availableCents: Cents): number {
  if (availableCents <= 0) return spentCents > 0 ? 100 : 0;

  return (spentCents / availableCents) * 100;
}


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


  if (isIgnoredRow(row)) return "ignored";
  if (row.remainingCents < 0) return "over";
  return usagePercent(row.spentCents, row.availableCents) >= NEAR_LIMIT_PERCENT
    ? "near"
    : "on-track";
}


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

  trackedCount: number;

  overCount: number;
  nearCount: number;

  totalLimitCents: Cents;
  totalAvailableCents: Cents;
  totalSpentCents: Cents;
  totalRemainingCents: Cents;

  ignoredIncomeCount: number;
};


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





export type RolloverPresentation = {
  enabled: boolean;
  carriedInCents: Cents;
  carriedOutCents: Cents;
  availableCents: Cents;

  carriedInLabel: string | null;

  carriedOutLabel: string | null;
  availableLabel: string;

  deficitAbsorbed: boolean;
};


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





const STATUS_RANK: Record<BudgetStatus, number> = {
  over: 0,
  near: 1,
  "on-track": 2,


  ignored: 3,
};

const PERIOD_RANK: Record<BudgetPeriod, number> = { weekly: 0, monthly: 1, yearly: 2 };


export function sortBudgetRows(rows: readonly BudgetRowView[]): BudgetRowView[] {
  return [...rows].sort((a, b) => {
    const byDisplayOrder = a.displayOrder - b.displayOrder;
    if (byDisplayOrder !== 0) return byDisplayOrder;
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


export function unbudgetedCategories<T extends { id: number; type: string }>(
  categories: readonly T[],
  rows: readonly Pick<BudgetRowView, "categoryId">[],
): T[] {
  const budgeted = new Set(rows.map((row) => row.categoryId));
  return budgetableCategories(categories).filter((category) => !budgeted.has(category.id));
}


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


function previousDayKey(key: DateKey): DateKey {
  const d = fromDateKey(key);
  return toDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
}


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


export function historyRange(
  period: BudgetPeriod,
  dateKey: DateKey,
  count: number,
): { fromKey: DateKey; toKey: DateKey } {
  const periods = previousPeriods(period, dateKey, count);
  return { fromKey: periods[0].startKey, toKey: periods[periods.length - 1].endKey };
}





export type HistoryStatus = "over" | "under" | "exact" | "ignored";

export type HistoryVerdict = {
  status: HistoryStatus;

  deltaCents: Cents;

  inProgress: boolean;
  label: string;
};


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

  rows: BudgetRowView[];
  overCount: number;
  totalLimitCents: Cents;
  totalSpentCents: Cents;
};


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





export type BudgetRuleFormState = {

  categoryId: string;
  period: BudgetPeriod;

  limit: string;
  effectiveFrom: DateKey;

  effectiveTo: string;
  rollover: boolean;

  closePrevious: boolean;
};


export type EditableBudget = {
  id: number;
  categoryId: number;
  period: BudgetPeriod;
  limitCents: Cents;
  effectiveFrom: DateKey;
  effectiveTo: DateKey | null;
  rollover: boolean;
};


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


export function budgetFormStateFrom(
  budget: EditableBudget | null,
  todayKey: DateKey,
  defaults?: { period?: BudgetPeriod; categoryId?: number },
): BudgetRuleFormState {
  if (budget) {
    return {
      categoryId: String(budget.categoryId),
      period: budget.period,


      limit: centsToDecimal(budget.limitCents).toString(),
      effectiveFrom: budget.effectiveFrom,
      effectiveTo: budget.effectiveTo ?? "",
      rollover: budget.rollover,

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


export function withPeriod(state: BudgetRuleFormState, period: BudgetPeriod): BudgetRuleFormState {
  return {
    ...state,
    period,
    effectiveFrom: isDateKey(state.effectiveFrom)
      ? periodContaining(period, state.effectiveFrom).startKey
      : state.effectiveFrom,
  };
}
