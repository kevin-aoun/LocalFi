/**
 * Pure logic behind `transfer-dialog.tsx`.
 *
 * WHY TRANSFERS ARE THEIR OWN THING: moving money between your own accounts used
 * to have to be entered as an "Investment" expense, which the app then booked as
 * a net-worth LOSS and counted as spend. A transfer is a first-class transaction
 * with NO category, a source account (`accountId`) and a destination account
 * (`transferAccountId`); it is net-neutral to net worth and invisible to
 * income/expense/budget totals. See lib/cash-balance.ts and `createTransfer` in
 * app/actions/transactions.ts.
 *
 * Everything here is pure so it can be unit-tested without a DOM — including the
 * date serialization, which is the same local-midnight rule an ordinary
 * transaction uses (`toTransactionDateValue`). `date.toISOString()` on a picked
 * calendar day stores the PREVIOUS day east of UTC; see transaction-form-logic.ts.
 */
import { centsToDecimal, tryParseAmount, type Cents } from "@/lib/money";
import { toTransactionDateValue } from "./transaction-form-logic";

export type TransferFormState = {
  /** Account id as a string, straight from the `<Select>`. "" = nothing picked. */
  fromAccountId: string;
  toAccountId: string;
  /** Decimal string straight from the `<input type="number">`. */
  amount: string;
  comment: string;
  date: Date;
  pending: boolean;
  /** Optional amount credited to the destination; the remainder is interest/fee expense. */
  principalAmount: string;
  interestCategoryId: string;
};

/** The stored shape a transfer row arrives in when the user edits one. */
export type StoredTransfer = {
  id: number;
  accountId?: number | null;
  transferAccountId?: number | null;
  amountCents: Cents;
  comment?: string | null;
  date: Date | string | number;
  pending?: boolean | null;
  transferPrincipalAmountCents?: Cents | null;
  allocations?: Array<{ categoryId: number; amountCents: Cents }>;
};

/**
 * Everything the dialog appends to FormData, as plain strings.
 *
 * There is NO `categoryId` key, on purpose and permanently: a transfer is not
 * income or expense, and `createTransfer` stores `categoryId: null`. Sending an
 * empty category would be harmless today but would make the "transfers have no
 * category" invariant a matter of luck.
 */
export function buildTransferFormValues(state: TransferFormState): Record<string, string> {
  const values: Record<string, string> = {
    fromAccountId: state.fromAccountId.trim(),
    toAccountId: state.toAccountId.trim(),
    amount: state.amount,
    comment: state.comment,
    date: toTransactionDateValue(state.date),
    pending: state.pending ? "true" : "false",
  };
  if (state.principalAmount.trim() !== "" || state.interestCategoryId.trim() !== "") {
    values.principalAmount = state.principalAmount.trim();
    values.interestCategoryId = state.interestCategoryId.trim();
  }
  return values;
}

/** Copy the values onto a real FormData (what the dialog actually submits). */
export function toTransferFormData(state: TransferFormState): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(buildTransferFormValues(state))) {
    formData.append(key, value);
  }
  return formData;
}

/**
 * Client-side validation, mirroring what `createTransfer` rejects — so the user
 * is told before a round trip, not after. The action still enforces all of it;
 * this is a courtesy, never the only check.
 *
 * Returns the message to show, or null when the form is fine.
 */
export function validateTransferForm(
  state: TransferFormState,
  accounts?: readonly { id: number; currency?: string | null }[],
): string | null {
  const from = state.fromAccountId.trim();
  const to = state.toAccountId.trim();

  if (from === "" || to === "") {
    return "A transfer needs a source and a destination account.";
  }

  const fromId = Number(from);
  const toId = Number(to);
  if (!Number.isInteger(fromId) || !Number.isInteger(toId)) {
    return "Pick a real account on both sides of the transfer.";
  }
  if (fromId === toId) {
    return "A transfer must move money between two DIFFERENT accounts.";
  }

  if (accounts) {
    const source = accounts.find((account) => account.id === fromId);
    const destination = accounts.find((account) => account.id === toId);
    const sourceCurrency = source?.currency?.trim().toUpperCase() || "USD";
    const destinationCurrency = destination?.currency?.trim().toUpperCase() || "USD";
    if (source && destination && sourceCurrency !== destinationCurrency) {
      return `Cannot transfer between ${sourceCurrency} and ${destinationCurrency} accounts without an FX model.`;
    }
  }

  // `tryParseAmount` returns null for unparseable input and 0 for "0" — and 0 is
  // a REAL value here, not "absent". Testing truthiness would reject it.
  const cents = tryParseAmount(state.amount);
  if (cents === null) return "Enter an amount to transfer.";
  if (cents < 0) {
    return "A transfer amount cannot be negative: swap the two accounts instead.";
  }

  const principalText = state.principalAmount.trim();
  const interestCategoryText = state.interestCategoryId.trim();
  if (principalText !== "" || interestCategoryText !== "") {
    const principal = tryParseAmount(principalText);
    if (principal === null || principal < 0) return "Enter a valid non-negative principal amount.";
    if (principal > cents) return "Principal amount cannot exceed the total payment.";
    const interest = cents - principal;
    if (interest > 0) {
      const categoryId = Number(interestCategoryText);
      if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return "Choose an interest or fee category for the non-principal amount.";
      }
    }
  }

  return null;
}

/** A blank form for a new transfer, with the source pre-filled. */
export function emptyTransferForm(defaultAccountId: number | null | undefined): TransferFormState {
  return {
    // `?? ""` and not `|| ""`: an account id is never 0, but the nullish form
    // keeps the falsy-zero trap from being reintroduced by a later edit.
    fromAccountId: defaultAccountId == null ? "" : String(defaultAccountId),
    toAccountId: "",
    amount: "",
    comment: "",
    date: new Date(),
    pending: false,
    principalAmount: "",
    interestCategoryId: "",
  };
}

/** A stored transfer -> the form state that edits it. */
export function transferFormFromTransaction(transfer: StoredTransfer): TransferFormState {
  return {
    fromAccountId: transfer.accountId == null ? "" : String(transfer.accountId),
    toAccountId: transfer.transferAccountId == null ? "" : String(transfer.transferAccountId),
    // Cents -> the decimal string an <input type="number"> expects. 0 must come
    // back as "0", not as an empty field.
    amount: centsToDecimal(transfer.amountCents).toString(),
    comment: transfer.comment ?? "",
    date: transfer.date instanceof Date ? transfer.date : new Date(transfer.date),
    pending: transfer.pending === true,
    principalAmount:
      transfer.transferPrincipalAmountCents != null && (
        transfer.transferPrincipalAmountCents !== transfer.amountCents ||
        (transfer.allocations?.length ?? 0) > 0
      )
        ? centsToDecimal(transfer.transferPrincipalAmountCents).toString()
        : "",
    interestCategoryId: transfer.allocations?.[0]?.categoryId == null
      ? ""
      : String(transfer.allocations[0].categoryId),
  };
}

/** Name shown when a transfer leg points at no account (the unassigned bucket). */
export const UNASSIGNED_ACCOUNT_LABEL = "Unassigned";

/**
 * "Main Checking → Rainy Day Savings" — a DIRECTION, so a transfer row in the
 * ledger cannot be misread as spend.
 */
export function describeTransfer(
  fromName: string | null | undefined,
  toName: string | null | undefined,
): string {
  const from = fromName?.trim() || UNASSIGNED_ACCOUNT_LABEL;
  const to = toName?.trim() || UNASSIGNED_ACCOUNT_LABEL;
  return `${from} → ${to}`;
}
