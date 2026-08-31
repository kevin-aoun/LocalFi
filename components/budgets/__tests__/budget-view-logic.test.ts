/**
 * Tests for the pure logic behind the period-aware Budgets UI.
 *
 * WHY THIS FILE EXISTS: budgeting in this app was monthly-only, current-month-only
 * and per-category-only, and there is no jsdom in this repo, so the parts of the
 * new UI that can be wrong *arithmetically* — form transport, period selection,
 * rollover presentation, over/under classification, sorting — live in
 * `budget-view-logic.ts` and are tested here instead of through a render.
 *
 * The four hazards this file pins down:
 *   1. a limit of exactly 0 is a REAL ceiling, never "no limit";
 *   2. rollover carries a SURPLUS forward and never a DEFICIT;
 *   3. a period boundary at a month end lands on the right day in every timezone
 *      (the suite is also run at UTC+14 / UTC-11 by `bun run test:tz`);
 *   4. an Income category can NOT have a budget — a budget is a spending limit,
 *      and a paycheque is not spending. This file used to pin the opposite (an
 *      income "target"); those cases are inverted here rather than deleted, so
 *      the rule cannot quietly come back.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { budgetPerformance, periodContaining, type BudgetRow } from "@/lib/budgets";
import { formatMoney } from "@/lib/money";
import {
  NEAR_LIMIT_PERCENT,
  buildBudgetFormValues,
  budgetFormStateFrom,
  budgetableCategories,
  classifyBudgetRow,
  describeRollover,
  formatPeriodRange,
  groupHistory,
  historyRange,
  historyVerdict,
  isNearLimit,
  isOverBudget,
  periodLabel,
  previousPeriods,
  rowsForPeriodFilter,
  sortBudgetRows,
  strandedIncomeBudgets,
  summarizeBudgets,
  toBudgetFormData,
  unbudgetedCategories,
  usagePercent,
  visualBudgetUsage,
  validateBudgetForm,
  type BudgetRowView,
  type BudgetRuleFormState,
} from "../budget-view-logic";

describe("reallocation dialog safety wiring", () => {
  it("uses the unspent maximum for Max and keeps overflow feedback inside the form", () => {
    const source = readFileSync(
      path.join(process.cwd(), "components/budgets/budget-reallocation-dialog.tsx"),
      "utf8",
    );
    expect(source).toContain("getBudgetReallocationAvailability");
    expect(source).toContain("availability.maximumCents");
    expect(source).toContain("Choose a smaller amount or Max.");
    expect(source).toContain("overflowCents !== null");
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function view(over: Partial<BudgetRowView> = {}): BudgetRowView {
  const limitCents = over.limitCents ?? 50_000;
  const carriedInCents = over.carriedInCents ?? 0;
  const availableCents = over.availableCents ?? limitCents + carriedInCents;
  const spentCents = over.spentCents ?? 0;
  return {
    categoryId: 1,
    budgetId: 10,
    period: "monthly",
    periodKey: "2026-07",
    startKey: "2026-07-01",
    endKey: "2026-07-31",
    limitCents,
    carriedInCents,
    availableCents,
    spentCents,
    remainingCents: availableCents - spentCents,
    carriedOutCents: 0,
    rollover: false,
    overBudget: availableCents - spentCents < 0,
    categoryName: "Groceries",
    categoryType: "Expense",
    categoryColor: "#10b981",
    categoryIcon: "ShoppingCart",
    displayOrder: 0,
    legacy: false,
    ...over,
  };
}

const formState = (over: Partial<BudgetRuleFormState> = {}): BudgetRuleFormState => ({
  categoryId: "3",
  period: "monthly",
  limit: "500",
  effectiveFrom: "2026-07-01",
  effectiveTo: "",
  rollover: false,
  closePrevious: true,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. A limit of exactly 0
// ---------------------------------------------------------------------------

describe("a limit of exactly 0 is a real ceiling", () => {
  it("is SENT by the form, unlike a blank field which is rejected", () => {
    const values = buildBudgetFormValues(formState({ limit: "0" }));
    expect(values.limit).toBe("0");
    expect(validateBudgetForm(formState({ limit: "0" }))).toBeNull();

    // Blank is not "no limit" here: a budgets row has a NOT NULL limit, so the
    // form must refuse rather than quietly send nothing.
    expect(validateBudgetForm(formState({ limit: "" }))).toMatch(/limit/i);
    expect(validateBudgetForm(formState({ limit: "   " }))).toMatch(/limit/i);
  });

  it("survives the FormData round trip as the string \"0\"", () => {
    const fd = toBudgetFormData(formState({ limit: "0" }));
    expect(fd.get("limit")).toBe("0");
    expect(fd.has("limit")).toBe(true);
  });

  it("counts ANY spend against it as over budget, and never divides by zero", () => {
    const zero = view({ limitCents: 0, spentCents: 1 });
    expect(usagePercent(zero.spentCents, zero.availableCents)).toBe(100);
    expect(Number.isFinite(usagePercent(4500, 0))).toBe(true);
    expect(classifyBudgetRow(zero)).toBe("over");
    expect(isOverBudget(zero)).toBe(true);
  });

  it("is not over budget when nothing was spent against it", () => {
    const untouched = view({ limitCents: 0, spentCents: 0 });
    expect(usagePercent(0, 0)).toBe(0);
    expect(classifyBudgetRow(untouched)).toBe("on-track");
    expect(isOverBudget(untouched)).toBe(false);
  });

  it("shows a zero limit as $0.00, never as \"no limit\"", () => {
    // The regression this guards: `limitCents ? … : "No limit"`.
    expect(formatMoney(view({ limitCents: 0 }).limitCents)).toBe("$0.00");
  });

  it("rejects a negative limit", () => {
    expect(validateBudgetForm(formState({ limit: "-5" }))).toMatch(/negative/i);
  });
});

describe("reallocated budget is visually committed", () => {
  it("fills half the bar when half the untouched budget moved out", () => {
    expect(visualBudgetUsage(0, 5_000, 5_000)).toEqual({
      usedCents: 5_000,
      capacityCents: 10_000,
      percent: 50,
    });
  });

  it("fills the bar completely when the whole budget moved out", () => {
    expect(visualBudgetUsage(0, 0, 10_000).percent).toBe(100);
  });

  it("combines real spend and moved-out budget without changing capacity", () => {
    expect(visualBudgetUsage(2_000, 5_000, 3_000)).toEqual({
      usedCents: 5_000,
      capacityCents: 8_000,
      percent: 62.5,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Rollover: a surplus carries, a deficit does not
// ---------------------------------------------------------------------------

describe("rollover carries a surplus forward and never a deficit", () => {
  const rolling: BudgetRow = {
    id: 1,
    categoryId: 7,
    period: "monthly",
    limitCents: 10_000,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    rollover: true,
  };

  const spend = (dateKey: string, amountCents: number) => ({
    categoryId: 7,
    amountCents,
    dateKey,
    pending: false,
    accountId: 1,
    transferAccountId: null,
  });

  it("hands an unused surplus to the next period", () => {
    const rows = budgetPerformance({
      budgets: [rolling],
      transactions: [spend("2026-01-15", 4_000)],
      fromKey: "2026-01-01",
      toKey: "2026-02-28",
    });
    const [january, february] = rows;
    expect(january.carriedOutCents).toBe(6_000);
    expect(february.carriedInCents).toBe(6_000);
    expect(february.availableCents).toBe(16_000);

    const described = describeRollover({ ...view(), ...february, rollover: true });
    expect(described.enabled).toBe(true);
    expect(described.carriedInCents).toBe(6_000);
    // The carried amount must be stated, or the effective limit is a mystery.
    expect(described.carriedInLabel).toContain(formatMoney(6_000));
    expect(described.availableLabel).toContain(formatMoney(16_000));
  });

  it("does NOT carry a deficit: an overspend is absorbed, not deducted next period", () => {
    // CHOSEN SEMANTIC (matches lib/budgets.ts): carriedOut = rollover && remaining > 0
    // ? remaining : 0. Debt does not follow the user around; the next period starts
    // clean at its own limit.
    const rows = budgetPerformance({
      budgets: [rolling],
      transactions: [spend("2026-01-15", 15_000)],
      fromKey: "2026-01-01",
      toKey: "2026-02-28",
    });
    const [january, february] = rows;
    expect(january.remainingCents).toBe(-5_000);
    expect(january.carriedOutCents).toBe(0);
    expect(february.carriedInCents).toBe(0);
    expect(february.availableCents).toBe(10_000);

    const februaryView = describeRollover({ ...view(), ...february, rollover: true });
    expect(februaryView.carriedInCents).toBe(0);
    expect(februaryView.carriedInLabel).toBeNull();
    // The deficit is absorbed in the period that overspent, and stated there.
    expect(describeRollover({ ...view(), ...january, rollover: true }).deficitAbsorbed).toBe(true);
    expect(februaryView.deficitAbsorbed).toBe(false);
  });

  it("reports nothing to carry when rollover is off", () => {
    const described = describeRollover(view({ rollover: false, carriedInCents: 0 }));
    expect(described.enabled).toBe(false);
    expect(described.carriedInLabel).toBeNull();
    expect(described.carriedOutLabel).toBeNull();
  });

  it("names the surplus that will carry OUT of the current period", () => {
    const described = describeRollover(
      view({ rollover: true, limitCents: 10_000, spentCents: 2_500, carriedOutCents: 7_500 }),
    );
    expect(described.carriedOutLabel).toContain(formatMoney(7_500));
  });
});

// ---------------------------------------------------------------------------
// 3. Period boundaries, including a month end
// ---------------------------------------------------------------------------

describe("period selection at a month end", () => {
  it("keeps a monthly period inside its own calendar month", () => {
    const { fromKey, toKey } = historyRange("monthly", "2026-03-31", 3);
    expect(fromKey).toBe("2026-01-01");
    expect(toKey).toBe("2026-03-31");
  });

  it("walks back over a month end without losing or repeating a period", () => {
    const periods = previousPeriods("monthly", "2026-03-01", 3);
    expect(periods.map((p) => p.key)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(periods.map((p) => p.endKey)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("ends February on the 29th in a leap year", () => {
    expect(historyRange("monthly", "2028-02-10", 1)).toEqual({
      fromKey: "2028-02-01",
      toKey: "2028-02-29",
    });
  });

  it("lets a weekly period straddle a month end", () => {
    // 2026-03-30 is a Monday, so this week runs into April.
    const week = periodContaining("weekly", "2026-03-31");
    expect(week.startKey).toBe("2026-03-30");
    expect(week.endKey).toBe("2026-04-05");
    expect(formatPeriodRange("weekly", week.key, week.startKey, week.endKey)).toBe(
      "Mar 30 - Apr 5, 2026",
    );
  });

  it("walks weekly periods back across a month end", () => {
    const weeks = previousPeriods("weekly", "2026-04-01", 3);
    expect(weeks.map((w) => w.startKey)).toEqual(["2026-03-16", "2026-03-23", "2026-03-30"]);
  });

  it("crosses a year end", () => {
    expect(previousPeriods("monthly", "2027-01-15", 2).map((p) => p.key)).toEqual([
      "2026-12",
      "2027-01",
    ]);
    expect(historyRange("yearly", "2026-06-06", 2)).toEqual({
      fromKey: "2025-01-01",
      toKey: "2026-12-31",
    });
  });

  it("labels every period type readably", () => {
    expect(formatPeriodRange("monthly", "2026-03", "2026-03-01", "2026-03-31")).toBe("Mar 2026");
    expect(formatPeriodRange("yearly", "2026", "2026-01-01", "2026-12-31")).toBe("2026");
    expect(periodLabel("weekly")).toBe("Weekly");
    expect(periodLabel("monthly")).toBe("Monthly");
    expect(periodLabel("yearly")).toBe("Yearly");
  });

  it("demands at least one period", () => {
    expect(() => previousPeriods("monthly", "2026-03-01", 0)).toThrow(/at least one/i);
  });

  it("rejects a malformed day rather than guessing", () => {
    expect(() => previousPeriods("monthly", "not-a-day", 3)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. An Income category can NOT have a budget
// ---------------------------------------------------------------------------

/**
 * These cases are the INVERSE of the ones that used to live here. A budget is a
 * spending limit; income is not spending, so the "income target" idea is gone —
 * both as a thing that can be created and as a status that can be displayed.
 *
 * The rows below can therefore only exist in a hand-edited database or in a row
 * written before the rule. The view layer's job is to ignore them visibly, never
 * to fold them into a spending total.
 */
