
import { centsToDecimal, sumCents, tryParseAmount, type Cents } from "@/lib/money";
import { toTransactionDateValue } from "./transaction-form-logic";

export type TransferFormState = {

  fromAccountId: string;
  toAccountId: string;

  amount: string;
  comment: string;
  date: Date;
  pending: boolean;

  fees: string;
  feeCategoryId: string;
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
  feeAmountCents?: Cents | null;
  feeCategoryId?: number | null;
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
    fees: state.fees.trim() || "0",
    feeCategoryId: state.feeCategoryId.trim(),
  };
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

  const fees = tryParseAmount(state.fees.trim() || "0");
  if (fees === null || fees < 0) return "Enter valid non-negative fees.";
  if (fees > 0) {
    const categoryId = Number(state.feeCategoryId);
    if (!Number.isInteger(categoryId) || categoryId <= 0) return "Choose an expense category for the fee.";
  }
  if (transferDebitPreview(state.amount, state.fees) === null) return "Transfer amount plus fees exceeds the supported range.";

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
    fees: "0",
    feeCategoryId: "",
  };
}


export function transferFormFromTransaction(transfer: StoredTransfer): TransferFormState {
  const amountCents = transfer.transferPrincipalAmountCents ?? transfer.amountCents;
  return {
    fromAccountId: transfer.accountId == null ? "" : String(transfer.accountId),
    toAccountId: transfer.transferAccountId == null ? "" : String(transfer.transferAccountId),


    amount: centsToDecimal(amountCents).toString(),
    comment: transfer.comment ?? "",
    date: transfer.date instanceof Date ? transfer.date : new Date(transfer.date),
    pending: transfer.pending === true,
    fees: centsToDecimal(transfer.feeAmountCents ?? (transfer.amountCents - amountCents)).toString(),
    feeCategoryId: transfer.feeCategoryId != null ? String(transfer.feeCategoryId)
      : transfer.allocations?.[0]?.categoryId == null ? "" : String(transfer.allocations[0].categoryId),
  };
}

export function transferDebitPreview(amount: string, fees: string): Cents | null {
  const transferCents = tryParseAmount(amount);
  const feeCents = tryParseAmount(fees.trim() || "0");
  if (transferCents === null || feeCents === null || transferCents < 0 || feeCents < 0) return null;
  try { return sumCents([transferCents, feeCents]); } catch { return null; }
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
