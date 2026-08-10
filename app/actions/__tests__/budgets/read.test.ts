/**
 * Budget actions: spend-vs-budget for an arbitrary period, historical
 * performance, rollover, weekly/annual periods, and the legacy
 * `categories.monthly_limit_cents` fallback.
 *
 * The three things the old model could not do at all, pinned here:
 *   1. ask about a PAST period;
 *   2. use a period other than a calendar month;
 *   3. carry an unused surplus forward.
 *
 * And the rule the actions enforce, pinned in "an Income category cannot have a
 * budget" below: a budget is a SPENDING LIMIT, so income cannot hold one. This
 * file used to assert the opposite (an income "target" was accepted and
 * measured); those cases are inverted rather than deleted. The gate lives in the
 * action, not the dialog, because POST /api/agent and the CLI call these
 * functions directly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDomainDb,
  form,
  seedAccount,
  seedBudget,
  seedCategory,
  seedTransaction,
  type DomainDb,
} from "../support/domain-fixture";
import {
  createBudget,
  getCategorySpend,
  getBudgetHistory,
  getBudgetsForCategory,
  getSpendVsBudget,
} from "@/app/actions/budgets";
import { createTransfer } from "@/app/actions/transactions";

const FOOD = 1;
const SALARY = 2;
const TRANSPORT = 3;
const INTEREST = 4;

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  seedAccount(temp, { id: 2, name: "Savings", kind: "asset", type: "Savings" });
  seedCategory(temp, { id: FOOD, name: "Food", type: "Expense" });
  seedCategory(temp, { id: SALARY, name: "Salary", type: "Income" });
  seedCategory(temp, { id: TRANSPORT, name: "Transport", type: "Expense" });
  seedCategory(temp, { id: INTEREST, name: "Interest", type: "Expense" });
});

afterEach(async () => {
  await temp.cleanup();
});

function unwrap<T>(result: { success: true; data: T } | { error: string }): T {
  if ("error" in result) throw new Error(`action failed: ${result.error}`);
  return result.data;
}

function spend(dateKey: string, amountCents: number, categoryId = FOOD, extra: Record<string, unknown> = {}) {
  seedTransaction(temp, { categoryId, accountId: 1, amountCents, dateKey, ...extra });
}
describe("createBudget", () => {
  it("creates a monthly budget with an exact cents limit", async () => {
    const budget = unwrap(
      await createBudget(form({ categoryId: FOOD, period: "monthly", limit: "500.00", effectiveFrom: "2026-01-01" })),
    );
    expect(budget.limitCents).toBe(50_000);
    expect(budget.period).toBe("monthly");
    expect(budget.effectiveTo).toBeNull();
    expect(budget.rollover).toBe(false);
    expect(temp.query("SELECT typeof(limit_cents) t FROM budgets")[0].t).toBe("integer");
  });

  it("REFUSES a budget on an INCOME category", async () => {
    // Was: "allows a target on an INCOME category".
    const result = await createBudget(
      form({ categoryId: SALARY, period: "monthly", limit: "4000.00", effectiveFrom: "2026-01-01" }),
    );
    expect(result).toMatchObject({
      error: expect.stringMatching(/can't have a budget/i),
    });
    expect(result).toMatchObject({ error: expect.stringMatching(/spending limit/i) });
    expect(result).toMatchObject({ error: expect.stringMatching(/Salary/) });
    // Nothing was written.
    expect(await getBudgetsForCategory(SALARY)).toEqual([]);
    expect(temp.scalar("SELECT COUNT(*) FROM budgets")).toBe(0);
  });

  it("allows weekly and yearly periods", async () => {
    expect(unwrap(await createBudget(form({ categoryId: FOOD, period: "weekly", limit: "100.00", effectiveFrom: "2026-01-05" }))).period).toBe("weekly");
    expect(unwrap(await createBudget(form({ categoryId: TRANSPORT, period: "yearly", limit: "1200.00", effectiveFrom: "2026-01-01" }))).period).toBe("yearly");
  });

  it("closes the previously-open budget the day before the new one starts", async () => {
    unwrap(await createBudget(form({ categoryId: FOOD, period: "monthly", limit: "400.00", effectiveFrom: "2026-01-01" })));
    unwrap(await createBudget(form({ categoryId: FOOD, period: "monthly", limit: "600.00", effectiveFrom: "2026-06-01" })));

    const rows = await getBudgetsForCategory(FOOD);
    expect(rows.map((r) => [r.limitCents, r.effectiveFrom, r.effectiveTo])).toEqual([
      [40_000, "2026-01-01", "2026-05-31"],
      [60_000, "2026-06-01", null],
    ]);
  });

  it("keeps both rows open when closePrevious is false", async () => {
    unwrap(await createBudget(form({ categoryId: FOOD, period: "monthly", limit: "400.00", effectiveFrom: "2026-01-01" })));
    unwrap(await createBudget(form({ categoryId: FOOD, period: "monthly", limit: "600.00", effectiveFrom: "2026-06-01", closePrevious: false })));
    expect((await getBudgetsForCategory(FOOD)).every((r) => r.effectiveTo === null)).toBe(true);
  });

  it("does not close a budget of a DIFFERENT period", async () => {
    unwrap(await createBudget(form({ categoryId: FOOD, period: "weekly", limit: "100.00", effectiveFrom: "2026-01-05" })));
    unwrap(await createBudget(form({ categoryId: FOOD, period: "monthly", limit: "500.00", effectiveFrom: "2026-06-01" })));
    const weekly = (await getBudgetsForCategory(FOOD)).find((r) => r.period === "weekly")!;
    expect(weekly.effectiveTo).toBeNull();
  });

  it("rejects an unknown category, an inverted window and an unknown period", async () => {
    expect(await createBudget(form({ categoryId: 99, period: "monthly", limit: "1.00", effectiveFrom: "2026-01-01" }))).toMatchObject({
      error: expect.stringMatching(/No category with id 99/),
    });
    expect(await createBudget(form({ categoryId: FOOD, period: "monthly", limit: "1.00", effectiveFrom: "2026-06-01", effectiveTo: "2026-01-01" }))).toMatchObject({
      error: expect.stringMatching(/end date/i),
    });
    expect(await createBudget(form({ categoryId: FOOD, period: "fortnightly", limit: "1.00", effectiveFrom: "2026-01-01" }))).toMatchObject({
      error: expect.stringMatching(/Invalid budget period/),
    });
  });
});

describe("getSpendVsBudget", () => {
  beforeEach(() => {
    seedBudget(temp, { id: 1, categoryId: FOOD, period: "monthly", limitCents: 50_000, effectiveFrom: "2026-01-01" });
  });

  it("measures the current period", async () => {
    spend("2026-07-05", 12_000);
    spend("2026-07-20", 8_000);
    const rows = await getSpendVsBudget({ dateKey: "2026-07-28" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      categoryId: FOOD,
      categoryName: "Food",
      periodKey: "2026-07",
      spentCents: 20_000,
      remainingCents: 30_000,
      overBudget: false,
      legacy: false,
    });
  });

  it("answers for a PAST period — impossible in the old model", async () => {
    spend("2026-01-05", 45_000);
    spend("2026-07-05", 1_000);
    const rows = await getSpendVsBudget({ dateKey: "2026-01-20" });
    expect(rows[0].periodKey).toBe("2026-01");
    expect(rows[0].spentCents).toBe(45_000);
  });

  it("flags an over-budget period", async () => {
    spend("2026-07-05", 70_000);
    const rows = await getSpendVsBudget({ dateKey: "2026-07-28" });
    expect(rows[0].remainingCents).toBe(-20_000);
    expect(rows[0].overBudget).toBe(true);
  });

  it("does not count a transfer as spend", async () => {
    spend("2026-07-05", 12_000);
    seedTransaction(temp, { accountId: 1, transferAccountId: 2, amountCents: 100_000, dateKey: "2026-07-06" });
    expect((await getSpendVsBudget({ dateKey: "2026-07-28" }))[0].spentCents).toBe(12_000);
  });

  it("does not count a pending row as spend", async () => {
    spend("2026-07-05", 12_000);
    spend("2026-07-06", 40_000, FOOD, { pending: true });
    expect((await getSpendVsBudget({ dateKey: "2026-07-28" }))[0].spentCents).toBe(12_000);
  });

  it("counts split liability interest once in budget actuals and category spend", async () => {
    seedAccount(temp, { id: 4, name: "Card", kind: "liability", type: "CreditCard" });
    seedBudget(temp, { id: 40, categoryId: INTEREST, period: "monthly", limitCents: 10_000, effectiveFrom: "2026-07-01" });
    expect(await createTransfer(form({
      fromAccountId: 1,
      toAccountId: 4,
      amount: "110.00",
      principalAmount: "100.00",
      interestCategoryId: INTEREST,
      date: "2026-07-10T00:00:00",
    }))).toMatchObject({ success: true });
    seedTransaction(temp, { categoryId: INTEREST, accountId: 1, amountCents: 40_000, dateKey: "2026-07-11", pending: true });
    seedTransaction(temp, { accountId: 1, transferAccountId: 2, amountCents: 50_000, dateKey: "2026-07-12" });

    const budgetRow = (await getSpendVsBudget({ dateKey: "2026-07-28", categoryId: INTEREST }))[0];
    const categorySpend = await getCategorySpend({ dateKey: "2026-07-28" });
    expect(budgetRow.spentCents).toBe(1_000);
    expect(categorySpend[INTEREST]).toBe(1_000);
  });

  it("ignores spend that falls outside the period", async () => {
    spend("2026-06-30", 40_000);
    spend("2026-08-01", 40_000);
    spend("2026-07-01", 1_000);
    spend("2026-07-31", 2_000);
    expect((await getSpendVsBudget({ dateKey: "2026-07-15" }))[0].spentCents).toBe(3_000);
  });

  it("returns nothing before the budget takes effect", async () => {
    expect(await getSpendVsBudget({ dateKey: "2025-11-15" })).toEqual([]);
  });

  it("can be filtered to one category and one period type", async () => {
    seedBudget(temp, { id: 2, categoryId: FOOD, period: "weekly", limitCents: 10_000, effectiveFrom: "2026-01-01" });
    seedBudget(temp, { id: 3, categoryId: TRANSPORT, period: "monthly", limitCents: 30_000, effectiveFrom: "2026-01-01" });
    spend("2026-07-28", 3_000);

    const weekly = await getSpendVsBudget({ dateKey: "2026-07-28", period: "weekly" });
    expect(weekly).toHaveLength(1);
    expect(weekly[0].periodKey).toBe("2026-07-27");

    const onlyFood = await getSpendVsBudget({ dateKey: "2026-07-28", categoryId: FOOD });
    expect(new Set(onlyFood.map((r) => r.categoryId))).toEqual(new Set([FOOD]));
  });

  it("IGNORES a budget row stranded on an income category", async () => {
    // Was: "measures an income target against receipts". `createBudget` can no
    // longer produce this row, so it is seeded straight into the table — a
    // hand-edited database, or a row written before the rule.
    seedBudget(temp, { id: 2, categoryId: SALARY, period: "monthly", limitCents: 400_000, effectiveFrom: "2026-01-01" });
    spend("2026-07-25", 380_000, SALARY);

    const rows = await getSpendVsBudget({ dateKey: "2026-07-28" });
    // Not measured at all: a paycheque compared against a "limit" would show up
    // in the page's over/near totals and in the agent's budget_status answer.
    expect(rows.find((r) => r.categoryId === SALARY)).toBeUndefined();
    // The other budgets are unaffected.
    expect(rows.map((r) => r.categoryId)).toEqual([FOOD]);
    // The row itself is left alone, so the page can report and delete it.
    expect((await getBudgetsForCategory(SALARY)).map((b) => b.limitCents)).toEqual([400_000]);
  });

  it("rejects a malformed date key rather than guessing", async () => {
    await expect(getSpendVsBudget({ dateKey: "28/07/2026" })).rejects.toThrow(/dateKey/);
  });
});

describe("getBudgetHistory", () => {
  it("returns one row per month, so past performance is queryable", async () => {
    seedBudget(temp, { id: 1, categoryId: FOOD, period: "monthly", limitCents: 50_000, effectiveFrom: "2026-01-01" });
    spend("2026-01-10", 30_000);
    spend("2026-02-10", 60_000);
    spend("2026-03-10", 50_000);

    const rows = await getBudgetHistory({ fromKey: "2026-01-01", toKey: "2026-03-31" });
    expect(rows.map((r) => [r.periodKey, r.spentCents, r.remainingCents, r.overBudget])).toEqual([
      ["2026-01", 30_000, 20_000, false],
      ["2026-02", 60_000, -10_000, true],
      ["2026-03", 50_000, 0, false],
    ]);
  });

  it("follows a limit change through history", async () => {
    seedBudget(temp, { id: 1, categoryId: FOOD, period: "monthly", limitCents: 40_000, effectiveFrom: "2026-01-01", effectiveTo: "2026-01-31" });
    seedBudget(temp, { id: 2, categoryId: FOOD, period: "monthly", limitCents: 70_000, effectiveFrom: "2026-02-01" });

    const rows = await getBudgetHistory({ fromKey: "2026-01-01", toKey: "2026-02-28" });
    expect(rows.map((r) => [r.periodKey, r.limitCents])).toEqual([
      ["2026-01", 40_000],
      ["2026-02", 70_000],
    ]);
  });

  it("carries an unused surplus forward when rollover is on", async () => {
    seedBudget(temp, { id: 1, categoryId: FOOD, period: "monthly", limitCents: 50_000, effectiveFrom: "2026-01-01", rollover: true });
    spend("2026-01-10", 20_000);

    const rows = await getBudgetHistory({ fromKey: "2026-01-01", toKey: "2026-02-28" });
    expect(rows[0].carriedOutCents).toBe(30_000);
    expect(rows[1].carriedInCents).toBe(30_000);
    expect(rows[1].availableCents).toBe(80_000);
  });

  it("does NOT carry a deficit forward", async () => {
    seedBudget(temp, { id: 1, categoryId: FOOD, period: "monthly", limitCents: 50_000, effectiveFrom: "2026-01-01", rollover: true });
    spend("2026-01-10", 90_000);

    const rows = await getBudgetHistory({ fromKey: "2026-01-01", toKey: "2026-02-28" });
    expect(rows[0].remainingCents).toBe(-40_000);
    expect(rows[1].carriedInCents).toBe(0);
    expect(rows[1].availableCents).toBe(50_000);
  });

  it("shows the same carry-over whether or not the caller asked for the earlier months", async () => {
    seedBudget(temp, { id: 1, categoryId: FOOD, period: "monthly", limitCents: 50_000, effectiveFrom: "2026-01-01", rollover: true });
    spend("2026-01-10", 10_000);
    spend("2026-02-10", 10_000);

    const wide = await getBudgetHistory({ fromKey: "2026-01-01", toKey: "2026-03-31" });
    const narrow = await getBudgetHistory({ fromKey: "2026-03-01", toKey: "2026-03-31" });
    expect(narrow).toHaveLength(1);
    expect(narrow[0].carriedInCents).toBe(wide[2].carriedInCents);
    expect(narrow[0].carriedInCents).toBe(80_000);
  });

  it("supports weekly history", async () => {
    seedBudget(temp, { id: 1, categoryId: FOOD, period: "weekly", limitCents: 10_000, effectiveFrom: "2026-07-06" });
    spend("2026-07-07", 4_000);
    spend("2026-07-14", 12_000);

    const rows = await getBudgetHistory({ fromKey: "2026-07-06", toKey: "2026-07-19" });
    expect(rows.map((r) => [r.periodKey, r.spentCents, r.overBudget])).toEqual([
      ["2026-07-06", 4_000, false],
      ["2026-07-13", 12_000, true],
    ]);
  });

  it("supports yearly history", async () => {
    seedBudget(temp, { id: 1, categoryId: FOOD, period: "yearly", limitCents: 1_200_000, effectiveFrom: "2025-01-01" });
    spend("2025-03-01", 500_000);
    spend("2026-11-01", 400_000);

    const rows = await getBudgetHistory({ fromKey: "2025-01-01", toKey: "2026-12-31" });
    expect(rows.map((r) => [r.periodKey, r.spentCents])).toEqual([
      ["2025", 500_000],
      ["2026", 400_000],
    ]);
  });

  it("rejects malformed bounds", async () => {
    await expect(getBudgetHistory({ fromKey: "nope", toKey: "2026-01-01" })).rejects.toThrow(/fromKey/);
    await expect(getBudgetHistory({ fromKey: "2026-01-01", toKey: "nope" })).rejects.toThrow(/toKey/);
  });
});
