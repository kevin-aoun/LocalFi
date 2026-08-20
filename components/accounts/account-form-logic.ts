
import { absCents, centsToDecimal, formatMoney, tryParseAmount, type Cents } from "@/lib/money";
import { isDateKey, todayKey, type DateKey } from "@/lib/dates";
import {
  isSupportedCurrency,
  normalizeAccountCurrency,
  type SupportedCurrencyCode,
} from "./currencies";

export type AccountKind = "asset" | "liability";

export const ACCOUNT_KINDS = ["asset", "liability"] as const;

export const ACCOUNT_TYPES = [
  "Checking",
  "Savings",
  "Cash",
  "CreditCard",
  "Loan",
  "Mortgage",
  "Investment",
  "Other",
] as const;

export type AccountTypeName = (typeof ACCOUNT_TYPES)[number];

export const IMPLIED_KIND: Record<AccountTypeName, AccountKind> = {
  Checking: "asset",
  Savings: "asset",
  Cash: "asset",
  Investment: "asset",
  CreditCard: "liability",
  Loan: "liability",
  Mortgage: "liability",

  Other: "asset",
};

export const DEFAULT_ACCOUNT_TYPE: AccountTypeName = "Checking";

export const ACCOUNT_TYPE_LABELS: Record<AccountTypeName, string> = {
  Checking: "Checking",
  Savings: "Savings",
  Cash: "Cash",
  CreditCard: "Credit card",
  Loan: "Loan",
  Mortgage: "Mortgage",
  Investment: "Investment",
  Other: "Other",
};

export function isAccountType(value: string): value is AccountTypeName {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

export function isAccountKind(value: string): value is AccountKind {
  return (ACCOUNT_KINDS as readonly string[]).includes(value);
}

export function impliedKind(type: string): AccountKind {
  return isAccountType(type) ? IMPLIED_KIND[type] : "asset";
}

export function kindIsEditable(type: string): boolean {
  return type === "Other";
}

export function resolveFormKind(type: string, requested: string): AccountKind {
  if (!kindIsEditable(type)) return impliedKind(type);
  return isAccountKind(requested) ? requested : impliedKind(type);
}

export type AccountFormState = {
  name: string;
  kind: AccountKind;
  type: string;

  openingBalance: string;
  openingBalanceDate: string;
  currency: string;
};

export function emptyAccountFormState(): AccountFormState {
  return {
    name: "",
    kind: IMPLIED_KIND[DEFAULT_ACCOUNT_TYPE],
    type: DEFAULT_ACCOUNT_TYPE,

    openingBalance: "",
    openingBalanceDate: todayKey(),
    currency: "USD",
  };
}

export type EditableAccount = {
  name: string;
  kind: string;
  type: string;
  openingBalanceCents: Cents;
  openingBalanceDate?: DateKey;
  currency: string;
};

export function accountFormStateFromAccount(account: EditableAccount): AccountFormState {
  const kind = isAccountKind(account.kind) ? account.kind : impliedKind(account.type);
  return {
    name: account.name,
    kind,
    type: account.type,
    openingBalance: centsToDecimal(account.openingBalanceCents).toString(),
    openingBalanceDate: account.openingBalanceDate ?? todayKey(),
    currency: normalizeAccountCurrency(account.currency),
  };
}

export type AccountFormValues = {
  name: string;
  kind: AccountKind;
  type: AccountTypeName;
  currency: string;
  openingBalanceDate: DateKey;

  openingBalance?: string;
};

export type AccountFormValidation =
  | { ok: true; values: AccountFormValues }
  | { ok: false; error: string };

export function validateAccountForm(state: AccountFormState): AccountFormValidation {
  const name = state.name.trim();
  if (name === "") return { ok: false, error: "An account needs a name" };

  if (!isAccountType(state.type)) {
    return {
      ok: false,
      error: `"${state.type}" is not an account type. Choose one of ${ACCOUNT_TYPES.join(", ")}.`,
    };
  }

  if (kindIsEditable(state.type) && !isAccountKind(state.kind)) {
    return { ok: false, error: `"${state.kind}" is not a kind. Choose asset or liability.` };
  }
  const kind = resolveFormKind(state.type, state.kind);

  const currency = normalizeAccountCurrency(state.currency) || "USD";
  if (!isSupportedCurrency(currency)) {
    return {
      ok: false,
      error: `"${state.currency}" is not supported. Choose a currency from the list.`,
    };
  }

  const openingBalanceDate = state.openingBalanceDate ?? todayKey();
  if (!isDateKey(openingBalanceDate)) {
    return { ok: false, error: "Choose a valid opening balance date." };
  }

  const values: AccountFormValues = {
    name,
    kind,
    type: state.type,
    currency: currency as SupportedCurrencyCode,
    openingBalanceDate,
  };

  const openingRaw = state.openingBalance.trim();
  if (openingRaw !== "") {
    const parsed = tryParseAmount(openingRaw);
    if (parsed === null) {
      return {
        ok: false,
        error: `Opening balance "${openingRaw}" is not an amount. Enter a number such as 1,234.56.`,
      };
    }
    if (parsed < 0) {
      return { ok: false, error: "Opening balance cannot be negative." };
    }
    values.openingBalance = openingRaw;
  }

  return { ok: true, values };
}

export function toAccountFormData(state: AccountFormState): FormData {
  const result = validateAccountForm(state);
  if (!result.ok) throw new Error(result.error);

  const formData = new FormData();
  formData.append("name", result.values.name);
  formData.append("kind", result.values.kind);
  formData.append("type", result.values.type);
  formData.append("currency", result.values.currency);
  formData.append("openingBalanceDate", result.values.openingBalanceDate);
  if (result.values.openingBalance !== undefined) {
    formData.append("openingBalance", result.values.openingBalance);
  }
  return formData;
}

export type AccountRow = {
  id: number;
  name: string;
  kind: string;
  type: string;
  openingBalanceCents: Cents;
  openingBalanceDate?: DateKey;
  currency: string;
  archived: boolean;
  balanceCents: Cents;
  activityCents: Cents;
  owedCents: Cents;

  balanceKind?: "asset" | "liability";
};

export type GroupedAccounts = {
  assets: AccountRow[];
  liabilities: AccountRow[];

  archivedCount: number;

  isEmpty: boolean;
};

export function groupAccountsByKind(
  rows: readonly AccountRow[],
  options?: { includeArchived?: boolean },
): GroupedAccounts {
  const includeArchived = options?.includeArchived === true;
  const archivedCount = rows.filter((row) => row.archived).length;
  const visible = rows.filter((row) => includeArchived || !row.archived);

  const byName = (a: AccountRow, b: AccountRow) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    const compared = a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "en");
    return compared !== 0 ? compared : a.id - b.id;
  };

  return {
    assets: visible.filter((row) => (row.balanceKind ?? row.kind) !== "liability").sort(byName),
    liabilities: visible.filter((row) => (row.balanceKind ?? row.kind) === "liability").sort(byName),
    archivedCount,
    isEmpty: rows.length === 0,
  };
}

