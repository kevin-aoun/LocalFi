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
};

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
  return {
    categoryId: state.categoryId,
    amount: state.amount,
    comment: state.comment,
    date: toTransactionDateValue(state.date),
    pending: state.pending ? "true" : "false",
    accountId: (state.accountId ?? "").trim(),
  };
}

/** Copy the values onto a real FormData (what the dialog actually submits). */
export function toTransactionFormData(state: TransactionFormState): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(buildTransactionFormValues(state))) {
    formData.append(key, value);
  }
  return formData;
}
