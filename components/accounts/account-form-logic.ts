/**
 * Pure logic behind the Accounts & Liabilities UI.
 *
 * WHY THIS FILE EXISTS: there is no jsdom in this repo, so anything that lives
 * inside a component cannot be unit-tested. Everything here is a decision that
 * would be expensive to get wrong — the asset/liability sign, "the user left the
 * opening balance blank" vs "the user typed 0", and every cents→string
 * conversion — so it lives outside the component and is covered by
 * __tests__/account-form-logic.test.ts.
 *
 * Three rules this module exists to hold:
 *
 *  1. AN EMPTY OPENING BALANCE IS NOT ZERO. "" means "not stated": the field is
 *     omitted from FormData, and `createAccount` then defaults it to 0 while
 *     `updateAccount` leaves the stored value alone. "0" is a STATED zero and is
 *     always sent. Conflating the two is the falsy-`0` bug this codebase has
 *     already been bitten by twice (see components/budgets/budget-form-logic.ts).
 *
 *  2. A LIABILITY IS NOT A NEGATIVE ASSET. `openingBalanceCents` is a MAGNITUDE
 *     in the direction the user thinks about the account — for a credit card, how
 *     much is OWED, as a positive number. The single sign flip lives in
 *     lib/cash-balance.ts and nowhere else, so a $600 card debt is displayed as
 *     "$600.00 owed", never as "-$600.00".
 *
 *  3. NET WORTH IS NOT RECOMPUTED HERE. `presentNetWorth` formats the figures
 *     `deriveNetWorth` produced. If this file did its own subtraction, the page
 *     and the snapshot table could disagree.
 */
import { absCents, centsToDecimal, formatMoney, tryParseAmount, type Cents } from "@/lib/money";

/** 'asset' | 'liability'. Mirrors `accountKinds` in lib/db/schema/accounts.ts. */
export type AccountKind = "asset" | "liability";

/**
 * The vocabulary the form offers. Deliberately re-declared instead of imported
 * from lib/db/schema so a client bundle does not pull in Drizzle's SQLite core;
 * a test asserts these stay identical to the schema's, so they cannot drift.
 */
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

/** Which side of the balance sheet each type sits on. */
export const IMPLIED_KIND: Record<AccountTypeName, AccountKind> = {
  Checking: "asset",
  Savings: "asset",
  Cash: "asset",
  Investment: "asset",
  CreditCard: "liability",
  Loan: "liability",
  Mortgage: "liability",
  // "Other" may legitimately be either; the form lets the user pick.
  Other: "asset",
};

export const DEFAULT_ACCOUNT_TYPE: AccountTypeName = "Checking";

/** Human labels for the type picker ("CreditCard" reads badly in a dropdown). */
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

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