export type BalanceDisplay = {

  amountLabel: string;

  note: string | null;
  tone: "positive" | "negative" | "neutral";
};

export function describeBalance(account: Pick<AccountRow, "kind" | "balanceKind" | "currency" | "balanceCents" | "owedCents">): BalanceDisplay {
  const currency = normalizeCurrency(account.currency);

  if ((account.balanceKind ?? account.kind) === "liability") {
    if (account.balanceCents < 0) {
      return {
        amountLabel: formatMoney(absCents(account.balanceCents), currency),
        note: "owed",
        tone: "negative",
      };
    }
    if (account.balanceCents > 0) {
      return {
        amountLabel: formatMoney(account.balanceCents, currency),
        note: "in credit: overpaid",
        tone: "positive",
      };
    }
    return { amountLabel: formatMoney(0, currency), note: "nothing owed", tone: "neutral" };
  }

  if (account.balanceCents < 0) {
    return {
      amountLabel: formatMoney(account.balanceCents, currency),
      note: "overdrawn",
      tone: "negative",
    };
  }
  return {
    amountLabel: formatMoney(account.balanceCents, currency),
    note: null,
    tone: account.balanceCents === 0 ? "neutral" : "positive",
  };
}

function normalizeCurrency(currency: string | null | undefined): string {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  return code === "" ? "USD" : code;
}

export type NetWorthTotals = {
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
  standaloneAssetsCents: Cents;
  unassignedCents: Cents;
};

export type NetWorthDisplay = {
  assetsLabel: string;

  liabilitiesLabel: string;
  netWorthLabel: string;
  isNegative: boolean;
  standaloneAssetsLabel: string;
  unassignedLabel: string;
  hasUnassigned: boolean;
};

export function presentNetWorth(totals: NetWorthTotals, currency = "USD"): NetWorthDisplay {
  const code = normalizeCurrency(currency);
  return {
    assetsLabel: formatMoney(totals.totalAssetsCents, code),
    liabilitiesLabel: formatMoney(absCents(totals.totalLiabilitiesCents), code),
    netWorthLabel: formatMoney(totals.netWorthCents, code),
    isNegative: totals.netWorthCents < 0,
    standaloneAssetsLabel: formatMoney(totals.standaloneAssetsCents, code),
    unassignedLabel: formatMoney(totals.unassignedCents, code),
    hasUnassigned: totals.unassignedCents !== 0,
  };
}

export function currencyOf(rows: readonly Pick<AccountRow, "currency">[]): {
  currency: string;
  mixed: boolean;
  currencies: string[];
} {
  const codes = [...new Set(rows.map((row) => normalizeCurrency(row.currency)))].sort();
  if (codes.length === 0) return { currency: "USD", mixed: false, currencies: [] };
  return { currency: codes.length === 1 ? codes[0] : "USD", mixed: codes.length > 1, currencies: codes };
}

export function openingBalanceHelp(kind: AccountKind): string {
  return kind === "liability"
    ? "What you still owed on this account before your logged history begins. Enter it as a positive number: $600 of card debt is 600."
    : "What was in this account before your logged history begins. Leave blank if your ledger covers everything.";
}

export function orphanSummary(count: number): { hasOrphans: boolean; message: string } {
  if (count <= 0) {
    return { hasOrphans: false, message: "Every transaction belongs to an account." };
  }
  const noun = count === 1 ? "1 transaction is" : `${count} transactions are`;
  return {
    hasOrphans: true,
    message: `${noun} not assigned to any account. They still count towards net worth, but not towards any account's balance.`,
  };
}
