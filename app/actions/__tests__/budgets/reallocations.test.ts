
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDomainDb,
  form,
  seedAccount,
  seedBudget,
  seedCategory,
  type DomainDb,
} from "../support/domain-fixture";
import {
  createBudgetReallocation,
  deleteBudgetReallocation,
  getBudgetReallocations,
  getBudgets,
  getSpendVsBudget,
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

describe("monthly budget reallocations", () => {
  beforeEach(() => {
    seedBudget(temp, { id: 1, categoryId: FOOD, period: "monthly", limitCents: 50_000, effectiveFrom: "2026-01-01" });
    seedBudget(temp, { id: 2, categoryId: TRANSPORT, period: "monthly", limitCents: 30_000, effectiveFrom: "2026-01-01" });
  });

  it("moves a fixed amount for one month without changing either permanent rule", async () => {
    const created = unwrap(
      await createBudgetReallocation(
        form({
          month: "2026-07",
          fromCategoryId: FOOD,
          toCategoryId: TRANSPORT,
          inputMode: "amount",
          value: "30.00",
        }),
      ),
    );
    expect(created.amountCents).toBe(3_000);

    const july = await getSpendVsBudget({ dateKey: "2026-07-15", period: "monthly" });
    expect(july.map((row) => [row.categoryId, row.limitCents])).toEqual([
      [FOOD, 47_000],
      [TRANSPORT, 33_000],
    ]);
    const august = await getSpendVsBudget({ dateKey: "2026-08-15", period: "monthly" });
    expect(august.map((row) => [row.categoryId, row.limitCents])).toEqual([
      [FOOD, 50_000],
      [TRANSPORT, 30_000],
    ]);
    expect((await getBudgets()).map((budget) => budget.limitCents)).toEqual([50_000, 30_000]);
  });

  it("converts a percentage to fixed cents when it is created", async () => {
    unwrap(
      await createBudgetReallocation(
        form({
          month: "2026-07",
          fromCategoryId: FOOD,
          toCategoryId: TRANSPORT,
          inputMode: "percentage",
          value: "50",
        }),
      ),
    );
    expect(await getBudgetReallocations({ month: "2026-07" })).toMatchObject([
      {
        amountCents: 25_000,
        inputMode: "percentage",
        inputValue: "50",
        fromCategoryName: "Food",
        toCategoryName: "Transport",
      },
    ]);

    unwrap(await updateBudget(1, form({ limit: "1000.00" })));
    const food = (await getSpendVsBudget({ dateKey: "2026-07-15", categoryId: FOOD }))[0];
    expect(food.limitCents).toBe(75_000);
  });

  it("applies percentages to the remaining reallocatable budget so Max always works", async () => {
    unwrap(
      await createBudgetReallocation(
        form({
          month: "2026-07",
          fromCategoryId: FOOD,
          toCategoryId: TRANSPORT,
          inputMode: "amount",
          value: "100.00",
        }),
      ),
    );
    unwrap(
      await createBudgetReallocation(
        form({
          month: "2026-07",
          fromCategoryId: FOOD,
          toCategoryId: TRANSPORT,
          inputMode: "percentage",
          value: "50",
        }),
      ),
    );
    unwrap(
      await createBudgetReallocation(
        form({
          month: "2026-07",
          fromCategoryId: FOOD,
          toCategoryId: TRANSPORT,
          inputMode: "percentage",
          value: "100",
        }),
      ),
    );

    expect(
      (await getBudgetReallocations({ month: "2026-07" })).map((row) => row.amountCents),
    ).toEqual([10_000, 20_000, 20_000]);
    expect(
      (await getSpendVsBudget({ dateKey: "2026-07-15", categoryId: FOOD }))[0].limitCents,
    ).toBe(0);
  });

  it("refuses invalid or overdrawn moves", async () => {
    expect(
      await createBudgetReallocation(
        form({ month: "2026-07", fromCategoryId: FOOD, toCategoryId: FOOD, inputMode: "amount", value: "1" }),
      ),
    ).toMatchObject({ error: expect.stringMatching(/different categories/i) });
    expect(
      await createBudgetReallocation(
        form({ month: "2026-07", fromCategoryId: FOOD, toCategoryId: TRANSPORT, inputMode: "amount", value: "500.01" }),
      ),
    ).toMatchObject({ error: expect.stringMatching(/only has/i) });
    expect(
      await createBudgetReallocation(
        form({ month: "2026-99", fromCategoryId: FOOD, toCategoryId: TRANSPORT, inputMode: "amount", value: "1" }),
      ),
    ).toMatchObject({ error: expect.stringMatching(/invalid month/i) });
  });

  it("deletes the reallocation directly and restores the original limits", async () => {
    const created = unwrap(
      await createBudgetReallocation(
        form({ month: "2026-07", fromCategoryId: FOOD, toCategoryId: TRANSPORT, inputMode: "amount", value: "30" }),
      ),
    );
    unwrap(await deleteBudgetReallocation(created.id));
    expect(await getBudgetReallocations()).toEqual([]);
    expect((await getSpendVsBudget({ dateKey: "2026-07-15" })).map((row) => row.limitCents)).toEqual([
      50_000,
      30_000,
    ]);
  });
});
