import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBudget,
  getBudgetsForCategory,
  getSpendVsBudget,
  updateBudget,
} from "@/app/actions/budgets";
import {
  createDomainDb,
  form,
  seedCategory,
  type DomainDb,
} from "./support/domain-fixture";

const TRAVEL = 1;
let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: TRAVEL, name: "Travel", type: "Expense" });
});

afterEach(async () => {
  await temp.cleanup();
});

function unwrap<T>(result: { success: true; data: T } | { error: string }): T {
  if ("error" in result) throw new Error(result.error);
  return result.data;
}

function goalForm(
  overrides: Record<string, string | number | boolean | null | undefined> = {},
) {
  return form({
    categoryId: TRAVEL,
    period: "monthly",
    limit: "200.00",
    effectiveFrom: "2026-01-01",
    rollover: true,
    goalName: "Japan trip",
    goalAmount: "1200.00",
    ...overrides,
  });
}

describe("budget savings-goal actions", () => {
  it("creates goal metadata without creating a ledger row", async () => {
    const created = unwrap(await createBudget(goalForm()));
    expect(created).toMatchObject({
      period: "monthly",
      limitCents: 20_000,
      rollover: true,
      goalName: "Japan trip",
      goalAmountCents: 120_000,
    });
    expect(temp.scalar("SELECT COUNT(*) FROM transactions")).toBe(0);

    const [current] = await getSpendVsBudget({ dateKey: "2026-02-15" });
    expect(current).toMatchObject({
      goalName: "Japan trip",
      goalAmountCents: 120_000,
      availableCents: 40_000,
      remainingCents: 40_000,
    });
  });

  it("rejects partial and incompatible goals atomically", async () => {
    for (const invalid of [
      { goalAmount: null },
      { goalName: null },
      { goalAmount: "0" },
      { period: "weekly" },
      { rollover: false },
    ]) {
      const result = await createBudget(goalForm(invalid));
      expect(result).toHaveProperty("error");
    }
    expect(temp.scalar("SELECT COUNT(*) FROM budgets")).toBe(0);
    expect(temp.scalar("SELECT COUNT(*) FROM transactions")).toBe(0);
  });

  it("refuses disabling rollover while a goal remains", async () => {
    const created = unwrap(await createBudget(goalForm()));
    expect(await updateBudget(created.id, form({ rollover: false }))).toMatchObject({
      error: expect.stringMatching(/rollover/i),
    });
    expect(await getBudgetsForCategory(TRAVEL)).toMatchObject([
      { rollover: true, goalName: "Japan trip", goalAmountCents: 120_000 },
    ]);
  });

  it("clears both fields without disabling rollover or touching transactions", async () => {
    const created = unwrap(await createBudget(goalForm()));
    const cleared = unwrap(
      await updateBudget(created.id, form({ goalName: null, goalAmount: null })),
    );
    expect(cleared).toMatchObject({
      rollover: true,
      goalName: null,
      goalAmountCents: null,
    });
    expect(temp.scalar("SELECT COUNT(*) FROM transactions")).toBe(0);
  });
});
