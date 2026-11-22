import { asc } from "drizzle-orm";
import { readDb } from "@/lib/db/client";
import { budgets, type Budget } from "@/lib/db/schema";
import {
  budgetPerformance,
  periodContaining,
  spendInRange,
  spendVsBudget,
  transactionsByCategory,
  type BudgetPeriod,
} from "@/lib/budgets";
import { isDateKey, todayKey, type DateKey } from "@/lib/dates";
import type { Cents } from "@/lib/money";
import { decorate, loadLedger, type BudgetPerformanceRow, type LoadedLedger } from "./shared";

type SpendVsBudgetOptions = {
  dateKey?: DateKey;
  period?: BudgetPeriod;
  categoryId?: number;
};

type BudgetHistoryOptions = {
  fromKey: DateKey;
  toKey: DateKey;
  period?: BudgetPeriod;
  categoryId?: number;
};

export async function getBudgets(): Promise<Budget[]> {
  return readDb((db) => db
    .select()
    .from(budgets)
    .orderBy(asc(budgets.displayOrder), asc(budgets.id)));
}

function resolveDateKey(options?: { dateKey?: DateKey }): DateKey {
  const dateKey = options?.dateKey ?? todayKey();
  if (!isDateKey(dateKey)) throw new Error(`Invalid dateKey: ${String(dateKey)}`);
  return dateKey;
}

function requireHistoryRange(options: BudgetHistoryOptions): void {
  if (!isDateKey(options.fromKey)) throw new Error(`Invalid fromKey: ${String(options.fromKey)}`);
  if (!isDateKey(options.toKey)) throw new Error(`Invalid toKey: ${String(options.toKey)}`);
}

function spendVsBudgetRows(
  loaded: LoadedLedger,
  dateKey: DateKey,
  options?: SpendVsBudgetOptions,
): BudgetPerformanceRow[] {
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

function categorySpend(loaded: LoadedLedger, dateKey: DateKey): Record<number, Cents> {
  const month = periodContaining("monthly", dateKey);
  const byCategory = transactionsByCategory(loaded.transactions);
  const spendByCategory: Record<number, Cents> = {};
  for (const category of loaded.categories) {
    spendByCategory[category.id] = spendInRange(
      byCategory.get(category.id) ?? [],
      category.id,
      month.startKey,
      month.endKey,
    );
  }
  return spendByCategory;
}

function budgetHistoryRows(loaded: LoadedLedger, options: BudgetHistoryOptions): BudgetPerformanceRow[] {
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

export async function getSpendVsBudget(options?: SpendVsBudgetOptions): Promise<BudgetPerformanceRow[]> {
  const dateKey = resolveDateKey(options);
  return spendVsBudgetRows(await loadLedger(), dateKey, options);
}


export async function getCategorySpend(options?: { dateKey?: DateKey }): Promise<Record<number, Cents>> {
  const dateKey = resolveDateKey(options);
  return categorySpend(await loadLedger(), dateKey);
}


export async function getBudgetHistory(options: BudgetHistoryOptions): Promise<BudgetPerformanceRow[]> {
  requireHistoryRange(options);
  return budgetHistoryRows(await loadLedger(), options);
}

/** Everything the Budgets page reads from the ledger, built from one replay instead of one per section. */
export async function getBudgetOverview(options: {
  dateKey?: DateKey;
  history: BudgetHistoryOptions;
}): Promise<{
  currentPeriod: BudgetPerformanceRow[];
  history: BudgetPerformanceRow[];
  monthlySpendByCategory: Record<number, Cents>;
}> {
  const dateKey = resolveDateKey(options);
  requireHistoryRange(options.history);
  const loaded = await loadLedger();
  return {
    currentPeriod: spendVsBudgetRows(loaded, dateKey),
    history: budgetHistoryRows(loaded, options.history),
    monthlySpendByCategory: categorySpend(loaded, dateKey),
  };
}
