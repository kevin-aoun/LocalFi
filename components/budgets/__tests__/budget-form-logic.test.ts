import { describe, expect, it } from "vitest";

import { buildCategoryFormValues, toCategoryFormData } from "../budget-form-logic";

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
