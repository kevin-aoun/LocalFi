
import { centsToDecimal, tryParseAmount, type Cents } from "@/lib/money";
import { toTransactionDateValue } from "./transaction-form-logic";

export type TransferFormState = {

  fromAccountId: string;
  toAccountId: string;

  amount: string;
  comment: string;
  date: Date;
  pending: boolean;

  principalAmount: string;
  interestCategoryId: string;
};

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

export function toTransferFormData(state: TransferFormState): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(buildTransferFormValues(state))) {
    formData.append(key, value);
  }
  return formData;
}

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


export function emptyTransferForm(defaultAccountId: number | null | undefined): TransferFormState {
  return {


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


export function transferFormFromTransaction(transfer: StoredTransfer): TransferFormState {
  return {
    fromAccountId: transfer.accountId == null ? "" : String(transfer.accountId),
    toAccountId: transfer.transferAccountId == null ? "" : String(transfer.transferAccountId),


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


export const UNASSIGNED_ACCOUNT_LABEL = "Unassigned";


export function describeTransfer(
  fromName: string | null | undefined,
  toName: string | null | undefined,
): string {
  const from = fromName?.trim() || UNASSIGNED_ACCOUNT_LABEL;
  const to = toName?.trim() || UNASSIGNED_ACCOUNT_LABEL;
  return `${from} → ${to}`;
}
