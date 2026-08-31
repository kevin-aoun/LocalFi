
import { isSpendable, type CashLedgerTransaction } from "./cash-balance";
import { fromDateKey, isDateKey, toDateKey, type DateKey } from "./dates";
import { assertCents, negateCents, sumCents, type Cents } from "./money";

export const budgetPeriods = ["weekly", "monthly", "yearly"] as const;
export type BudgetPeriod = (typeof budgetPeriods)[number];

const MAX_PERIODS = 5_000;

export type PeriodRange = {

  key: string;
  startKey: DateKey;

  endKey: DateKey;
};

export type BudgetRow = {
  id: number;
  categoryId: number;
  period: BudgetPeriod;
  limitCents: Cents;
  effectiveFrom: DateKey;

  effectiveTo: DateKey | null;
  rollover: boolean;

  goalName?: string | null;
  goalAmountCents?: Cents | null;

  displayOrder?: number;
};

export type BudgetReallocationRow = {
  id?: number;
  month: string;
  fromCategoryId: number;
  toCategoryId: number;
  amountCents: Cents;
};

export type BudgetReallocationFlow = {
  incomingCents: Cents;
  outgoingCents: Cents;
  netCents: Cents;
};

export type BudgetLedgerTransaction = CashLedgerTransaction & {
  dateKey: DateKey;

  categoryMovementCents?: Cents;
};

export type BudgetPeriodResult = {
  categoryId: number;
  budgetId: number;
  period: BudgetPeriod;
  periodKey: string;
  startKey: DateKey;
  endKey: DateKey;
  limitCents: Cents;

  carriedInCents: Cents;

  availableCents: Cents;
  spentCents: Cents;

  remainingCents: Cents;

  carriedOutCents: Cents;
  rollover: boolean;

  goalName?: string | null;
  goalAmountCents?: Cents | null;
  overBudget: boolean;
};

export type BudgetGoalProgress = {
  name: string;
  targetCents: Cents;

  monthlyAllocationCents: Cents;

  savedCents: Cents;
  remainingCents: Cents;

  progressPercent: number;
};

export function deriveBudgetGoalProgress(
  row: Pick<
    BudgetPeriodResult,
    | "period"
    | "limitCents"
    | "remainingCents"
    | "rollover"
    | "goalName"
    | "goalAmountCents"
  >,
): BudgetGoalProgress | null {
  const goalName = row.goalName?.trim() || null;
  const targetCents = row.goalAmountCents ?? null;
  if (goalName === null && targetCents === null) return null;
  if (
    goalName === null ||
    targetCents === null ||
    !Number.isSafeInteger(targetCents) ||
    targetCents <= 0 ||
    row.period !== "monthly" ||
    !row.rollover
  ) {
    throw new Error("Invalid budget goal: goals require a name, positive target, and monthly rollover");
  }

  const savedCents = Math.max(0, row.remainingCents) as Cents;
  const remainingCents = Math.max(0, targetCents - savedCents) as Cents;
  return {
    name: goalName,
    targetCents,
    monthlyAllocationCents: row.limitCents,
    savedCents,
    remainingCents,
    progressPercent: Math.min(100, Math.max(0, (savedCents / targetCents) * 100)),
  };
}

function assertPeriod(period: BudgetPeriod) {
  if (!budgetPeriods.includes(period)) {
    throw new Error(`Invalid budget period: ${String(period)}`);
  }
}

function assertKey(key: DateKey, label: string): DateKey {
  if (!isDateKey(key)) {
    throw new Error(`Invalid ${label}: expected 'YYYY-MM-DD' for a real calendar day, received ${JSON.stringify(key)}`);
  }
  return key;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}


function startOfWeek(d: Date): Date {
  const offset = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
}


