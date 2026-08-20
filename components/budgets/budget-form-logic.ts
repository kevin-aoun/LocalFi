

import type { BudgetPeriod } from "@/lib/budgets";
import type { DateKey } from "@/lib/dates";
import { centsToDecimal, tryParseAmount, type Cents } from "@/lib/money";

import {
  budgetFormStateFrom as baseBudgetFormStateFrom,
  buildBudgetFormValues as buildBaseBudgetFormValues,
  validateBudgetForm as validateBaseBudgetForm,
  withPeriod as withBasePeriod,
  type BudgetRuleFormState as BaseBudgetRuleFormState,
  type CategoryOption,
  type EditableBudget as BaseEditableBudget,
} from "./budget-view-logic";

export type BudgetFormState = {
  name: string;
  type: string;
  icon: string;
  color: string;
};

export function buildCategoryFormValues(state: BudgetFormState): Record<string, string> {
  return {
    name: state.name,
    type: state.type,
    icon: state.icon,
    color: state.color,
  };
}

export function toCategoryFormData(state: BudgetFormState): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(buildCategoryFormValues(state))) {
    formData.append(key, value);
  }
  return formData;
}

export type BudgetRuleFormState = BaseBudgetRuleFormState & {
  goalName: string;

  goalAmount: string;
};

export type EditableBudget = BaseEditableBudget & {
  goalName?: string | null;
  goalAmountCents?: Cents | null;
};

export function validateBudgetForm(
  state: BudgetRuleFormState,
  categories?: readonly CategoryOption[],
): string | null {
  const baseError = validateBaseBudgetForm(state, categories);
  if (baseError) return baseError;

  const goalName = state.goalName.trim();
  const goalAmount = state.goalAmount.trim();
  if (goalName === "" && goalAmount === "") return null;
  if (goalName === "" || goalAmount === "") {
    return "Enter both a goal name and a target amount, or clear both fields.";
  }
  const targetCents = tryParseAmount(goalAmount);
  if (targetCents === null || targetCents <= 0) {
    return "A savings goal target must be greater than zero.";
  }
  if (state.period !== "monthly") return "A savings goal requires a monthly budget.";
  if (!state.rollover) return "Turn on rollover to use a savings goal.";
  return null;
}

export function buildBudgetFormValues(state: BudgetRuleFormState): Record<string, string> {
  return {
    ...buildBaseBudgetFormValues(state),

    goalName: state.goalName.trim(),
    goalAmount: state.goalAmount.trim(),
  };
}

export function toBudgetFormData(state: BudgetRuleFormState): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(buildBudgetFormValues(state))) {
    formData.append(key, value);
  }
  return formData;
}

export function budgetFormStateFrom(
  budget: EditableBudget | null,
  dateKey: DateKey,
  defaults?: { period?: BudgetPeriod; categoryId?: number },
): BudgetRuleFormState {
  return {
    ...baseBudgetFormStateFrom(budget, dateKey, defaults),
    goalName: budget?.goalName ?? "",
    goalAmount:
      budget?.goalAmountCents == null
        ? ""
        : centsToDecimal(budget.goalAmountCents).toString(),
  };
}

export function withPeriod(
  state: BudgetRuleFormState,
  period: BudgetPeriod,
): BudgetRuleFormState {
  return withBasePeriod(state, period) as BudgetRuleFormState;
}
