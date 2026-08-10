import { describe, expect, it } from "vitest";

// Vitest's repository include glob currently names only *.test.ts. Import the
// owned TSX component suite so normal `bun run test` executes it as part of this file.
import "./budget-goals.test.tsx";

import {
  budgetFormStateFrom,
  buildBudgetFormValues,
  buildCategoryFormValues,
  toBudgetFormData,
  toCategoryFormData,
  validateBudgetForm,
} from "../budget-form-logic";

const state = (over: Partial<Parameters<typeof buildCategoryFormValues>[0]> = {}) => ({
  name: "Coffee",
  type: "Expense",
  icon: "Wallet",
  color: "#10b981",
  ...over,
});

describe("category form transport", () => {
  it("sends category fields and no budget storage fields", () => {
    expect(buildCategoryFormValues(state())).toEqual({
      name: "Coffee",
      type: "Expense",
      icon: "Wallet",
      color: "#10b981",
    });
  });

  it("builds FormData with the same boundary", () => {
    const formData = toCategoryFormData(state({ type: "Investment" }));
    expect(Object.fromEntries(formData.entries())).toEqual({
      name: "Coffee",
      type: "Investment",
      icon: "Wallet",
      color: "#10b981",
    });
    expect(formData.has("monthlyLimit")).toBe(false);
  });
});

describe("budget goal form transport", () => {
  const base = () =>
    budgetFormStateFrom(null, "2026-08-07", {
      categoryId: 1,
      period: "monthly",
    });

  it("sends a complete goal pair and uses the DateKey unchanged", () => {
    const values = buildBudgetFormValues({
      ...base(),
      limit: "200.00",
      effectiveFrom: "2026-08-01",
      effectiveTo: "2027-07-31",
      rollover: true,
      goalName: "  Emergency fund  ",
      goalAmount: " 1200.00 ",
    });
    expect(values).toMatchObject({
      effectiveFrom: "2026-08-01",
      effectiveTo: "2027-07-31",
      rollover: "true",
      goalName: "Emergency fund",
      goalAmount: "1200.00",
    });
    expect(Object.fromEntries(toBudgetFormData({ ...base(), ...values, rollover: true }).entries()))
      .toMatchObject({ goalName: "Emergency fund", goalAmount: "1200.00" });
  });

  it("rejects partial, non-positive, non-monthly, and non-rollover goals", () => {
    const goal = { ...base(), limit: "200", goalName: "Emergency fund", goalAmount: "1200" };
    expect(validateBudgetForm({ ...goal, goalAmount: "" })).toMatch(/both a goal name/i);
    expect(validateBudgetForm({ ...goal, goalAmount: "0" })).toMatch(/greater than zero/i);
    expect(validateBudgetForm({ ...goal, period: "weekly", rollover: true })).toMatch(/monthly/i);
    expect(validateBudgetForm({ ...goal, rollover: false })).toMatch(/rollover/i);
    expect(validateBudgetForm({ ...goal, rollover: true })).toBeNull();
  });

  it("hydrates and clears nullable metadata without disabling rollover", () => {
    const edited = budgetFormStateFrom(
      {
        id: 7,
        categoryId: 1,
        period: "monthly",
        limitCents: 20_000,
        effectiveFrom: "2026-08-01",
        effectiveTo: null,
        rollover: true,
        goalName: "Emergency fund",
        goalAmountCents: 120_000,
      },
      "2026-08-07",
    );
    expect(edited).toMatchObject({ goalName: "Emergency fund", goalAmount: "1200" });

    const cleared = { ...edited, goalName: "", goalAmount: "" };
    expect(validateBudgetForm(cleared)).toBeNull();
    expect(buildBudgetFormValues(cleared)).toMatchObject({
      rollover: "true",
      goalName: "",
      goalAmount: "",
    });
  });
});
