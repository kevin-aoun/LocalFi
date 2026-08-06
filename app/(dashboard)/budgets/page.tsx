import {
  getBudgetHistory,
  getBudgetReallocations,
  getBudgets,
  getSpendVsBudget,
} from "@/app/actions/budgets";
import { getCategories } from "@/app/actions/categories";
import { getTransactions } from "@/app/actions/transactions";
import { historyRange } from "@/components/budgets/budget-view-logic";
import { periodContaining, spendInRange, type BudgetLedgerTransaction } from "@/lib/budgets";
import { toDateKey, todayKey } from "@/lib/dates";
import type { Cents } from "@/lib/money";

import BudgetsClient from "./budgets-client";

export const dynamic = "force-dynamic";

/** How many periods of history to load up front; the client can ask for more. */
const INITIAL_HISTORY_PERIODS = 6;

/**
 * Budgets & categories.
 *
 * Every number on this page comes from the tested engine — `getSpendVsBudget` for
 * the period in progress and `getBudgetHistory` for past periods — rather than
 * being re-derived from the transaction list in the browser, which is how the old
 * page ended up monthly-only and current-month-only.
 *
 * The one thing computed here is each category's spend in the current calendar
 * month, for the category manager's cards: a category with no budget at all has no
 * row in the engine's output, and "no budget yet" still deserves a figure.
 */
export default async function BudgetsPage() {
  const today = todayKey();
  const month = periodContaining("monthly", today);
  const monthlyHistory = historyRange("monthly", today, INITIAL_HISTORY_PERIODS);

  const [categories, transactions, budgets, currentPeriod, history, reallocations] = await Promise.all([
    getCategories(),
    getTransactions(),
    getBudgets(),
    getSpendVsBudget({ dateKey: today }),
    getBudgetHistory({ ...monthlyHistory, period: "monthly" }),
    getBudgetReallocations(),
  ]);

  // Same spend rule as the engine (transfers and pending rows excluded) because
  // it IS the engine's function — not a second opinion.
  const ledger: BudgetLedgerTransaction[] = transactions.map((tx) => ({
    categoryId: tx.categoryId,
    amountCents: tx.amountCents,
    dateKey: toDateKey(tx.date),
    pending: tx.pending,
    accountId: tx.accountId,
    transferAccountId: tx.transferAccountId,
  }));
  const monthlySpendByCategory: Record<number, Cents> = {};
  for (const category of categories) {
    monthlySpendByCategory[category.id] = spendInRange(
      ledger,
      category.id,
      month.startKey,
      month.endKey,
    );
  }

  return (
    <BudgetsClient
      todayKey={today}
      initialCategories={categories}
      initialBudgets={budgets}
      initialCurrentPeriod={currentPeriod}
      initialHistory={history}
      initialReallocations={reallocations}
      initialHistoryPeriods={INITIAL_HISTORY_PERIODS}
      monthlySpendByCategory={monthlySpendByCategory}
      currentMonthLabel={month.key}
    />
  );
}
