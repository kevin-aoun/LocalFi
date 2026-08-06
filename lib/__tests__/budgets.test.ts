/**
 * Budget periods, spend-vs-budget, rollover and historical performance.
 *
 * What must not break:
 *   - a period is a calendar period in the USER'S timezone, so a transaction on
 *     the 1st never lands in the previous month's budget;
 *   - transfers and pending rows are not spend;
 *   - an Income category may have a target (the old schema made that impossible);
 *   - rollover carries a SURPLUS forward and never carries a deficit forward;
 *   - history is queryable for any past period, not just the current month.
 */
import { describe, expect, it } from "vitest";
import {
  budgetInForce,
  budgetPerformance,
  budgetsFromLegacyLimits,
  periodContaining,
  periodsBetween,
  spendInRange,
  spendVsBudget,
  type BudgetLedgerTransaction,
  type BudgetRow,
} from "@/lib/budgets";

const FOOD = 1;
const SALARY = 2;

const monthlyFood: BudgetRow = {
  id: 1,
  categoryId: FOOD,
  period: "monthly",
  limitCents: 50_000,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  rollover: false,
};

function tx(dateKey: string, amountCents: number, categoryId: number | null = FOOD, extra: Partial<BudgetLedgerTransaction> = {}): BudgetLedgerTransaction {
  return { dateKey, amountCents, categoryId, ...extra };
}

describe("periodContaining", () => {
  it("resolves a monthly period", () => {
    expect(periodContaining("monthly", "2026-07-28")).toEqual({
      key: "2026-07",
      startKey: "2026-07-01",
      endKey: "2026-07-31",
    });
  });

  it("resolves February in a leap and a non-leap year", () => {
    expect(periodContaining("monthly", "2026-02-10").endKey).toBe("2026-02-28");
    expect(periodContaining("monthly", "2024-02-10").endKey).toBe("2024-02-29");
  });

  it("resolves a yearly period", () => {
    expect(periodContaining("yearly", "2026-07-28")).toEqual({
      key: "2026",
      startKey: "2026-01-01",
      endKey: "2026-12-31",
    });
  });

  it("resolves a weekly period as Monday..Sunday", () => {
    // 2026-07-28 is a Tuesday.
    expect(periodContaining("weekly", "2026-07-28")).toEqual({
      key: "2026-07-27",
      startKey: "2026-07-27",
      endKey: "2026-08-02",
    });
  });

  it("puts a Sunday in the week that STARTED on the previous Monday", () => {
    expect(periodContaining("weekly", "2026-08-02").startKey).toBe("2026-07-27");
  });

  it("puts a Monday at the start of its own week", () => {
    expect(periodContaining("weekly", "2026-07-27").startKey).toBe("2026-07-27");
  });

  it("lets a weekly period straddle a month and a year boundary", () => {
    expect(periodContaining("weekly", "2025-12-31")).toEqual({
      key: "2025-12-29",
      startKey: "2025-12-29",
      endKey: "2026-01-04",
    });
  });

  it("rejects a malformed date key", () => {
    expect(() => periodContaining("monthly", "2026-13-01")).toThrow();
  });
});

