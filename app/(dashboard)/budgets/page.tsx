import {
  getBudgetOverview,
  getBudgetReallocations,
  getBudgets,
} from "@/app/actions/budgets";
import { getCategories } from "@/app/actions/categories";
import { historyRange } from "@/components/budgets/budget-view-logic";
import { periodContaining } from "@/lib/budgets";
import { todayKey } from "@/lib/dates";

import BudgetsClient from "./budgets-client";

export const dynamic = "force-dynamic";

const INITIAL_HISTORY_PERIODS = 6;

export default async function BudgetsPage() {
  const today = todayKey();
  const month = periodContaining("monthly", today);
  const monthlyHistory = historyRange("monthly", today, INITIAL_HISTORY_PERIODS);

  const [categories, budgets, overview, reallocations] = await Promise.all([
    getCategories(),
    getBudgets(),
    getBudgetOverview({ dateKey: today, history: { ...monthlyHistory, period: "monthly" } }),
    getBudgetReallocations(),
  ]);
  const { currentPeriod, history, monthlySpendByCategory } = overview;

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
