
import { toDateKey, type DateKey } from "@/lib/dates";
import { tryParseAmount } from "@/lib/money";

export function toTransactionDateValue(date: Date): string {
  return `${toDateKey(date)}T00:00:00`;
}


export function transactionDateKey(stored: Date | number | string): DateKey {
  return toDateKey(stored instanceof Date ? stored : new Date(stored));
}

export type TransactionFormState = {
  categoryId: string;

  amount: string;
  comment: string;
  date: Date;
  pending: boolean;

  accountId?: string;

  instrumentSymbol?: string;
  quantity?: string;
  unitPrice?: string;
  instrumentUnit?: string;
};


export function previewInvestmentQuantity(amount: string, unitPrice: string, precision = 12): string | null {
  if (!Number.isInteger(precision) || precision < 0 || precision > 18) return null;
  const paidMinor = tryParseAmount(amount);
  const priceMinor = tryParseAmount(unitPrice);
  if (paidMinor === null || priceMinor === null || paidMinor < 0 || priceMinor <= 0) return null;
  const scale = BigInt(10) ** BigInt(precision);
  const numerator = BigInt(paidMinor) * scale;
  const denominator = BigInt(priceMinor);
  let quotient = numerator / denominator;
  if ((numerator % denominator) * BigInt(2) >= denominator) quotient += BigInt(1);
  if (precision === 0) return quotient.toString();
  const digits = quotient.toString().padStart(precision + 1, "0");
  const value = `${digits.slice(0, -precision)}.${digits.slice(-precision)}`
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1");
  return value === "" ? "0" : value;
}


export function validateTransactionForm(state: TransactionFormState): string | null {
  const categoryId = Number(state.categoryId);
  if (!Number.isInteger(categoryId) || categoryId <= 0) return "Choose a category.";
  if (state.accountId != null && state.accountId.trim() !== "") {
    const accountId = Number(state.accountId);
    if (!Number.isInteger(accountId) || accountId <= 0) return "Choose a real account.";
  }
  const amountCents = tryParseAmount(state.amount);
  if (amountCents === null) return "Enter an amount.";
  if (amountCents < 0) return "Transaction amount cannot be negative.";
  if (Number.isNaN(state.date.getTime())) return "Choose a valid date.";
  const investmentValues = [
    state.instrumentSymbol,
    state.quantity,
    state.unitPrice,
    state.instrumentUnit,
  ].map((value) => value?.trim() ?? "");
  if (investmentValues.some(Boolean)) {
    if (!investmentValues[0]) return "Choose an investment instrument.";
    if (!investmentValues[1] || !/^\+?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(investmentValues[1])) {
      return "Enter an exact positive investment quantity.";
    }
    if (Number(investmentValues[1]) <= 0) return "Investment quantity must be positive.";
    const unitPriceCents = tryParseAmount(investmentValues[2]);
    if (unitPriceCents === null || unitPriceCents <= 0) {
      return "Enter the frozen unit price used for this purchase.";
    }
  }
  return null;
}


export function buildTransactionFormValues(
  state: TransactionFormState,
): Record<string, string> {
  const values: Record<string, string> = {
    categoryId: state.categoryId,
    amount: state.amount,
    comment: state.comment,
    date: toTransactionDateValue(state.date),
    pending: state.pending ? "true" : "false",
    accountId: (state.accountId ?? "").trim(),
  };
  if ([state.instrumentSymbol, state.quantity, state.unitPrice, state.instrumentUnit].some(
    (value) => value != null && value.trim() !== "",
  )) {
    values.instrumentSymbol = state.instrumentSymbol?.trim() ?? "";
    values.quantity = state.quantity?.trim() ?? "";
    values.unitPrice = state.unitPrice?.trim() ?? "";
    values.instrumentUnit = state.instrumentUnit?.trim() ?? "";
  }
  return values;
}


export function toTransactionFormData(state: TransactionFormState): FormData {
  const problem = validateTransactionForm(state);
  if (problem) throw new Error(problem);
  const formData = new FormData();
  for (const [key, value] of Object.entries(buildTransactionFormValues(state))) {
    formData.append(key, value);
  }
  return formData;
}