export function isAccountType(value: string): value is AccountTypeName {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

export function isAccountKind(value: string): value is AccountKind {
  return (ACCOUNT_KINDS as readonly string[]).includes(value);
}

/** The kind a type forces. Unknown types fall back to 'asset' — never throws, so
 * a stale row can still be rendered. */
export function impliedKind(type: string): AccountKind {
  return isAccountType(type) ? IMPLIED_KIND[type] : "asset";
}

/** Only "Other" leaves the balance-sheet side up to the user. */
export function kindIsEditable(type: string): boolean {
  return type === "Other";
}

/**
 * The kind that will actually be sent. For every unambiguous type the implied
 * kind wins: `createAccount` REJECTS a mismatch, and quietly accepting one is how
 * a mortgage would end up inflating net worth.
 */
export function resolveFormKind(type: string, requested: string): AccountKind {
  if (!kindIsEditable(type)) return impliedKind(type);
  return isAccountKind(requested) ? requested : impliedKind(type);
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

export type AccountFormState = {
  name: string;
  kind: AccountKind;
  type: string;
  /** Raw text from the input. "" means "not stated" — see rule 1 above. */
  openingBalance: string;
  currency: string;
};

export function emptyAccountFormState(): AccountFormState {
  return {
    name: "",
    kind: IMPLIED_KIND[DEFAULT_ACCOUNT_TYPE],
    type: DEFAULT_ACCOUNT_TYPE,
    // NOT "0": a blank field must stay blank, or every edit would rewrite the
    // stored opening balance to zero.
    openingBalance: "",
    currency: "USD",
  };
}

/** The fields of an account row this module needs to build a form. */
export type EditableAccount = {
  name: string;
  kind: string;
  type: string;
  openingBalanceCents: Cents;
  currency: string;
};

/**
 * Populate the form from a stored account.
 *
 * The opening balance becomes a DECIMAL STRING via `centsToDecimal` — the
 * established form-transport convention in this app (the server action parses it
 * back with `parseAmount`). A stored 0 renders as "0", not "", because "" would
 * mean "not stated" on the way back in.
 */
export function accountFormStateFromAccount(account: EditableAccount): AccountFormState {
  const kind = isAccountKind(account.kind) ? account.kind : impliedKind(account.type);
  return {
    name: account.name,
    kind,
    type: account.type,
    openingBalance: centsToDecimal(account.openingBalanceCents).toString(),
    currency: account.currency,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type AccountFormValues = {
  name: string;
  kind: AccountKind;
  type: AccountTypeName;
  currency: string;
  /** ABSENT when the user stated no opening balance. Present — including "0" —
   * whenever they did. */
  openingBalance?: string;
};

export type AccountFormValidation =
  | { ok: true; values: AccountFormValues }
  | { ok: false; error: string };

/**
 * Validate the form client-side so a bad amount produces a readable message
 * instead of a server-side throw — or, worse, a silent 0.
 */
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

  const currencyRaw = state.currency.trim();
  if (currencyRaw !== "" && !CURRENCY_CODE.test(currencyRaw)) {
    return {
      ok: false,
      error: `"${currencyRaw}" is not a currency code. Use a three-letter code such as USD.`,
    };
  }
  const currency = currencyRaw === "" ? "USD" : currencyRaw.toUpperCase();

  const values: AccountFormValues = { name, kind, type: state.type, currency };

  // Only an EMPTY field means "not stated". "0" is a stated zero and must be sent.
  const openingRaw = state.openingBalance.trim();
  if (openingRaw !== "") {
    if (tryParseAmount(openingRaw) === null) {
      return {
        ok: false,
        error: `Opening balance "${openingRaw}" is not an amount. Enter a number such as 1,234.56.`,
      };
    }
    values.openingBalance = openingRaw;
  }

  return { ok: true, values };
}

/**
 * The FormData the account actions expect. Throws on invalid input — call
 * `validateAccountForm` first and show the message; this is the last line of
 * defence, not the error path.
 *
 * `archived` is never included: archiving is `setAccountArchived`, and sending
 * the field here would let an edit silently un-archive an account.
 */
export function toAccountFormData(state: AccountFormState): FormData {
  const result = validateAccountForm(state);
  if (!result.ok) throw new Error(result.error);

  const formData = new FormData();
  formData.append("name", result.values.name);
  formData.append("kind", result.values.kind);
  formData.append("type", result.values.type);
  formData.append("currency", result.values.currency);
  if (result.values.openingBalance !== undefined) {
    formData.append("openingBalance", result.values.openingBalance);
  }
  return formData;
}

// ---------------------------------------------------------------------------
// Grouping and display
// ---------------------------------------------------------------------------

/** An account row plus its derived balance — the shape `getAccountBalances` returns. */
export type AccountRow = {
  id: number;
  name: string;
  kind: string;
  type: string;
  openingBalanceCents: Cents;
  currency: string;
  archived: boolean;
  balanceCents: Cents;
  activityCents: Cents;
  owedCents: Cents;
};

export type GroupedAccounts = {
  assets: AccountRow[];
  liabilities: AccountRow[];
  /** How many rows were hidden (or shown) because they are archived. */
  archivedCount: number;
  /** True when there is nothing at all to render, archived included. */
  isEmpty: boolean;
};

/**
 * Split the two halves of the balance sheet.
 *
 * Grouping is by `kind`, NEVER by the sign of the balance: an overpaid credit
 * card has a positive balance and is still a credit card. Archived accounts are
 * excluded unless asked for, and always sort after the live ones.
 */
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
    assets: visible.filter((row) => row.kind !== "liability").sort(byName),
    liabilities: visible.filter((row) => row.kind === "liability").sort(byName),
    archivedCount,
    isEmpty: rows.length === 0,
  };
}

export type BalanceDisplay = {
  /** Already formatted with the account's own currency. */
  amountLabel: string;
  /** A short qualifier ("owed", "in credit", "overdrawn"), or null. */
  note: string | null;
  tone: "positive" | "negative" | "neutral";
};

/**
 * How one account's balance reads.
 *
 * For a liability the OWED MAGNITUDE is shown: $600 outstanding renders
 * "$600.00" + "owed", not "-$600.00". A liability whose balance has gone
 * positive has been overpaid and reads as money held. Throws (via `formatMoney`)
 * on a non-integer balance rather than printing a drifted figure.
 */
export function describeBalance(account: Pick<AccountRow, "kind" | "currency" | "balanceCents" | "owedCents">): BalanceDisplay {
  const currency = normalizeCurrency(account.currency);

  if (account.kind === "liability") {
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

// ---------------------------------------------------------------------------
// Net worth (presentation only)
// ---------------------------------------------------------------------------

export type NetWorthTotals = {
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
  standaloneAssetsCents: Cents;
  unassignedCents: Cents;
};

export type NetWorthDisplay = {
  assetsLabel: string;
  /** A positive magnitude: everything owed. */
  liabilitiesLabel: string;
  netWorthLabel: string;
  isNegative: boolean;
  standaloneAssetsLabel: string;
  unassignedLabel: string;
  hasUnassigned: boolean;
};

/**
 * Format the figures `deriveNetWorth` produced. This function performs NO
 * arithmetic on them — `netWorthCents` is echoed, never re-derived from the two
 * halves, so this page cannot disagree with the snapshot table.
 */
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

/**
 * Which currency the totals may honestly be printed in.
 *
 * There is no FX source in this app. When the accounts share one currency the
 * totals are labelled with it; when they do not, `mixed` is set so the page can
 * say so instead of stamping a "$" on a cross-currency sum.
 */
export function currencyOf(rows: readonly Pick<AccountRow, "currency">[]): {
  currency: string;
  mixed: boolean;
  currencies: string[];
} {
  const codes = [...new Set(rows.map((row) => normalizeCurrency(row.currency)))].sort();
  if (codes.length === 0) return { currency: "USD", mixed: false, currencies: [] };
  return { currency: codes.length === 1 ? codes[0] : "USD", mixed: codes.length > 1, currencies: codes };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * The one-line explanation of the opening balance — the least obvious and most
 * important field on the form. Without it, anyone who imported only recent
 * history sits permanently in negative territory, because the balance is derived
 * from zero across the whole ledger.
 */
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
