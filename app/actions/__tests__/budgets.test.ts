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
} from "./support/domain-fixture";
import {
  createBudget,
  deleteBudget,
  getBudgetHistory,
  getBudgets,
  getBudgetsForCategory,
  getSpendVsBudget,
  importLegacyBudgets,
  updateBudget,
} from "@/app/actions/budgets";

const FOOD = 1;
const SALARY = 2;
const TRANSPORT = 3;

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  seedAccount(temp, { id: 2, name: "Savings", kind: "asset", type: "Savings" });
  seedCategory(temp, { id: FOOD, name: "Food", type: "Expense" });
  seedCategory(temp, { id: SALARY, name: "Salary", type: "Income" });
  seedCategory(temp, { id: TRANSPORT, name: "Transport", type: "Expense" });
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

describe("legacy categories.monthly_limit_cents", () => {
  it("is read as a monthly budget when the budgets table has no row for the category", async () => {
    seedCategory(temp, { id: 4, name: "Entertainment", type: "Expense", monthlyLimitCents: 2_000 });
    spend("2026-07-05", 500, 4);

    const rows = await getSpendVsBudget({ dateKey: "2026-07-28" });
    const entertainment = rows.find((r) => r.categoryId === 4)!;
    expect(entertainment.limitCents).toBe(2_000);
    expect(entertainment.spentCents).toBe(500);
    expect(entertainment.remainingCents).toBe(1_500);
    expect(entertainment.legacy).toBe(true);
  });

  it("is overridden by a real budgets row for the same category", async () => {
    seedCategory(temp, { id: 4, name: "Entertainment", type: "Expense", monthlyLimitCents: 2_000 });
    seedBudget(temp, { id: 1, categoryId: 4, period: "monthly", limitCents: 9_000, effectiveFrom: "2026-01-01" });

    const rows = await getSpendVsBudget({ dateKey: "2026-07-28" });
    const entertainment = rows.filter((r) => r.categoryId === 4);
    expect(entertainment).toHaveLength(1);
    expect(entertainment[0].limitCents).toBe(9_000);
    expect(entertainment[0].legacy).toBe(false);
  });

  it("dates the legacy budget from the month of the earliest transaction, so history works", async () => {
    seedCategory(temp, { id: 4, name: "Entertainment", type: "Expense", monthlyLimitCents: 2_000 });
    spend("2025-06-27", 100, 4);
    spend("2026-07-05", 500, 4);

    const rows = await getBudgetHistory({ fromKey: "2025-06-01", toKey: "2025-06-30", categoryId: 4 });
    expect(rows).toHaveLength(1);
    expect(rows[0].periodKey).toBe("2025-06");
    expect(rows[0].spentCents).toBe(100);
  });

  it("can be promoted into real budget rows, idempotently", async () => {
    seedCategory(temp, { id: 4, name: "Entertainment", type: "Expense", monthlyLimitCents: 2_000 });
    seedCategory(temp, { id: 5, name: "Gifts", type: "Expense", monthlyLimitCents: 5_000 });
    spend("2025-06-27", 100, 4);

    expect(unwrap(await importLegacyBudgets()).created).toBe(2);
    expect(unwrap(await importLegacyBudgets()).created).toBe(0);

    const rows = await getBudgets();
    expect(rows.map((r) => [r.categoryId, r.limitCents, r.effectiveFrom])).toEqual([
      [4, 2_000, "2025-06-01"],
      [5, 5_000, "2025-06-01"],
    ]);
  });
});

/**
 * The rule: a budget is a SPENDING limit, so an Income category cannot have one.
 *
 * These cases are the inverse of the ones that used to assert an income target
 * was accepted and classified. Enforcement lives in the action rather than the
 * dialog because the dialog is not the only caller.
 */
