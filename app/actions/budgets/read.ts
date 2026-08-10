import { asc, eq } from "drizzle-orm";
import { readDb } from "@/lib/db/client";
import { budgets, type Budget } from "@/lib/db/schema";
import {
  budgetPerformance,
  periodContaining,
  spendInRange,
  spendVsBudget,
  type BudgetPeriod,
} from "@/lib/budgets";
import { isDateKey, todayKey, type DateKey } from "@/lib/dates";
import type { Cents } from "@/lib/money";
import { decorate, loadLedger, type BudgetPerformanceRow } from "./shared";

export async function getBudgets(): Promise<Budget[]> {
  return readDb((db) => db.select().from(budgets).orderBy(asc(budgets.id)));
}

/** The budgets in force for one category, newest window first. */
export async function getBudgetsForCategory(categoryId: number): Promise<Budget[]> {
  return readDb((db) =>
    db
      .select()
      .from(budgets)
      .where(eq(budgets.categoryId, categoryId))
      .orderBy(asc(budgets.effectiveFrom)),
  );
}

/**
 * Spend vs budget for ONE period — the period containing `dateKey`, which may be
 * any past, present or future day. This is the query the old monthly-only,
 * current-month-only model could not express.
 */
export async function getSpendVsBudget(options?: {
  dateKey?: DateKey;
  period?: BudgetPeriod;
  categoryId?: number;
}): Promise<BudgetPerformanceRow[]> {
  const dateKey = options?.dateKey ?? todayKey();
  if (!isDateKey(dateKey)) throw new Error(`Invalid dateKey: ${String(dateKey)}`);

  const loaded = await loadLedger();
  const results = spendVsBudget({
    budgets: loaded.budgets,
    transactions: loaded.transactions,
    reallocations: loaded.reallocations,
    dateKey,
    period: options?.period,
    categoryId: options?.categoryId,
  });
  return decorate(results, loaded);
}

/** Current-month category actuals for the Categories tab. */
export async function getCategorySpend(options?: { dateKey?: DateKey }): Promise<Record<number, Cents>> {
  const dateKey = options?.dateKey ?? todayKey();
  if (!isDateKey(dateKey)) throw new Error(`Invalid dateKey: ${String(dateKey)}`);

  const loaded = await loadLedger();
  const month = periodContaining("monthly", dateKey);
  const spendByCategory: Record<number, Cents> = {};
  for (const category of loaded.categories) {
    spendByCategory[category.id] = spendInRange(
      loaded.transactions,
      category.id,
      month.startKey,
      month.endKey,
    );
  }
  return spendByCategory;
}

/**
 * Historical performance: one row per (category, period) in `[fromKey, toKey]`.
 * Rollover is simulated from each budget's own start, so the carry-over shown for
 * a period does not depend on how far back the caller asked.
 */
export async function getBudgetHistory(options: {
  fromKey: DateKey;
  toKey: DateKey;
  period?: BudgetPeriod;
  categoryId?: number;
}): Promise<BudgetPerformanceRow[]> {
  if (!isDateKey(options.fromKey)) throw new Error(`Invalid fromKey: ${String(options.fromKey)}`);
  if (!isDateKey(options.toKey)) throw new Error(`Invalid toKey: ${String(options.toKey)}`);

  const loaded = await loadLedger();
  const results = budgetPerformance({
    budgets: loaded.budgets,
    transactions: loaded.transactions,
    reallocations: loaded.reallocations,
    fromKey: options.fromKey,
    toKey: options.toKey,
    period: options.period,
    categoryId: options.categoryId,
  });
  return decorate(results, loaded);
}