export function periodContaining(period: BudgetPeriod, dateKey: DateKey): PeriodRange {
  assertPeriod(period);
  const d = fromDateKey(assertKey(dateKey, "date key"));

  switch (period) {
    case "weekly": {
      const start = startOfWeek(d);
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
      return { key: toDateKey(start), startKey: toDateKey(start), endKey: toDateKey(end) };
    }
    case "monthly": {
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      return {
        key: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}`,
        startKey: toDateKey(start),
        endKey: toDateKey(end),
      };
    }
    case "yearly": {
      const start = new Date(d.getFullYear(), 0, 1);
      const end = new Date(d.getFullYear(), 11, 31);
      return { key: String(start.getFullYear()), startKey: toDateKey(start), endKey: toDateKey(end) };
    }
  }
}


function nextPeriod(period: BudgetPeriod, range: PeriodRange): PeriodRange {
  const end = fromDateKey(range.endKey);
  const dayAfter = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  return periodContaining(period, toDateKey(dayAfter));
}


export function periodsBetween(period: BudgetPeriod, fromKey: DateKey, toKey: DateKey): PeriodRange[] {
  assertPeriod(period);
  assertKey(fromKey, "from date key");
  assertKey(toKey, "to date key");
  if (fromKey > toKey) return [];

  const out: PeriodRange[] = [];
  let current = periodContaining(period, fromKey);
  for (let i = 0; i < MAX_PERIODS; i++) {
    out.push(current);
    if (current.endKey >= toKey) return out;
    current = nextPeriod(period, current);
  }
  throw new Error(
    `Refusing to enumerate more than ${MAX_PERIODS} ${period} periods between ${fromKey} and ${toKey}`,
  );
}


export function budgetInForce(
  budgets: readonly BudgetRow[],
  categoryId: number,
  dateKey: DateKey,
  period?: BudgetPeriod,
): BudgetRow | null {
  assertKey(dateKey, "date key");
  const candidates = budgets.filter(
    (b) =>
      b.categoryId === categoryId &&
      (period === undefined || b.period === period) &&
      b.effectiveFrom <= dateKey &&
      (b.effectiveTo === null || b.effectiveTo >= dateKey),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, b) =>
    b.effectiveFrom > best.effectiveFrom || (b.effectiveFrom === best.effectiveFrom && b.id > best.id)
      ? b
      : best,
  );
}


export function spendInRange(
  transactions: readonly BudgetLedgerTransaction[],
  categoryId: number,
  startKey: DateKey,
  endKey: DateKey,
): Cents {
  assertKey(startKey, "start date key");
  assertKey(endKey, "end date key");
  const amounts = transactions
    .filter(
      (tx) =>
        tx.categoryId === categoryId &&
        isSpendable(tx) &&


        (tx.direction == null || tx.direction === "outflow") &&
        tx.dateKey >= startKey &&
        tx.dateKey <= endKey,
    )
    .map((tx) => {
      const amount = tx.categoryMovementCents ?? tx.amountCents;
      assertCents(amount, "category movement");
      return amount;
    });
  return sumCents(amounts);
}

export type BudgetPerformanceInput = {
  budgets: readonly BudgetRow[];
  transactions: readonly BudgetLedgerTransaction[];

  reallocations?: readonly BudgetReallocationRow[];

  fromKey: DateKey;
  toKey: DateKey;

  categoryId?: number;

  period?: BudgetPeriod;
};


export function monthlyReallocationFlow(
  reallocations: readonly BudgetReallocationRow[],
  categoryId: number,
  month: string,
): BudgetReallocationFlow {
  const incoming: Cents[] = [];
  const outgoing: Cents[] = [];
  for (const row of reallocations) {
    if (row.month !== month) continue;
    assertCents(row.amountCents, `reallocation ${row.id ?? "?"} amountCents`);
    if (row.fromCategoryId === categoryId) outgoing.push(row.amountCents);
    if (row.toCategoryId === categoryId) incoming.push(row.amountCents);
  }
  const incomingCents = sumCents(incoming);
  const outgoingCents = sumCents(outgoing);
  return {
    incomingCents,
    outgoingCents,
    netCents: sumCents([incomingCents, negateCents(outgoingCents)]),
  };
}


export function monthlyReallocationAdjustment(
  reallocations: readonly BudgetReallocationRow[],
  categoryId: number,
  month: string,
): Cents {
  return monthlyReallocationFlow(reallocations, categoryId, month).netCents;
}

/**
 * The portion of a monthly allocation that can leave a category without making
 * its confirmed spending exceed that allocation. Keep this separate from
 * rollover: a reallocation is about this month's allocation only.
 */
export function reallocationMaximumCents(
  budgetedCents: Cents,
  spentCents: Cents,
): Cents {
  assertCents(budgetedCents, "budgeted amount");
  assertCents(spentCents, "spent amount");
  const unspent = sumCents([budgetedCents, negateCents(spentCents)]);
  // Refunds must not let a category give away more than is allocated, and an
  // overspent category has no amount left to move.
  return Math.max(0, Math.min(budgetedCents, unspent)) as Cents;
}

export function percentageOfBudgetCents(
  budgetedCents: Cents,
  basisPoints: number,
): Cents {
  assertCents(budgetedCents, "budgeted amount");
  if (!Number.isInteger(basisPoints) || basisPoints < 1 || basisPoints > 10_000) {
    throw new Error("Percentage must be between 0.01 and 100.");
  }
  const rounded = (BigInt(budgetedCents) * BigInt(basisPoints) + BigInt(5_000)) / BigInt(10_000);
  const cents = Number(rounded);
  assertCents(cents, "percentage amount");
  return cents;
}


export function budgetPerformance(input: BudgetPerformanceInput): BudgetPeriodResult[] {
  const { budgets, transactions, reallocations = [], categoryId, period } = input;
  const fromKey = assertKey(input.fromKey, "from date key");
  const toKey = assertKey(input.toKey, "to date key");
  if (fromKey > toKey) return [];

  const relevant = budgets.filter(
    (b) =>
      (categoryId === undefined || b.categoryId === categoryId) &&
      (period === undefined || b.period === period),
  );



  const groups = new Map<string, BudgetRow[]>();
  for (const budget of relevant) {
    const key = `${budget.categoryId}|${budget.period}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(budget);
    else groups.set(key, [budget]);
  }

  const out: BudgetPeriodResult[] = [];

  for (const rows of groups.values()) {
    const group = [...rows].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    const groupPeriod = group[0].period;
    const groupCategory = group[0].categoryId;
    assertPeriod(groupPeriod);


    const simulationStart = group[0].effectiveFrom;

    const openEnded = group.some((b) => b.effectiveTo === null);
    const lastApplicable = openEnded
      ? toKey
      : group.reduce((latest, b) => (b.effectiveTo! > latest ? b.effectiveTo! : latest), group[0].effectiveTo!);
    const simulationEnd = lastApplicable < toKey ? lastApplicable : toKey;
    if (simulationStart > simulationEnd) continue;

    let carriedInCents: Cents = 0;
    for (const range of periodsBetween(groupPeriod, simulationStart, simulationEnd)) {
      const budget = budgetInForce(group, groupCategory, range.startKey, groupPeriod);
      if (!budget) {

        carriedInCents = 0;
        continue;
      }
      assertCents(budget.limitCents, `budget ${budget.id} limitCents`);

      const adjustmentCents =
        groupPeriod === "monthly"
          ? monthlyReallocationAdjustment(reallocations, groupCategory, range.key)
          : 0;
      const effectiveLimitCents = sumCents([budget.limitCents, adjustmentCents]);

      const appliedCarry = budget.rollover ? carriedInCents : 0;
      const availableCents = sumCents([effectiveLimitCents, appliedCarry]);
      const spentCents = spendInRange(transactions, groupCategory, range.startKey, range.endKey);
      const remainingCents = sumCents([availableCents, negateCents(spentCents)]);
      const carriedOutCents = budget.rollover && remainingCents > 0 ? remainingCents : 0;

      if (range.endKey >= fromKey && range.startKey <= toKey) {
        out.push({
          categoryId: groupCategory,
          budgetId: budget.id,
          period: groupPeriod,
          periodKey: range.key,
          startKey: range.startKey,
          endKey: range.endKey,
          limitCents: effectiveLimitCents,
          carriedInCents: appliedCarry,
          availableCents,
          spentCents,
          remainingCents,
          carriedOutCents,
          rollover: budget.rollover,
          goalName: budget.goalName ?? null,
          goalAmountCents: budget.goalAmountCents ?? null,
          overBudget: remainingCents < 0,
        });
      }

      carriedInCents = carriedOutCents;
    }
  }

  return out.sort((a, b) =>
    a.periodKey === b.periodKey ? a.categoryId - b.categoryId : a.periodKey < b.periodKey ? -1 : 1,
  );
}

export type SpendVsBudgetInput = {
  budgets: readonly BudgetRow[];
  transactions: readonly BudgetLedgerTransaction[];
  reallocations?: readonly BudgetReallocationRow[];

  dateKey: DateKey;

  period?: BudgetPeriod;
  categoryId?: number;
};


export function spendVsBudget(input: SpendVsBudgetInput): BudgetPeriodResult[] {
  const { budgets, transactions, reallocations = [], dateKey, period, categoryId } = input;
  assertKey(dateKey, "date key");

  const types: BudgetPeriod[] = period ? [period] : [...new Set(budgets.map((b) => b.period))];
  const out: BudgetPeriodResult[] = [];
  for (const type of types) {
    const range = periodContaining(type, dateKey);
    out.push(
      ...budgetPerformance({
        budgets,
        transactions,
        reallocations,
        fromKey: range.startKey,
        toKey: range.endKey,
        period: type,
        categoryId,
      }),
    );
  }
  return out;
}


export function budgetsFromLegacyLimits(
  categories: readonly { id: number; monthlyLimitCents?: Cents | null }[],
  effectiveFrom: DateKey,
): BudgetRow[] {
  assertKey(effectiveFrom, "effectiveFrom date key");
  return categories
    .filter((c) => c.monthlyLimitCents !== null && c.monthlyLimitCents !== undefined)
    .map((c) => {
      assertCents(c.monthlyLimitCents, `category ${c.id} monthlyLimitCents`);
      return {
        id: -c.id,
        categoryId: c.id,
        period: "monthly" as const,
        limitCents: c.monthlyLimitCents as Cents,
        effectiveFrom,
        effectiveTo: null,
        rollover: false,
      };
    });
}