describe("an Income category cannot have a budget", () => {
  it("createBudget refuses, whatever the period", async () => {
    for (const period of ["weekly", "monthly", "yearly"] as const) {
      expect(
        await createBudget(form({ categoryId: SALARY, period, limit: "10.00", effectiveFrom: "2026-01-01" })),
      ).toMatchObject({ error: expect.stringMatching(/can't have a budget/i) });
    }
    expect(await getBudgets()).toEqual([]);
  });

  it("createBudget refuses a limit of 0 too — the rule is about the category, not the amount", async () => {
    // 0 is a real limit everywhere else in this codebase; it must not sneak an
    // income budget past a truthiness check.
    expect(
      await createBudget(form({ categoryId: SALARY, period: "monthly", limit: "0", effectiveFrom: "2026-01-01" })),
    ).toMatchObject({ error: expect.stringMatching(/can't have a budget/i) });
    expect(await getBudgets()).toEqual([]);
  });

  it("refuses BEFORE closing anything, so a rejected create writes nothing at all", async () => {
    seedBudget(temp, { id: 7, categoryId: SALARY, period: "monthly", limitCents: 400_000, effectiveFrom: "2026-01-01" });

    expect(
      await createBudget(form({ categoryId: SALARY, period: "monthly", limit: "500.00", effectiveFrom: "2026-06-01" })),
    ).toMatchObject({ error: expect.stringMatching(/can't have a budget/i) });

    // The pre-existing row is untouched: not closed, not duplicated.
    expect((await getBudgetsForCategory(SALARY)).map((b) => [b.id, b.limitCents, b.effectiveTo])).toEqual([
      [7, 400_000, null],
    ]);
  });

  it("updateBudget refuses to edit a budget stranded on an income category", async () => {
    seedBudget(temp, { id: 7, categoryId: SALARY, period: "monthly", limitCents: 400_000, effectiveFrom: "2026-01-01" });

    expect(await updateBudget(7, form({ limit: "999.00" }))).toMatchObject({
      error: expect.stringMatching(/can't have a budget/i),
    });
    expect((await getBudgetsForCategory(SALARY))[0].limitCents).toBe(400_000);
  });

  it("deleteBudget still removes a stranded row — that IS the way out", async () => {
    seedBudget(temp, { id: 7, categoryId: SALARY, period: "monthly", limitCents: 400_000, effectiveFrom: "2026-01-01" });
    unwrap(await deleteBudget(7));
    expect(await getBudgetsForCategory(SALARY)).toEqual([]);
  });

  it("does not read a legacy monthly_limit_cents on an income category as a budget", async () => {
    seedCategory(temp, { id: 20, name: "Bonus", type: "Income", monthlyLimitCents: 100_000 });
    spend("2026-07-25", 250_000, 20);

    const rows = await getSpendVsBudget({ dateKey: "2026-07-28" });
    expect(rows.find((r) => r.categoryId === 20)).toBeUndefined();
  });

  it("importLegacyBudgets skips an income category", async () => {
    seedCategory(temp, { id: 20, name: "Bonus", type: "Income", monthlyLimitCents: 100_000 });
    seedCategory(temp, { id: 21, name: "Utilities", type: "Expense", monthlyLimitCents: 20_000 });

    // Only the expense limit is converted; converting the income one would
    // create exactly the row createBudget refuses.
    expect(unwrap(await importLegacyBudgets()).created).toBe(1);
    expect((await getBudgets()).map((b) => [b.categoryId, b.limitCents])).toEqual([[21, 20_000]]);
    expect(await getBudgetsForCategory(20)).toEqual([]);
  });

  it("keeps a stranded income row out of history as well as the current period", async () => {
    seedBudget(temp, { id: 7, categoryId: SALARY, period: "monthly", limitCents: 400_000, effectiveFrom: "2026-01-01" });
    seedBudget(temp, { id: 8, categoryId: FOOD, period: "monthly", limitCents: 50_000, effectiveFrom: "2026-01-01" });
    spend("2026-01-25", 380_000, SALARY);
    spend("2026-01-10", 20_000);

    const rows = await getBudgetHistory({ fromKey: "2026-01-01", toKey: "2026-01-31" });
    expect(rows.map((r) => r.categoryId)).toEqual([FOOD]);
  });
});

describe("updateBudget / deleteBudget", () => {
  beforeEach(() => {
    seedBudget(temp, { id: 1, categoryId: FOOD, period: "monthly", limitCents: 50_000, effectiveFrom: "2026-01-01" });
  });

  it("changes the limit and it takes effect immediately", async () => {
    spend("2026-07-05", 12_000);
    unwrap(await updateBudget(1, form({ limit: "300.00" })));
    expect((await getSpendVsBudget({ dateKey: "2026-07-28" }))[0].remainingCents).toBe(18_000);
  });

  it("can turn rollover on", async () => {
    spend("2026-01-10", 20_000);
    unwrap(await updateBudget(1, form({ rollover: true })));
    const rows = await getBudgetHistory({ fromKey: "2026-01-01", toKey: "2026-02-28" });
    expect(rows[1].carriedInCents).toBe(30_000);
  });

  it("can close a budget with effectiveTo, keeping its history", async () => {
    spend("2026-01-10", 20_000);
    unwrap(await updateBudget(1, form({ effectiveTo: "2026-01-31" })));

    const rows = await getBudgetHistory({ fromKey: "2026-01-01", toKey: "2026-03-31" });
    expect(rows.map((r) => r.periodKey)).toEqual(["2026-01"]);
    expect(rows[0].spentCents).toBe(20_000);
  });

  it("refuses an inverted window and an unknown id", async () => {
    expect(await updateBudget(1, form({ effectiveTo: "2025-01-01" }))).toMatchObject({
      error: expect.stringMatching(/end date/i),
    });
    expect(await updateBudget(999, form({ limit: "1.00" }))).toMatchObject({
      error: expect.stringMatching(/999/),
    });
  });

  it("deletes a budget", async () => {
    unwrap(await deleteBudget(1));
    expect(await getBudgets()).toEqual([]);
    expect(await getSpendVsBudget({ dateKey: "2026-07-28" })).toEqual([]);
  });

  it("deletes an old category-backed budget directly", async () => {
    seedCategory(temp, {
      id: 9,
      name: "Coffee",
      type: "Expense",
      monthlyLimitCents: 5_000,
    });

    unwrap(await deleteBudget(-9));

    expect(temp.scalar("SELECT monthly_limit_cents FROM categories WHERE id = 9")).toBeNull();
    expect(
      (await getSpendVsBudget({ dateKey: "2026-07-28" })).find(
        (row) => row.categoryId === 9,
      ),
    ).toBeUndefined();
  });

  it("edits an old category-backed budget without a separate conversion step", async () => {
    seedCategory(temp, {
      id: 9,
      name: "Coffee",
      type: "Expense",
      monthlyLimitCents: 5_000,
    });

    const edited = unwrap(
      await updateBudget(
        -9,
        form({
          period: "yearly",
          limit: "120.00",
          effectiveFrom: "2026-01-01",
          rollover: true,
        }),
      ),
    );

    expect(edited).toMatchObject({
      categoryId: 9,
      period: "yearly",
      limitCents: 12_000,
      rollover: true,
    });
    expect(temp.scalar("SELECT monthly_limit_cents FROM categories WHERE id = 9")).toBeNull();
    expect(await getBudgetsForCategory(9)).toHaveLength(1);
  });
});

/**
 * Regressions for two defects found while building the budgets UI.
 *
 * Both were reported by the UI agent rather than hit by a user, and neither was
 * covered: the guard bug produced a confusing internal error message, and the
 * coverage bug made a real limit the user had set unreachable from the app.
 */
describe("coverage and guard regressions", () => {
  it("reports a missing category instead of throwing 'No category with id 0'", async () => {
    // `str()` returns null for an absent field and `Number(null) === 0`, which is
    // an integer — so the intended guard never fired.
    const result = await createBudget(form({ limit: "100.00", period: "monthly" }));
    expect(result).toMatchObject({ error: expect.stringMatching(/needs a category/i) });
    expect(result).not.toMatchObject({ error: expect.stringMatching(/id 0/) });
  });

  it("rejects a blank and a non-numeric category the same way", async () => {
    for (const categoryId of ["", "   ", "abc"]) {
      expect(await createBudget(form({ categoryId, limit: "100.00" }))).toMatchObject({
        error: expect.stringMatching(/needs a category/i),
      });
    }
  });

  it("a CLOSED budget no longer masks the category's legacy monthly limit", async () => {
    // Transport has a legacy limit and one budget row whose window has ended.
    // Pin the ledger's earliest transaction, because the legacy fallback anchors
    // its effective-from to it. Without this the anchor is todayKey(), so the
    // test silently stops exercising anything the moment the month rolls over.
    spend("2026-01-05", 1_000);
    seedCategory(temp, { id: 9, name: "Subscriptions", type: "Expense", monthlyLimitCents: 4_000 });
    seedBudget(temp, {
      id: 50,
      categoryId: 9,
      period: "monthly",
      limitCents: 9_900,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-01-31", // closed, well before today
    });

    const rows = await getSpendVsBudget({ dateKey: "2026-07-28" });
    const subscriptions = rows.filter((r) => r.categoryId === 9);

    // Before the fix this was [] — the category vanished from the page entirely
    // and its $40 limit could not be recovered without editing the database.
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].limitCents).toBe(4_000);
  });

  it("importLegacyBudgets converts a limit that a closed budget was masking", async () => {
    spend("2026-01-05", 1_000);  // anchor earliestKey; see above
    seedCategory(temp, { id: 10, name: "Utilities", type: "Expense", monthlyLimitCents: 20_000 });
    seedBudget(temp, {
      id: 51,
      categoryId: 10,
      period: "monthly",
      limitCents: 1_000,
      effectiveFrom: "2026-02-01",
      effectiveTo: "2026-02-28",
    });

    const { created } = unwrap(await importLegacyBudgets());
    expect(created).toBeGreaterThanOrEqual(1);
    const converted = (await getBudgetsForCategory(10)).filter((b) => b.limitCents === 20_000);
    expect(converted).toHaveLength(1);
  });

  it("still treats an IN-FORCE budget as covering the category", async () => {
    // The fix must not go the other way and start double-counting.
    spend("2026-01-05", 1_000);  // anchor earliestKey; see above
    seedCategory(temp, { id: 11, name: "Gym", type: "Expense", monthlyLimitCents: 5_000 });
    seedBudget(temp, {
      id: 52,
      categoryId: 11,
      period: "monthly",
      limitCents: 7_500,
      effectiveFrom: "2026-01-01",
      effectiveTo: null, // open-ended
    });

    const rows = (await getSpendVsBudget({ dateKey: "2026-07-28" })).filter(
      (r) => r.categoryId === 11,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].limitCents).toBe(7_500); // the real budget, not the legacy 5_000
  });
});
