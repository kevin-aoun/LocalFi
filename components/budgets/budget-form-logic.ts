/** Pure form transport for the category dialog. Budget limits have their own form. */

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