describe("periodsBetween", () => {
  it("returns each month in the range, inclusive", () => {
    expect(periodsBetween("monthly", "2026-01-15", "2026-04-02").map((p) => p.key)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
  });

  it("returns a single period when both ends fall inside it", () => {
    expect(periodsBetween("monthly", "2026-07-02", "2026-07-28").map((p) => p.key)).toEqual(["2026-07"]);
  });

  it("returns consecutive Mondays for a weekly range", () => {
    expect(periodsBetween("weekly", "2026-07-01", "2026-07-28").map((p) => p.key)).toEqual([
      "2026-06-29",
      "2026-07-06",
      "2026-07-13",
      "2026-07-20",
      "2026-07-27",
    ]);
  });

  it("returns years", () => {
    expect(periodsBetween("yearly", "2024-06-01", "2026-02-01").map((p) => p.key)).toEqual([
      "2024",
      "2025",
      "2026",
    ]);
  });

  it("returns nothing when the range is inverted", () => {
    expect(periodsBetween("monthly", "2026-04-01", "2026-01-01")).toEqual([]);
  });
});

describe("spendInRange", () => {
  it("sums the category's transactions inside the range, inclusive of both ends", () => {
    const spent = spendInRange(
      [tx("2026-07-01", 1_000), tx("2026-07-31", 2_000), tx("2026-08-01", 4_000)],
      FOOD,
      "2026-07-01",
      "2026-07-31",
    );
    expect(spent).toBe(3_000);
  });

  it("ignores other categories", () => {
    expect(
      spendInRange([tx("2026-07-02", 1_000), tx("2026-07-03", 9_000, SALARY)], FOOD, "2026-07-01", "2026-07-31"),
    ).toBe(1_000);
  });

  it("ignores pending rows", () => {
    expect(
      spendInRange([tx("2026-07-02", 1_000), tx("2026-07-03", 5_000, FOOD, { pending: true })], FOOD, "2026-07-01", "2026-07-31"),
    ).toBe(1_000);
  });

  it("ignores transfers even when they carry a category", () => {
    expect(
      spendInRange(
        [tx("2026-07-02", 1_000), tx("2026-07-03", 5_000, FOOD, { transferAccountId: 2 })],
        FOOD,
        "2026-07-01",
        "2026-07-31",
      ),
    ).toBe(1_000);
  });

  it("is exact where float arithmetic drifts", () => {
    const rows = Array.from({ length: 1000 }, () => tx("2026-07-10", 10));
    expect(spendInRange(rows, FOOD, "2026-07-01", "2026-07-31")).toBe(10_000);
  });

  it("rejects a float amount", () => {
    expect(() => spendInRange([tx("2026-07-10", 10.5)], FOOD, "2026-07-01", "2026-07-31")).toThrow(
      /integer number of cents/,
    );
  });
});

describe("budgetInForce", () => {
  const older: BudgetRow = { ...monthlyFood, id: 1, limitCents: 40_000, effectiveFrom: "2026-01-01", effectiveTo: "2026-05-31" };
  const newer: BudgetRow = { ...monthlyFood, id: 2, limitCents: 60_000, effectiveFrom: "2026-06-01", effectiveTo: null };

  it("returns null before the first budget starts", () => {
    expect(budgetInForce([older, newer], FOOD, "2025-12-31")).toBeNull();
  });

  it("picks the row whose window contains the day", () => {
    expect(budgetInForce([older, newer], FOOD, "2026-03-15")!.id).toBe(1);
    expect(budgetInForce([older, newer], FOOD, "2026-07-15")!.id).toBe(2);
  });

  it("treats effectiveFrom and effectiveTo as inclusive", () => {
    expect(budgetInForce([older, newer], FOOD, "2026-01-01")!.id).toBe(1);
    expect(budgetInForce([older, newer], FOOD, "2026-05-31")!.id).toBe(1);
    expect(budgetInForce([older, newer], FOOD, "2026-06-01")!.id).toBe(2);
  });

  it("returns null for a category with no budget", () => {
    expect(budgetInForce([older, newer], SALARY, "2026-07-15")).toBeNull();
  });

  it("prefers the latest effectiveFrom when two windows overlap", () => {
    const overlapping: BudgetRow = { ...monthlyFood, id: 3, limitCents: 99_000, effectiveFrom: "2026-03-01", effectiveTo: null };
    expect(budgetInForce([older, overlapping], FOOD, "2026-04-01")!.id).toBe(3);
  });

  it("can filter by period so weekly and monthly budgets coexist", () => {
    const weekly: BudgetRow = { ...monthlyFood, id: 4, period: "weekly", limitCents: 10_000 };
    expect(budgetInForce([monthlyFood, weekly], FOOD, "2026-07-15", "weekly")!.id).toBe(4);
    expect(budgetInForce([monthlyFood, weekly], FOOD, "2026-07-15", "monthly")!.id).toBe(1);
  });
});

describe("budgetPerformance", () => {
  it("reports spend against the limit for each month in the window", () => {
    const results = budgetPerformance({
      budgets: [monthlyFood],
      transactions: [tx("2026-01-10", 30_000), tx("2026-02-10", 60_000), tx("2026-03-10", 50_000)],
      fromKey: "2026-01-01",
      toKey: "2026-03-31",
    });
    expect(results.map((r) => [r.periodKey, r.spentCents, r.remainingCents, r.overBudget])).toEqual([
      ["2026-01", 30_000, 20_000, false],
      ["2026-02", 60_000, -10_000, true],
      ["2026-03", 50_000, 0, false],
    ]);
  });

  it("reports a period with no spending as fully remaining", () => {
    const results = budgetPerformance({
      budgets: [monthlyFood],
      transactions: [],
      fromKey: "2026-02-01",
      toKey: "2026-02-28",
    });
    expect(results).toHaveLength(1);
    expect(results[0].spentCents).toBe(0);
    expect(results[0].remainingCents).toBe(50_000);
  });

  it("omits periods before the budget was in force", () => {
    const results = budgetPerformance({
      budgets: [monthlyFood],
      transactions: [],
      fromKey: "2025-11-01",
      toKey: "2026-01-31",
    });
    expect(results.map((r) => r.periodKey)).toEqual(["2026-01"]);
  });

  it("omits periods after the budget ended", () => {
    const ended: BudgetRow = { ...monthlyFood, effectiveTo: "2026-02-28" };
    const results = budgetPerformance({
      budgets: [ended],
      transactions: [],
      fromKey: "2026-01-01",
      toKey: "2026-04-30",
    });
    expect(results.map((r) => r.periodKey)).toEqual(["2026-01", "2026-02"]);
  });

  it("follows a limit change across periods", () => {
    const budgets: BudgetRow[] = [
      { ...monthlyFood, id: 1, limitCents: 40_000, effectiveFrom: "2026-01-01", effectiveTo: "2026-01-31" },
      { ...monthlyFood, id: 2, limitCents: 70_000, effectiveFrom: "2026-02-01", effectiveTo: null },
    ];
    const results = budgetPerformance({ budgets, transactions: [], fromKey: "2026-01-01", toKey: "2026-02-28" });
    expect(results.map((r) => [r.periodKey, r.limitCents, r.budgetId])).toEqual([
      ["2026-01", 40_000, 1],
      ["2026-02", 70_000, 2],
    ]);
  });

  it("allows an Income category to have a target and measures receipts against it", () => {
    const target: BudgetRow = {
      id: 9,
      categoryId: SALARY,
      period: "monthly",
      limitCents: 400_000,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      rollover: false,
    };
    const results = budgetPerformance({
      budgets: [target],
      transactions: [tx("2026-01-31", 420_000, SALARY)],
      fromKey: "2026-01-01",
      toKey: "2026-01-31",
    });
    expect(results[0].spentCents).toBe(420_000);
    expect(results[0].remainingCents).toBe(-20_000);
  });

  it("supports weekly periods", () => {
    const weekly: BudgetRow = { ...monthlyFood, period: "weekly", limitCents: 10_000, effectiveFrom: "2026-07-06" };
    const results = budgetPerformance({
      budgets: [weekly],
      transactions: [tx("2026-07-07", 4_000), tx("2026-07-14", 12_000)],
      fromKey: "2026-07-06",
      toKey: "2026-07-19",
    });
    expect(results.map((r) => [r.periodKey, r.spentCents])).toEqual([
      ["2026-07-06", 4_000],
      ["2026-07-13", 12_000],
    ]);
  });

  it("supports yearly periods", () => {
    const yearly: BudgetRow = { ...monthlyFood, period: "yearly", limitCents: 1_200_000 };
    const results = budgetPerformance({
      budgets: [yearly],
      transactions: [tx("2026-03-01", 500_000), tx("2026-11-01", 400_000)],
      fromKey: "2026-01-01",
      toKey: "2026-12-31",
    });
    expect(results).toHaveLength(1);
    expect(results[0].spentCents).toBe(900_000);
    expect(results[0].remainingCents).toBe(300_000);
  });

  it("can be filtered to one category", () => {
    const other: BudgetRow = { ...monthlyFood, id: 5, categoryId: SALARY };
    const results = budgetPerformance({
      budgets: [monthlyFood, other],
      transactions: [],
      fromKey: "2026-01-01",
      toKey: "2026-01-31",
      categoryId: FOOD,
    });
    expect(results.map((r) => r.categoryId)).toEqual([FOOD]);
  });
});

describe("budgetPerformance — one-off monthly reallocations", () => {
  const entertainment: BudgetRow = {
    ...monthlyFood,
    id: 2,
    categoryId: SALARY,
    limitCents: 20_000,
  };

  it("subtracts from the source and adds to the target while preserving the total", () => {
    const rows = spendVsBudget({
      budgets: [{ ...monthlyFood, limitCents: 10_000 }, entertainment],
      transactions: [],
      reallocations: [
        { id: 1, month: "2026-07", fromCategoryId: FOOD, toCategoryId: SALARY, amountCents: 5_000 },
      ],
      dateKey: "2026-07-15",
      period: "monthly",
    });

    expect(rows.map((row) => [row.categoryId, row.limitCents])).toEqual([
      [FOOD, 5_000],
      [SALARY, 25_000],
    ]);
    expect(rows.reduce((total, row) => total + row.limitCents, 0)).toBe(30_000);
  });

  it("applies only in its named month", () => {
    const rows = budgetPerformance({
      budgets: [{ ...monthlyFood, limitCents: 10_000 }, entertainment],
      transactions: [],
      reallocations: [
        { month: "2026-07", fromCategoryId: FOOD, toCategoryId: SALARY, amountCents: 3_000 },
      ],
      fromKey: "2026-06-01",
      toKey: "2026-08-31",
      period: "monthly",
    });
    const foodLimits = rows
      .filter((row) => row.categoryId === FOOD)
      .map((row) => [row.periodKey, row.limitCents]);
    expect(foodLimits).toEqual([
      ["2026-06", 10_000],
      ["2026-07", 7_000],
      ["2026-08", 10_000],
    ]);
  });

  it("does not alter weekly or yearly limits", () => {
    const weekly = { ...monthlyFood, period: "weekly" as const, limitCents: 10_000 };
    const rows = spendVsBudget({
      budgets: [weekly],
      transactions: [],
      reallocations: [
        { month: "2026-07", fromCategoryId: FOOD, toCategoryId: SALARY, amountCents: 3_000 },
      ],
      dateKey: "2026-07-15",
      period: "weekly",
    });
    expect(rows[0].limitCents).toBe(10_000);
  });
});

describe("budgetPerformance — rollover", () => {
  const rolling: BudgetRow = { ...monthlyFood, rollover: true };

  it("carries an unused surplus into the next period", () => {
    const results = budgetPerformance({
      budgets: [rolling],
      transactions: [tx("2026-01-10", 20_000)],
      fromKey: "2026-01-01",
      toKey: "2026-02-28",
    });
    expect(results[0].carriedInCents).toBe(0);
    expect(results[0].carriedOutCents).toBe(30_000);
    expect(results[1].carriedInCents).toBe(30_000);
    expect(results[1].availableCents).toBe(80_000);
    expect(results[1].remainingCents).toBe(80_000);
  });

  it("compounds a surplus across several periods", () => {
    const results = budgetPerformance({
      budgets: [rolling],
      transactions: [tx("2026-01-10", 40_000), tx("2026-02-10", 40_000)],
      fromKey: "2026-01-01",
      toKey: "2026-03-31",
    });
    expect(results[2].carriedInCents).toBe(20_000);
    expect(results[2].availableCents).toBe(70_000);
  });

  it("does NOT carry a deficit forward", () => {
    const results = budgetPerformance({
      budgets: [rolling],
      transactions: [tx("2026-01-10", 90_000)],
      fromKey: "2026-01-01",
      toKey: "2026-02-28",
    });
    expect(results[0].remainingCents).toBe(-40_000);
    expect(results[0].carriedOutCents).toBe(0);
    expect(results[1].carriedInCents).toBe(0);
    expect(results[1].availableCents).toBe(50_000);
  });

  it("carries nothing when rollover is off", () => {
    const results = budgetPerformance({
      budgets: [monthlyFood],
      transactions: [tx("2026-01-10", 1_000)],
      fromKey: "2026-01-01",
      toKey: "2026-02-28",
    });
    expect(results[0].carriedOutCents).toBe(0);
    expect(results[1].carriedInCents).toBe(0);
  });

  it("accrues carry-over from the budget's start even when the query window starts later", () => {
    // Jan and Feb are outside the requested window but must still build the carry.
    const results = budgetPerformance({
      budgets: [rolling],
      transactions: [tx("2026-01-10", 10_000), tx("2026-02-10", 10_000)],
      fromKey: "2026-03-01",
      toKey: "2026-03-31",
    });
    expect(results).toHaveLength(1);
    expect(results[0].periodKey).toBe("2026-03");
    expect(results[0].carriedInCents).toBe(80_000);
    expect(results[0].availableCents).toBe(130_000);
  });
});

describe("spendVsBudget", () => {
  it("returns one row per budgeted category for the period containing the day", () => {
    const budgets: BudgetRow[] = [monthlyFood, { ...monthlyFood, id: 2, categoryId: SALARY, limitCents: 400_000 }];
    const rows = spendVsBudget({
      budgets,
      transactions: [tx("2026-07-05", 12_000), tx("2026-07-06", 100_000, SALARY)],
      dateKey: "2026-07-28",
    });
    expect(rows.map((r) => [r.categoryId, r.spentCents, r.remainingCents])).toEqual([
      [FOOD, 12_000, 38_000],
      [SALARY, 100_000, 300_000],
    ]);
    expect(rows.every((r) => r.periodKey === "2026-07")).toBe(true);
  });

  it("can be asked for a past period, which the old monthly-only model could not do", () => {
    const rows = spendVsBudget({
      budgets: [monthlyFood],
      transactions: [tx("2026-01-05", 45_000), tx("2026-07-05", 1_000)],
      dateKey: "2026-01-20",
    });
    expect(rows[0].periodKey).toBe("2026-01");
    expect(rows[0].spentCents).toBe(45_000);
  });

  it("only returns budgets of the requested period type", () => {
    const weekly: BudgetRow = { ...monthlyFood, id: 7, period: "weekly", limitCents: 10_000 };
    const rows = spendVsBudget({
      budgets: [monthlyFood, weekly],
      transactions: [tx("2026-07-28", 3_000)],
      dateKey: "2026-07-28",
      period: "weekly",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].periodKey).toBe("2026-07-27");
    expect(rows[0].spentCents).toBe(3_000);
  });

  it("returns nothing when no budget is in force", () => {
    expect(spendVsBudget({ budgets: [monthlyFood], transactions: [], dateKey: "2025-06-01" })).toEqual([]);
  });
});

describe("budgetsFromLegacyLimits", () => {
  it("turns the 8 non-null categories.monthly_limit_cents values into monthly budgets", () => {
    const rows = budgetsFromLegacyLimits(
      [
        { id: 1, monthlyLimitCents: 5_000 },
        { id: 2, monthlyLimitCents: null },
        { id: 3, monthlyLimitCents: 20_000 },
      ],
      "2025-06-01",
    );
    expect(rows).toEqual([
      { id: -1, categoryId: 1, period: "monthly", limitCents: 5_000, effectiveFrom: "2025-06-01", effectiveTo: null, rollover: false },
      { id: -3, categoryId: 3, period: "monthly", limitCents: 20_000, effectiveFrom: "2025-06-01", effectiveTo: null, rollover: false },
    ]);
  });

  it("produces budgets that behave identically to the legacy monthly limit", () => {
    const rows = budgetsFromLegacyLimits([{ id: FOOD, monthlyLimitCents: 50_000 }], "2026-01-01");
    const results = budgetPerformance({
      budgets: rows,
      transactions: [tx("2026-07-05", 12_000)],
      fromKey: "2026-07-01",
      toKey: "2026-07-31",
    });
    expect(results[0].limitCents).toBe(50_000);
    expect(results[0].spentCents).toBe(12_000);
    expect(results[0].remainingCents).toBe(38_000);
  });
});
