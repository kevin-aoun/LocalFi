import { describe, expect, it } from "vitest";

import {
  budgetPerformance,
  deriveBudgetGoalProgress,
  type BudgetRow,
  type BudgetLedgerTransaction,
} from "../budgets";

const goalBudget: BudgetRow = {
  id: 1,
  categoryId: 10,
  period: "monthly",
  limitCents: 10_000,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  rollover: true,
  goalName: "Emergency fund",
  goalAmountCents: 50_000,
};

function expense(dateKey: string, amountCents: number): BudgetLedgerTransaction {
  return {
    categoryId: 10,
    amountCents,
    dateKey,
    pending: false,
    accountId: 1,
    transferAccountId: null,
    direction: "outflow",
  };
}

describe("budget goal derivation", () => {
  it("uses accumulated remaining rollover as savings progress", () => {
    const rows = budgetPerformance({
      budgets: [goalBudget],
      transactions: [expense("2026-01-10", 2_000), expense("2026-02-10", 3_000)],
      fromKey: "2026-01-01",
      toKey: "2026-02-28",
    });

    expect(rows.map((row) => [row.periodKey, row.availableCents, row.remainingCents])).toEqual([
      ["2026-01", 10_000, 8_000],
      ["2026-02", 18_000, 15_000],
    ]);
    expect(deriveBudgetGoalProgress(rows[1])).toEqual({
      name: "Emergency fund",
      targetCents: 50_000,
      monthlyAllocationCents: 10_000,
      savedCents: 15_000,
      remainingCents: 35_000,
      progressPercent: 30,
    });
  });

  it("floors an overspent balance at zero", () => {
    const [row] = budgetPerformance({
      budgets: [goalBudget],
      transactions: [expense("2026-01-10", 12_000)],
      fromKey: "2026-01-01",
      toKey: "2026-01-31",
    });
    expect(deriveBudgetGoalProgress(row)).toMatchObject({
      savedCents: 0,
      remainingCents: 50_000,
      progressPercent: 0,
    });
  });

  it("caps completed progress at 100 percent and remaining at zero", () => {
    const [row] = budgetPerformance({
      budgets: [{ ...goalBudget, limitCents: 60_000 }],
      transactions: [],
      fromKey: "2026-01-01",
      toKey: "2026-01-31",
    });
    expect(deriveBudgetGoalProgress(row)).toMatchObject({
      savedCents: 60_000,
      remainingCents: 0,
      progressPercent: 100,
    });
  });

  it("returns no presentation for an ordinary rollover budget", () => {
    const [row] = budgetPerformance({
      budgets: [{ ...goalBudget, goalName: null, goalAmountCents: null }],
      transactions: [],
      fromKey: "2026-01-01",
      toKey: "2026-01-31",
    });
    expect(deriveBudgetGoalProgress(row)).toBeNull();
  });
});
