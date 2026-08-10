"use server";

import * as mutations from "./budgets/mutations";
import * as read from "./budgets/read";
import * as reallocations from "./budgets/reallocations";

/** Stable public budget-action surface; implementation is split by responsibility. */
export async function getBudgets(...args: Parameters<typeof read.getBudgets>) {
  return read.getBudgets(...args);
}

export async function getBudgetsForCategory(...args: Parameters<typeof read.getBudgetsForCategory>) {
  return read.getBudgetsForCategory(...args);
}

export async function getSpendVsBudget(...args: Parameters<typeof read.getSpendVsBudget>) {
  return read.getSpendVsBudget(...args);
}

export async function getCategorySpend(...args: Parameters<typeof read.getCategorySpend>) {
  return read.getCategorySpend(...args);
}

export async function getBudgetHistory(...args: Parameters<typeof read.getBudgetHistory>) {
  return read.getBudgetHistory(...args);
}

export async function getBudgetReallocations(...args: Parameters<typeof reallocations.getBudgetReallocations>) {
  return reallocations.getBudgetReallocations(...args);
}

export async function createBudgetReallocation(...args: Parameters<typeof reallocations.createBudgetReallocation>) {
  return reallocations.createBudgetReallocation(...args);
}

export async function deleteBudgetReallocation(...args: Parameters<typeof reallocations.deleteBudgetReallocation>) {
  return reallocations.deleteBudgetReallocation(...args);
}

export async function createBudget(...args: Parameters<typeof mutations.createBudget>) {
  return mutations.createBudget(...args);
}

export async function updateBudget(...args: Parameters<typeof mutations.updateBudget>) {
  return mutations.updateBudget(...args);
}

export async function deleteBudget(...args: Parameters<typeof mutations.deleteBudget>) {
  return mutations.deleteBudget(...args);
}

export async function importLegacyBudgets(...args: Parameters<typeof mutations.importLegacyBudgets>) {
  return mutations.importLegacyBudgets(...args);
}

export type { BudgetReallocationView } from "./budgets/reallocations";
export type { ActionResult, BudgetPerformanceRow } from "./budgets/shared";
