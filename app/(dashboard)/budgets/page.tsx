import {
  getBudgetHistory,
  getBudgetReallocations,
  getBudgets,
  getCategorySpend,
  getSpendVsBudget,
} from "@/app/actions/budgets";
import { getCategories } from "@/app/actions/categories";
import { historyRange } from "@/components/budgets/budget-view-logic";
import { periodContaining } from "@/lib/budgets";
import { todayKey } from "@/lib/dates";

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
 * Category-card actuals come from the same journal-derived read as the budget
 * engine, including categories without a budget.
 */
export default async function BudgetsPage() {
  const today = todayKey();
  const month = periodContaining("monthly", today);
  const monthlyHistory = historyRange("monthly", today, INITIAL_HISTORY_PERIODS);

  const [categories, budgets, currentPeriod, history, reallocations, monthlySpendByCategory] = await Promise.all([
    getCategories(),
    getBudgets(),
    getSpendVsBudget({ dateKey: today }),
    getBudgetHistory({ ...monthlyHistory, period: "monthly" }),
    getBudgetReallocations(),
    getCategorySpend({ dateKey: today }),
  ]);

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
