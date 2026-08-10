/**
 * Pure logic behind `transaction-dialog.tsx`.
 *
 * WHY THIS FILE EXISTS: the dialog used to serialize the picked calendar day
 * with `date.toISOString().split("T")[0]`. A `Date` produced by the calendar
 * sits at LOCAL midnight, so converting it to UTC first shifts the day for
 * every user who is not on UTC — a user in Beirut (UTC+3) who picked the 28th
 * stored the 27th, and spend on the 1st of a month landed in the previous
 * budget month. There is no DOM harness in this repo, so the serialization
 * lives here where it can be unit-tested under extreme timezones.
 */
import { toDateKey, type DateKey } from "@/lib/dates";
import { tryParseAmount } from "@/lib/money";

/**
 * Calendar day -> the string the dialog puts into FormData for `date`.
 *
 * Deliberately `'YYYY-MM-DDT00:00:00'` and NOT the bare `'YYYY-MM-DD'` key:
 * the server action stores the value with `new Date(value)`, and per the
 * ECMAScript spec a *date-only* string is interpreted as UTC while a
 * *date-time* string with no offset is interpreted as LOCAL time. Sending the
 * bare key would park the stored instant on UTC midnight, which renders as the
 * PREVIOUS calendar day for every user west of UTC. Sending local midnight
 * makes the stored instant round-trip to the day the user actually picked, in
 * every timezone.
 */
export function toTransactionDateValue(date: Date): string {
  return `${toDateKey(date)}T00:00:00`;
}

/** The calendar day a stored transaction timestamp represents, in local terms. */
export function transactionDateKey(stored: Date | number | string): DateKey {
  return toDateKey(stored instanceof Date ? stored : new Date(stored));
}

export type TransactionFormState = {
  categoryId: string;
  /** Decimal string straight from the `<input type="number">`. */
  amount: string;
  comment: string;
  date: Date;
  pending: boolean;
  /**
   * Which account the money moves out of / into, as a string from the `<Select>`.
   * Optional and possibly `""`: the server action then falls back to the default
   * account on create (`resolveAccountId`) and leaves the account UNCHANGED on
   * update, so a form that does not know about accounts cannot silently move a
   * row to a different one.
   */
  accountId?: string;
  /** Optional supported purchase details. All four are submitted together. */
  instrumentSymbol?: string;
  quantity?: string;
  unitPrice?: string;
  instrumentUnit?: string;
};

/** Provider-price preview only; the user may override the returned exact decimal. */
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

/** Client-side mirror of the server's identifier and magnitude checks. */
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

/**
 * Everything the dialog appends to FormData, as plain strings, so the mapping
 * can be asserted without rendering React.
 *
 * `accountId` is always present as a key (possibly empty) so the transport shape
 * is stable; `resolveAccountId` in app/actions/transactions.ts treats an empty
 * string as "not supplied".
 */
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

/** Copy the values onto a real FormData (what the dialog actually submits). */
export function toTransactionFormData(state: TransactionFormState): FormData {
  const problem = validateTransactionForm(state);
  if (problem) throw new Error(problem);
  const formData = new FormData();
  for (const [key, value] of Object.entries(buildTransactionFormValues(state))) {
    formData.append(key, value);
  }
  return formData;
}
