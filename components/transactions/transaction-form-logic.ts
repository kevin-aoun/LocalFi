
import { toDateKey, type DateKey } from "@/lib/dates";
import { centsToDecimal, tryParseAmount } from "@/lib/money";
import { parsePurchaseQuantity, parsePurchaseUnitPrice, tradeCashAmount } from "@/lib/investments/cost";
import type { InvestmentSide } from "@/lib/investments/trades";
import { investmentKindForSymbol, type InvestmentKind } from "@/lib/investments/categories";

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
  fees?: string;
  investmentSide?: InvestmentSide;
};


export function transactionCashAmount(state: Pick<TransactionFormState, "amount" | "instrumentSymbol" | "quantity" | "unitPrice" | "fees" | "investmentSide">): string {
  if (!state.instrumentSymbol?.trim()) return state.amount;
  try {
    const fees = tryParseAmount(state.fees?.trim() || "0");
    if (fees === null || fees < 0) return "";
    return centsToDecimal(tradeCashAmount(state.quantity ?? "", state.unitPrice ?? "", fees, state.investmentSide ?? "buy")).toString();
  } catch { return ""; }
}


export function validateTransactionForm(state: TransactionFormState): string | null {
  const categoryId = Number(state.categoryId);
  if (!Number.isInteger(categoryId) || categoryId <= 0) return "Choose a category.";
  if (state.accountId != null && state.accountId.trim() !== "") {
    const accountId = Number(state.accountId);
    if (!Number.isInteger(accountId) || accountId <= 0) return "Choose a real account.";
  }
  if (Number.isNaN(state.date.getTime())) return "Choose a valid date.";
  const investmentValues = [
    state.instrumentSymbol,
    state.quantity,
    state.unitPrice,
    state.instrumentUnit,
  ].map((value) => value?.trim() ?? "");
  if (investmentValues.some(Boolean)) {
    if (!investmentValues[0]) return "Choose an investment instrument.";
    try { parsePurchaseQuantity(investmentValues[1]); } catch {
      return "Enter an exact positive investment quantity.";
    }
    try { parsePurchaseUnitPrice(investmentValues[2]); } catch {
      return "Enter a positive unit price with up to four decimal places.";
    }
    const fees = tryParseAmount(state.fees?.trim() || "0");
    if (fees === null || fees < 0) return "Enter a non-negative fee amount.";
    try { tradeCashAmount(investmentValues[1], investmentValues[2], fees, state.investmentSide ?? "buy"); }
    catch (error) { return (error as Error).message; }
  }
  const amountCents = tryParseAmount(transactionCashAmount(state));
  if (state.investmentSide !== undefined && state.investmentSide !== "buy" && state.investmentSide !== "sell") return "Choose Buy or Sell.";
  if (amountCents === null) return "Enter an amount.";
  if (amountCents < 0) return "Transaction amount cannot be negative.";
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
    values.fees = state.fees?.trim() || "0";
    values.investmentSide = state.investmentSide ?? "buy";
    values.amount = transactionCashAmount(state);
  }
  return values;
}

export function transactionInvestmentKind(category: { type: string; investmentKind?: InvestmentKind | null } | undefined, instrumentSymbol = ""): InvestmentKind | null {
  if (category?.type !== "Investment") return null;
  return category.investmentKind ?? investmentKindForSymbol(instrumentSymbol);
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