const incomeCategories = [
  { id: 1, name: "Groceries", type: "Expense" },
  { id: 9, name: "Salary", type: "Income" },
  { id: 12, name: "Index fund", type: "Investment" },
];

describe("an Income category can NOT have a budget", () => {
  it("REFUSES an Income budget in the form, naming the category", () => {
    // Was: "accepts an Income budget in the form".
    const state = formState({ categoryId: "9", limit: "4000" });
    const refusal = validateBudgetForm(state, incomeCategories);
    expect(refusal).toMatch(/Salary/);
    expect(refusal).toMatch(/can't have a budget/i);
    expect(refusal).toMatch(/spending limit/i);

    // A spending category with the same form still passes.
    expect(validateBudgetForm(formState({ categoryId: "1" }), incomeCategories)).toBeNull();
    expect(validateBudgetForm(formState({ categoryId: "12" }), incomeCategories)).toBeNull();
  });

  it("never offers an Income category to choose from", () => {
    expect(budgetableCategories(incomeCategories).map((c) => c.id)).toEqual([1, 12]);
  });

  it("classifies a stray Income row as IGNORED, not as over budget", () => {
    // Was: "reads a target as met or short". There is no target any more; a row
    // that somehow exists is ignored, and ignoring is not an alarm either.
    const above = view({ categoryType: "Income", limitCents: 400_000, spentCents: 420_000 });
    const below = view({ categoryType: "Income", limitCents: 400_000, spentCents: 100_000 });

    expect(classifyBudgetRow(above)).toBe("ignored");
    expect(classifyBudgetRow(below)).toBe("ignored");
    expect(isOverBudget(above)).toBe(false);
    expect(isOverBudget(below)).toBe(false);
    // `below` has spent 25% of its "limit"; `above` has blown through it. Neither
    // is a near-limit warning, because neither is a limit.
    expect(isNearLimit(above)).toBe(false);
    expect(isNearLimit(below)).toBe(false);
  });

  it("ignores an Income row whatever its numbers, including an exact match", () => {
    // Was: "treats exactly hitting the target as met".
    expect(
      classifyBudgetRow(view({ categoryType: "Income", limitCents: 1_000, spentCents: 1_000 })),
    ).toBe("ignored");
    expect(
      classifyBudgetRow(view({ categoryType: "Income", limitCents: 0, spentCents: 0 })),
    ).toBe("ignored");
  });

  it("keeps a stray Income row out of EVERY summary figure, and says so", () => {
    // Was: "keeps income out of the over/near counts but reports it separately"
    // — as an income target. Now it is reported as something to remove.
    const summary = summarizeBudgets([
      view({ categoryId: 1, categoryType: "Expense", limitCents: 10_000, spentCents: 12_000 }),
      view({ categoryId: 2, categoryType: "Expense", limitCents: 10_000, spentCents: 9_000 }),
      view({ categoryId: 3, categoryType: "Income", limitCents: 100_000, spentCents: 120_000 }),
      view({ categoryId: 4, categoryType: "Income", limitCents: 100_000, spentCents: 20_000 }),
    ]);
    // Only the two spending rows are budgets at all.
    expect(summary.trackedCount).toBe(2);
    expect(summary.overCount).toBe(1);
    expect(summary.nearCount).toBe(1); // 9,000 / 10,000 = 90%
    // The 200,000 of income "limits" and 140,000 of receipts appear nowhere:
    // counting a paycheque as spending is the exact failure this guards.
    expect(summary.totalLimitCents).toBe(20_000);
    expect(summary.totalAvailableCents).toBe(20_000);
    expect(summary.totalSpentCents).toBe(21_000);
    expect(summary.totalRemainingCents).toBe(-1_000);
    expect(summary.ignoredIncomeCount).toBe(2);
  });

  it("reports no ignored rows in the normal case", () => {
    const summary = summarizeBudgets([
      view({ categoryId: 1, categoryType: "Expense" }),
      view({ categoryId: 2, categoryType: "Investment" }),
    ]);
    expect(summary.ignoredIncomeCount).toBe(0);
    expect(summary.trackedCount).toBe(2);
  });

  it("gives a stray Income period no verdict rather than a false one", () => {
    // Was: "verdicts an income period as met or short".
    const marchIncome = (spentCents: number) =>
      view({
        categoryType: "Income",
        limitCents: 100_000,
        spentCents,
        periodKey: "2026-03",
        startKey: "2026-03-01",
        endKey: "2026-03-31",
      });
    for (const spent of [120_000, 40_000]) {
      const verdict = historyVerdict(marchIncome(spent), "2026-07-28");
      expect(verdict).toMatchObject({ status: "ignored", deltaCents: 0, inProgress: false });
      expect(verdict.label).toMatch(/ignored/i);
      // Never "Over by …": that would read a paycheque as an overspend.
      expect(verdict.label).not.toMatch(/over/i);
    }
  });

  it("keeps a stray Income row out of a history period's tally", () => {
    const groups = groupHistory([
      view({
        categoryId: 1,
        categoryName: "Groceries",
        periodKey: "2026-03",
        startKey: "2026-03-01",
        endKey: "2026-03-31",
        limitCents: 50_000,
        spentCents: 42_000,
      }),
      view({
        categoryId: 9,
        categoryName: "Salary",
        categoryType: "Income",
        periodKey: "2026-03",
        startKey: "2026-03-01",
        endKey: "2026-03-31",
        limitCents: 400_000,
        spentCents: 500_000,
      }),
    ]);
    expect(groups).toHaveLength(1);
    // The row is still listed — hiding it would make it unfindable — but it
    // contributes to nothing.
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[0].overCount).toBe(0);
    expect(groups[0].totalLimitCents).toBe(50_000);
    expect(groups[0].totalSpentCents).toBe(42_000);
  });

  it("finds budget rows stranded on an income category so the page can offer to delete them", () => {
    const stranded = strandedIncomeBudgets(
      [
        { id: 1, categoryId: 1, period: "monthly" as const },
        { id: 2, categoryId: 9, period: "monthly" as const },
      ],
      incomeCategories,
    );
    expect(stranded.map((b) => [b.id, b.categoryName])).toEqual([[2, "Salary"]]);
  });

  it("finds nothing to strand when no income category has a budget", () => {
    expect(
      strandedIncomeBudgets([{ id: 1, categoryId: 12, period: "yearly" as const }], incomeCategories),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Classification, summary and sorting
// ---------------------------------------------------------------------------

describe("over-budget and near-limit classification", () => {
  it("flags over budget only when the remainder is negative", () => {
    expect(classifyBudgetRow(view({ limitCents: 10_000, spentCents: 10_001 }))).toBe("over");
    // Spending the limit exactly is not over.
    expect(classifyBudgetRow(view({ limitCents: 10_000, spentCents: 10_000 }))).toBe("near");
  });

  it("flags near limit at the threshold, not before", () => {
    expect(NEAR_LIMIT_PERCENT).toBe(80);
    expect(classifyBudgetRow(view({ limitCents: 10_000, spentCents: 7_999 }))).toBe("on-track");
    expect(classifyBudgetRow(view({ limitCents: 10_000, spentCents: 8_000 }))).toBe("near");
  });

  it("measures usage against the AVAILABLE amount, so a carried surplus counts", () => {
    const row = view({ limitCents: 10_000, carriedInCents: 10_000, spentCents: 12_000 });
    expect(row.availableCents).toBe(20_000);
    expect(usagePercent(row.spentCents, row.availableCents)).toBe(60);
    expect(classifyBudgetRow(row)).toBe("on-track");
  });

  it("caps nothing: the raw percentage is reported for the caller to clamp", () => {
    expect(usagePercent(20_000, 10_000)).toBe(200);
  });
});

describe("sorting puts manual order first, then problems", () => {
  it("puts the saved card order ahead of urgency", () => {
    const over = view({ categoryName: "Urgent", spentCents: 60_000, displayOrder: 2 });
    const calm = view({ categoryName: "Calm", budgetId: 11, displayOrder: 1 });
    expect(sortBudgetRows([over, calm]).map((row) => row.categoryName)).toEqual(["Calm", "Urgent"]);
  });

  it("orders over budget, then near limit, then by usage, then by name", () => {
    const rows = [
      view({ categoryId: 1, categoryName: "Travel", limitCents: 10_000, spentCents: 1_000 }),
      view({ categoryId: 2, categoryName: "Rent", limitCents: 10_000, spentCents: 12_000 }),
      view({ categoryId: 3, categoryName: "Coffee", limitCents: 10_000, spentCents: 9_000 }),
      view({ categoryId: 4, categoryName: "Books", limitCents: 10_000, spentCents: 1_000 }),
    ];
    expect(sortBudgetRows(rows).map((r) => r.categoryName)).toEqual([
      "Rent",
      "Coffee",
      "Books",
      "Travel",
    ]);
  });

  it("does not mutate its input", () => {
    const rows = [
      view({ categoryId: 1, categoryName: "B", spentCents: 0 }),
      view({ categoryId: 2, categoryName: "A", spentCents: 90_000 }),
    ];
    const before = rows.map((r) => r.categoryName);
    sortBudgetRows(rows);
    expect(rows.map((r) => r.categoryName)).toEqual(before);
  });

  it("sorts a stray ignored income row last, so real budgets stay at the top", () => {
    const rows = [
      view({ categoryId: 1, categoryName: "Salary", categoryType: "Income", spentCents: 0 }),
      view({ categoryId: 2, categoryName: "Zebra food", categoryType: "Expense", spentCents: 0 }),
    ];
    expect(sortBudgetRows(rows).map((r) => r.categoryName)).toEqual(["Zebra food", "Salary"]);
  });
});

describe("filtering by period type", () => {
  const rows = [
    view({ categoryId: 1, period: "weekly" }),
    view({ categoryId: 2, period: "monthly" }),
    view({ categoryId: 3, period: "yearly" }),
  ];

  it("passes everything through for \"all\"", () => {
    expect(rowsForPeriodFilter(rows, "all")).toHaveLength(3);
  });

  it("keeps only the requested period", () => {
    expect(rowsForPeriodFilter(rows, "weekly").map((r) => r.categoryId)).toEqual([1]);
    expect(rowsForPeriodFilter(rows, "yearly").map((r) => r.categoryId)).toEqual([3]);
  });
});

describe("categories with no budget are listed, not hidden", () => {
  const categories = [
    { id: 1, name: "Groceries", type: "Expense" },
    { id: 2, name: "Salary", type: "Income" },
    { id: 3, name: "Coffee", type: "Expense" },
    { id: 4, name: "Index fund", type: "Investment" },
  ];

  it("returns the categories that have no row this period", () => {
    const missing = unbudgetedCategories(categories, [view({ categoryId: 1 })]);
    // Was [2, 3]: Salary used to be invited to take a budget. It no longer is —
    // the invitation led to an action that now refuses.
    expect(missing.map((c) => c.id)).toEqual([3, 4]);
  });

  it("never invites an Income category, even when nothing is budgeted at all", () => {
    expect(unbudgetedCategories(categories, []).map((c) => c.id)).toEqual([1, 3, 4]);
    expect(unbudgetedCategories(categories, []).some((c) => c.type === "Income")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Historical performance
// ---------------------------------------------------------------------------

describe("historical performance answers \"did I stay under in March?\"", () => {
  const march = view({
    categoryId: 1,
    categoryName: "Groceries",
    periodKey: "2026-03",
    startKey: "2026-03-01",
    endKey: "2026-03-31",
    limitCents: 50_000,
    spentCents: 42_000,
  });
  const april = view({
    categoryId: 1,
    categoryName: "Groceries",
    periodKey: "2026-04",
    startKey: "2026-04-01",
    endKey: "2026-04-30",
    limitCents: 50_000,
    spentCents: 61_000,
  });

  it("says under, by how much", () => {
    expect(historyVerdict(march, "2026-07-28")).toMatchObject({
      status: "under",
      deltaCents: 8_000,
      inProgress: false,
    });
    expect(historyVerdict(march, "2026-07-28").label).toContain(formatMoney(8_000));
  });

  it("says over, by how much", () => {
    expect(historyVerdict(april, "2026-07-28")).toMatchObject({ status: "over", deltaCents: 11_000 });
  });

  it("says exactly on budget when the remainder is zero", () => {
    const spentToTheCent = view({
      categoryId: 1,
      periodKey: "2026-03",
      startKey: "2026-03-01",
      endKey: "2026-03-31",
      limitCents: 50_000,
      spentCents: 50_000,
    });
    expect(spentToTheCent.remainingCents).toBe(0);
    expect(historyVerdict(spentToTheCent, "2026-07-28").status).toBe("exact");
  });

  it("marks the period still running as in progress", () => {
    const current = { ...march, periodKey: "2026-07", startKey: "2026-07-01", endKey: "2026-07-31" };
    expect(historyVerdict(current, "2026-07-28").inProgress).toBe(true);
    // The last day of the period is still in progress; the day after is not.
    expect(historyVerdict(current, "2026-07-31").inProgress).toBe(true);
    expect(historyVerdict(current, "2026-08-01").inProgress).toBe(false);
  });

  it("groups periods newest first with a per-period tally", () => {
    const groups = groupHistory([
      march,
      april,
      view({
        categoryId: 2,
        categoryName: "Coffee",
        periodKey: "2026-03",
        startKey: "2026-03-01",
        endKey: "2026-03-31",
        limitCents: 10_000,
        spentCents: 11_000,
      }),
    ]);
    expect(groups.map((g) => g.periodKey)).toEqual(["2026-04", "2026-03"]);
    const [aprilGroup, marchGroup] = groups;
    expect(aprilGroup.overCount).toBe(1);
    expect(marchGroup.rows.map((r) => r.categoryName)).toEqual(["Coffee", "Groceries"]);
    expect(marchGroup.overCount).toBe(1);
    expect(marchGroup.totalLimitCents).toBe(60_000);
    expect(marchGroup.totalSpentCents).toBe(53_000);
    expect(marchGroup.label).toBe("Mar 2026");
  });

  it("returns nothing for no rows", () => {
    expect(groupHistory([])).toEqual([]);
    expect(summarizeBudgets([])).toMatchObject({ trackedCount: 0, overCount: 0, nearCount: 0 });
  });
});

// ---------------------------------------------------------------------------
// Form transport
// ---------------------------------------------------------------------------

describe("form -> FormData transport", () => {
  it("sends every field the server action reads", () => {
    const values = buildBudgetFormValues(
      formState({ effectiveTo: "2026-12-31", rollover: true, closePrevious: false }),
    );
    expect(values).toEqual({
      categoryId: "3",
      period: "monthly",
      limit: "500",
      effectiveFrom: "2026-07-01",
      effectiveTo: "2026-12-31",
      rollover: "true",
      closePrevious: "false",
    });
  });

  it("sends effectiveTo as an EMPTY string so an end date can be cleared", () => {
    // `updateBudget` only touches a field when `formData.has(...)`, and reads ""
    // as null. Omitting the key would make "open-ended again" unrepresentable.
    const fd = toBudgetFormData(formState({ effectiveTo: "" }));
    expect(fd.has("effectiveTo")).toBe(true);
    expect(fd.get("effectiveTo")).toBe("");
  });

  it("sends rollover as the literal strings the action compares against", () => {
    expect(buildBudgetFormValues(formState({ rollover: true })).rollover).toBe("true");
    expect(buildBudgetFormValues(formState({ rollover: false })).rollover).toBe("false");
  });

  it("trims the limit but keeps it a decimal string, never cents", () => {
    expect(buildBudgetFormValues(formState({ limit: " 12.50 " })).limit).toBe("12.50");
  });

  it("refuses an inverted effective window", () => {
    expect(
      validateBudgetForm(formState({ effectiveFrom: "2026-07-01", effectiveTo: "2026-06-30" })),
    ).toMatch(/before/i);
  });

  it("refuses a missing category and a malformed date", () => {
    expect(validateBudgetForm(formState({ categoryId: "" }))).toMatch(/category/i);
    expect(validateBudgetForm(formState({ categoryId: "0" }))).toMatch(/category/i);
    expect(validateBudgetForm(formState({ effectiveFrom: "2026-13-01" }))).toMatch(/start/i);
    expect(validateBudgetForm(formState({ effectiveTo: "31/12/2026" }))).toMatch(/end/i);
  });

  it("accepts an open-ended window", () => {
    expect(validateBudgetForm(formState({ effectiveTo: "" }))).toBeNull();
  });
});

describe("editing an existing budget round-trips through the form", () => {
  it("loads cents as a decimal string and keeps a 0 limit visible", () => {
    const state = budgetFormStateFrom(
      {
        id: 4,
        categoryId: 6,
        period: "weekly",
        limitCents: 0,
        effectiveFrom: "2026-01-05",
        effectiveTo: null,
        rollover: true,
      },
      "2026-07-28",
    );
    expect(state).toEqual({
      categoryId: "6",
      period: "weekly",
      limit: "0",
      effectiveFrom: "2026-01-05",
      effectiveTo: "",
      rollover: true,
      closePrevious: false,
    });
    // The transport must still carry the zero.
    expect(buildBudgetFormValues(state).limit).toBe("0");
  });

  it("defaults a new budget to the start of the current period", () => {
    const state = budgetFormStateFrom(null, "2026-07-28");
    expect(state.period).toBe("monthly");
    expect(state.effectiveFrom).toBe("2026-07-01");
    expect(state.effectiveTo).toBe("");
    expect(state.rollover).toBe(false);
    expect(state.closePrevious).toBe(true);
    expect(state.limit).toBe("");
    expect(state.categoryId).toBe("");
  });

  it("uses the local calendar day, not a UTC one, for that default", () => {
    // Guard for the off-by-one-day class of bug: at UTC+14 and UTC-11 (see
    // `bun run test:tz`) a toISOString()-derived default would land in the wrong
    // month here.
    expect(budgetFormStateFrom(null, "2026-03-01").effectiveFrom).toBe("2026-03-01");
    expect(budgetFormStateFrom(null, "2026-12-31").effectiveFrom).toBe("2026-12-01");
  });

  it("converts a real cents amount to a decimal string", () => {
    const state = budgetFormStateFrom(
      {
        id: 5,
        categoryId: 2,
        period: "monthly",
        limitCents: 123_456,
        effectiveFrom: "2026-02-01",
        effectiveTo: "2026-11-30",
        rollover: false,
      },
      "2026-07-28",
    );
    expect(state.limit).toBe("1234.56");
    expect(state.effectiveTo).toBe("2026-11-30");
  });
});

// ---------------------------------------------------------------------------
// Source-level guards for the parts a unit test cannot render
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(PROJECT_ROOT, rel), "utf-8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

const BUDGET_UI = [
  "app/(dashboard)/budgets/budgets-client.tsx",
  "app/(dashboard)/budgets/page.tsx",
  "components/budgets/budget-rule-dialog.tsx",
  "components/budgets/budget-view-logic.ts",
];

describe("the Budgets UI keeps the house conventions", () => {
  for (const file of BUDGET_UI) {
    it(`${file} never serializes a calendar day through UTC`, () => {
      expect(stripComments(read(file))).not.toMatch(/toISOString\(\)/);
    });

    it(`${file} formats money through lib/money, not toFixed`, () => {
      expect(stripComments(read(file))).not.toMatch(/toFixed\(2\)/);
    });
  }

  it("the budget dialog surfaces the action's { error } and stays open", () => {
    const source = read("components/budgets/budget-rule-dialog.tsx");
    expect(source).toMatch(/"error"\s+in\s+\w+/);
    expect(source).toMatch(/setError\(/);
    expect(source).toMatch(/role="alert"/);
    const guard = source.indexOf('"error" in result');
    const success = source.indexOf("onSuccess();");
    expect(guard).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(guard);
  });

  it("the budget dialog never offers an Income category", () => {
    const source = stripComments(read("components/budgets/budget-rule-dialog.tsx"));
    // The dropdown must be fed the filtered list, not the raw one.
    expect(source).toMatch(/budgetableCategories\(categories\)/);
    expect(source).toMatch(/selectableCategories\.map/);
    expect(source).not.toMatch(/\{categories\.map/);
    // And the target vocabulary is gone: there is no such thing any more.
    expect(source).not.toMatch(/isTargetCategory/);
    expect(source).not.toMatch(/Income to reach/);
  });

  it("the page neither renders nor invites an Income budget", () => {
    const source = stripComments(read("app/(dashboard)/budgets/budgets-client.tsx"));
    // The "no budget yet" strip comes from `unbudgetedCategories`, which drops
    // Income, and the New Budget buttons are gated on the filtered list.
    expect(source).toMatch(/unbudgetedCategories\(initialCategories, currentRows\)/);
    expect(source).toMatch(/budgetableCategories\(initialCategories\)/);
    expect(source).not.toMatch(/disabled=\{initialCategories\.length === 0\}/);
    // No trace of the old income-target presentation.
    expect(source).not.toMatch(/target-met|target-short|incomeTargetCents|incomeMetCount/);
    // A stranded row is reported rather than counted.
    expect(source).toMatch(/strandedIncomeBudgets/);
    expect(source).toMatch(/role="status"/);
  });

  it("the create/update actions refuse an Income budget themselves", () => {
    // The UI is not the only caller: server-side projections reach these
    // actions directly, so the gate has to live here.
    const source = stripComments(read("app/actions/budgets/mutations.ts"));
    expect(source).toMatch(/incomeBudgetRefusal/);
    expect(source).toMatch(/category\.type === "Income"/);
  });

  it("the page surfaces a failed budget delete or legacy import", () => {
    const source = read("app/(dashboard)/budgets/budgets-client.tsx");
    expect(source).toMatch(/"error"\s+in\s+\w+/);
    expect(source).toMatch(/role="alert"/);
  });

  it("the page still manages categories", () => {
    const source = read("app/(dashboard)/budgets/budgets-client.tsx");
    expect(source).toMatch(/deleteCategory/);
    expect(source).toMatch(/BudgetDialog/);
  });

  it("the page uses the tested engine instead of re-deriving spend", () => {
    const source = read("app/(dashboard)/budgets/page.tsx");
    expect(source).toMatch(/getSpendVsBudget/);
    expect(source).toMatch(/getBudgetHistory/);
  });

  it("the reallocation dialog offers 25%, 50%, and a ledger-safe Max shortcut", () => {
    const source = stripComments(read("components/budgets/budget-reallocation-dialog.tsx"));
    expect(source).toMatch(/label:\s*"25%",\s*value:\s*"25"/);
    expect(source).toMatch(/label:\s*"50%",\s*value:\s*"50"/);
    expect(source).toMatch(/availability\.maximumCents/);
    expect(source).toMatch(/setInputMode\("percentage"\)/);
    expect(source).toMatch(/aria-pressed=\{selected\}/);
    expect(source).toMatch(/disabled=\{!fromCategoryId \|\| loading \|\| availabilityLoading/);
    expect(source).toMatch(/Quick move from \$\{selectedSource\.name\}/);
    expect(source).toMatch(/Choose the source category before selecting a percentage/);
  });

  it("the reallocation dialog uses the shadcn calendar instead of a native month input", () => {
    const source = stripComments(read("components/budgets/budget-reallocation-dialog.tsx"));
    expect(source).toMatch(/from\s+"@\/components\/ui\/calendar"/);
    expect(source).toMatch(/from\s+"@\/components\/ui\/popover"/);
    expect(source).toMatch(/<Calendar[\s\S]*mode="single"/);
    expect(source).toMatch(/setMonth\(monthKey\(date\)\)/);
    expect(source).toMatch(/fromMonthKey\(month\)/);
    expect(source).not.toMatch(/type="month"/);
    expect(source).not.toMatch(/toISOString\(\)/);
  });
});
