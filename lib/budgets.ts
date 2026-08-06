/** Pure, timezone-safe budget period, rollover, and reallocation arithmetic. */
import { isSpendable, type CashLedgerTransaction } from "./cash-balance";
import { fromDateKey, isDateKey, toDateKey, type DateKey } from "./dates";
import { assertCents, negateCents, sumCents, type Cents } from "./money";

export const budgetPeriods = ["weekly", "monthly", "yearly"] as const;
export type BudgetPeriod = (typeof budgetPeriods)[number];

/** Guard against a pathological simulation (a weekly budget anchored in 1970). */
const MAX_PERIODS = 5_000;

export type PeriodRange = {
  /** Stable, sortable identifier for the period. */
  key: string;
  startKey: DateKey;
  /** Inclusive. */
  endKey: DateKey;
};

/** A `budgets` row, structurally typed so this module needs no schema import. */
export type BudgetRow = {
  id: number;
  categoryId: number;
  period: BudgetPeriod;
  limitCents: Cents;
  effectiveFrom: DateKey;
  /** Inclusive last day the budget applies. null = open-ended. */
  effectiveTo: DateKey | null;
  rollover: boolean;
};

/** A fixed one-month transfer between two category budgets. */
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

/** A transaction as the budget engine sees it: a calendar day plus a magnitude. */
export type BudgetLedgerTransaction = CashLedgerTransaction & { dateKey: DateKey };

export type BudgetPeriodResult = {
  categoryId: number;
  budgetId: number;
  period: BudgetPeriod;
  periodKey: string;
  startKey: DateKey;
  endKey: DateKey;
  limitCents: Cents;
  /** Surplus carried in from earlier periods. Always 0 when rollover is off. */
  carriedInCents: Cents;
  /** limitCents + carriedInCents */
  availableCents: Cents;
  spentCents: Cents;
  /** availableCents − spentCents. Negative means over budget. */
  remainingCents: Cents;
  /** Surplus handed to the next period: `rollover ? max(0, remaining) : 0`. */
  carriedOutCents: Cents;
  rollover: boolean;
  overBudget: boolean;
};

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

/** Monday of `d`'s local week. */
function startOfWeek(d: Date): Date {
  const offset = (d.getDay() + 6) % 7; // Mon=0 ... Sun=6
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
}

/** The period of type `period` that contains `dateKey`. */
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

/** The period immediately after `range`. */
function nextPeriod(period: BudgetPeriod, range: PeriodRange): PeriodRange {
  const end = fromDateKey(range.endKey);
  const dayAfter = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  return periodContaining(period, toDateKey(dayAfter));
}

/**
 * Every period of type `period` that overlaps `[fromKey, toKey]`, in order.
 * Returns `[]` when the range is inverted.
 */
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

/**
 * The budget in force for `categoryId` on `dateKey`, or null.
 *
 * When windows overlap (an edit that did not close the previous row) the LATEST
 * `effectiveFrom` wins, and ties break on the highest id, so the most recently
 * created row is authoritative.
 */
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

/**
 * Total spend for `categoryId` in `[startKey, endKey]`, both ends inclusive.
 * Pending rows and transfers are excluded (see `isSpendable`).
 */
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
        tx.dateKey >= startKey &&
        tx.dateKey <= endKey,
    )
    .map((tx) => {
      assertCents(tx.amountCents, "amountCents");
      return tx.amountCents;
    });
  return sumCents(amounts);
}

export type BudgetPerformanceInput = {
  budgets: readonly BudgetRow[];
  transactions: readonly BudgetLedgerTransaction[];
  /** One-off monthly transfers; ignored by weekly and yearly budgets. */
  reallocations?: readonly BudgetReallocationRow[];
  /** Inclusive window of periods to REPORT. */
  fromKey: DateKey;
  toKey: DateKey;
  /** Restrict to one category. */
  categoryId?: number;
  /** Restrict to one period type. Default: every period type present in `budgets`. */
  period?: BudgetPeriod;
};

/** Incoming, outgoing, and net budget movement for one category in one month. */
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

/** Incoming minus outgoing for one category in one month. */
export function monthlyReallocationAdjustment(
  reallocations: readonly BudgetReallocationRow[],
  categoryId: number,
  month: string,
): Cents {
  return monthlyReallocationFlow(reallocations, categoryId, month).netCents;
}

/**
 * Historical performance, one row per (category, period) that had a budget in
 * force. Periods with no budget are omitted rather than reported as zero-limit.
 *
 * Rollover is SIMULATED FROM THE BUDGET'S START, not from `fromKey`: asking for
 * March alone must still see the surplus January and February handed forward, or
 * the number shown would depend on how far back the user happened to scroll.
 * The rows outside `[fromKey, toKey]` are computed and then dropped.
 *
 * Which budget applies to a period is resolved on the period's FIRST day, so a
 * limit change mid-period takes effect in the following period.
 */
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

  // Group by (categoryId, period): a category may hold a weekly AND a monthly
  // budget, and each carries over independently.
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

    // Simulate from the earliest effectiveFrom so carry-over is deterministic.
    const simulationStart = group[0].effectiveFrom;
    // ...but never past the last day any budget in the group applies.
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
        // A gap between budgets breaks the chain: nothing to carry.
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
  /** Any day inside the period of interest — including a past one. */
  dateKey: DateKey;
  /** Default: every period type present in `budgets`. */
  period?: BudgetPeriod;
  categoryId?: number;
};

/**
 * Spend vs budget for the single period containing `dateKey` — the "am I over
 * budget right now (or in March)?" query. Rollover is accounted for exactly as in
 * `budgetPerformance`.
 */
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

/**
 * Reads the legacy `categories.monthly_limit_cents` column as monthly budgets.
 *
 * Kept so that nothing regresses if the `budgets` table is empty (a database that
 * has not been migrated, or a category edited through the old code path). Synthetic
 * ids are NEGATIVE so they can never be confused with a real `budgets.id`.
 */
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
