/**
 * THE balance rule. Every cash, per-account and net-worth figure in this app is
 * derived here and nowhere else.
 *
 * WHY THIS IS ITS OWN MODULE: the balance is recomputed from the FULL ledger on
 * every write (see `syncCashAsset` in app/actions/transactions.ts) and it also
 * drives the dashboard headline figure, so the same arithmetic ran in two places.
 * A `"use server"` file may only export async functions, so this pure function
 * cannot live there and still be unit-testable.
 *
 * ## The rules
 *
 * Ledger effect of one transaction (unchanged from the original rule):
 *   - only non-pending transactions count;
 *   - an Income category adds;
 *   - an Expense or Investment category subtracts;
 *   - a transaction whose category is missing or NULL contributes nothing;
 *   - a TRANSFER (`transferAccountId` set) is never income or expense: it debits
 *     `accountId` and credits `transferAccountId` by the same amount, so it is
 *     net-neutral to net worth and invisible to income/expense/budget totals.
 *     A category on a transfer row is ignored outright.
 *
 * Account balance:
 *
 *     balanceCents = signedOpening(account) + Σ ledger effects on that account
 *
 * `balanceCents` is always a NET-WORTH CONTRIBUTION: positive = value you own,
 * negative = value you owe.
 *
 * ## The one sign convention, stated once
 *
 * `accounts.opening_balance_cents` is stored as a MAGNITUDE in the direction the
 * user thinks about that account:
 *   - `kind: "asset"`    — how much is in it (negative only if genuinely overdrawn);
 *   - `kind: "liability"` — how much is OWED, as a positive number. A credit card
 *     with $500 outstanding stores 50000, not -50000.
 *
 * `signedOpening` performs the single sign flip for liabilities. Everything
 * downstream — expenses, transfers, net worth — then uses one formula, which is
 * why the asset half and the liability half cannot disagree.
 *
 * Net worth:
 *
 *     totalAssets      = Σ balances of asset-kind accounts + unassigned + standalone assets
 *     totalLiabilities = Σ (−balance) of liability-kind accounts, floored at 0 each
 *     netWorth         = totalAssets − totalLiabilities
 *
 * ## Acquisition: a holding contributes 0 until it is owned
 *
 * Buying an asset is a CONVERSION, not a gain — cash falls, the asset appears,
 * net worth is unchanged that day. The temporal corollary is that BEFORE the
 * purchase day the holding contributes exactly 0, not its current value. So a
 * standalone asset may carry `acquiredOn`, and `deriveNetWorth` takes an
 * `asOfKey`: any asset acquired after that day is skipped and reported in
 * `notYetAcquired` instead of being silently dropped.
 *
 * For TODAY's net worth this changes nothing — everything owned was bought in
 * the past — which is exactly why it is tested to the cent. `asOfKey` is a
 * parameter and is never read from the clock here.
 *
 * `acquiredOn` is resolved in ONE place, `resolveAcquisitions` in
 * lib/assets/acquisition.ts. This module consumes the answer; it does not have
 * a second opinion about when something was bought.
 */
import type { AcquisitionEvidence } from "./assets/acquisition";
import { isDateKey, type DateKey } from "./dates";
import { assertCents, negateCents, sumCents, type Cents } from "./money";

/** Discriminates the two halves of the accounts table. */
export type AccountKind = "asset" | "liability";

export type CashLedgerTransaction = {
  /** NULL for a transfer, or for a row whose category was deleted. */
  categoryId?: number | null;
  /** Positive magnitude. Direction comes from the category type / transfer legs. */
  amountCents: Cents;
  pending?: boolean | null;
  /** The account the money moves out of / into. NULL = not yet assigned. */
  accountId?: number | null;
  /** Set ONLY on a transfer: the account the money moves into. */
  transferAccountId?: number | null;
};

export type CashLedgerCategory = {
  id: number;
  type: string;
};

/** The subset of an `accounts` row the balance rule needs. */
export type LedgerAccount = {
  id: number;
  /** "asset" | "liability" — typed loosely so this module needs no schema import. */
  kind: string;
  /** Magnitude; see the sign convention in the module docstring. */
  openingBalanceCents: Cents;
  archived?: boolean | null;
};

export type AccountBalance = {
  /** `null` identifies the synthetic bucket for rows with no (or an unknown) account. */
  accountId: number | null;
  kind: string;
  /** As stored: a magnitude. */
  openingBalanceCents: Cents;
  /** Signed sum of the ledger effects on this account, excluding the opening balance. */
  activityCents: Cents;
  /** Net-worth contribution: positive = owned, negative = owed. */
  balanceCents: Cents;
  /** For a liability, how much is still owed (0 once it is paid off or overpaid). */
  owedCents: Cents;
  archived: boolean;
};

/** A row of the standalone `assets` table (a house, gold, crypto — not an account). */
export type StandaloneAsset = {
  /** `assets.id`, when the caller has it — only used to report exclusions. */
  id?: number;
  category: string;
  currentValueCents: Cents;
  /**
   * The first day this asset contributes anything, from `resolveAcquisitions`.
   * `undefined`/`null` means the caller did not resolve one, and the asset is
   * counted on every day — the pre-acquisition rule cannot apply to a date that
   * was never established.
   */
  acquiredOn?: DateKey | null;
  /**
   * How `acquiredOn` was determined. `"asset_created_at"` means NO transaction
   * backs this holding: it still counts (it really is owned), but it is reported
   * in `unbackedAssetsCents` so a surface can say the provenance is missing.
   */
  acquisitionEvidence?: AcquisitionEvidence | null;
};

/** A standalone asset that did not exist yet on the day being computed. */
export type NotYetAcquiredAsset = {
  id: number | null;
  category: string;
  acquiredOn: DateKey;
  /** What it is worth NOW — and what it did NOT contribute on `asOfKey`. */
  currentValueCents: Cents;
};

export type NetWorth = {
  /** Asset-kind accounts + the unassigned bucket + standalone assets. */
  totalAssetsCents: Cents;
  /** Positive magnitude of everything owed. */
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
  /** Standalone assets that were counted (Cash-category rows excluded by default). */
  standaloneAssetsCents: Cents;
  /**
   * Of `standaloneAssetsCents`, how much is backed by NO purchase transaction.
   * It IS counted — the user owns it — but it is named so a surface can say the
   * acquisition date is a guess from `assets.created_at`. 0 when every counted
   * asset is backed, or when the caller resolved no acquisitions at all.
   */
  unbackedAssetsCents: Cents;
  /**
   * Assets skipped because they were acquired AFTER `asOfKey`. Empty unless an
   * `asOfKey` was given. They are listed rather than dropped so nothing can
   * disappear from a past-dated figure without saying so.
   */
  notYetAcquired: NotYetAcquiredAsset[];
  /** Signed balance of transactions that are not attached to any account. */
  unassignedCents: Cents;
  /** Per-account detail, including the `accountId: null` bucket when it is non-zero. */
  accounts: AccountBalance[];
};

/**
 * True when this row moves value between two of the user's own accounts. Such a
 * row must never be counted as income, expense or budget spend.
 */
export function isTransfer(tx: CashLedgerTransaction): boolean {
  return tx.transferAccountId !== null && tx.transferAccountId !== undefined;
}

/** True when this row belongs in income/expense/budget totals. */
export function isSpendable(tx: CashLedgerTransaction): boolean {
  return !isTransfer(tx) && !tx.pending;
}

export type CategoryCashDirection = "inflow" | "outflow" | "none";

/** The cash direction shared by balance calculations and ledger presentation. */
export function categoryCashDirection(categoryType: string | undefined): CategoryCashDirection {
  if (categoryType === "Income") return "inflow";
  if (categoryType === "Expense" || categoryType === "Investment") return "outflow";
  return "none";
}

/**
 * The signed effect of a NON-transfer row on the account holding it.
 * Returns 0 for an unknown category, which is what keeps a row whose category
 * was deleted from silently moving the user's balance.
 */
function categoryEffect(tx: CashLedgerTransaction, categoryType: string | undefined): Cents {
  switch (categoryCashDirection(categoryType)) {
    case "inflow":
      return tx.amountCents;
    case "outflow":
      return negateCents(tx.amountCents);
    default:
      assertCents(tx.amountCents, "amountCents");
      return 0;
  }
}

function categoryTypeIndex(categories: readonly CashLedgerCategory[]): Map<number, string> {
  return new Map(categories.map((c) => [c.id, c.type]));
}

/** The single sign flip: a liability's stored magnitude becomes a negative contribution. */
function signedOpening(account: LedgerAccount): Cents {
  assertCents(account.openingBalanceCents, `account ${account.id} openingBalanceCents`);
  return account.kind === "liability"
    ? negateCents(account.openingBalanceCents)
    : account.openingBalanceCents;
}

/**
 * Exact cash balance of the WHOLE ledger in integer cents — the legacy figure
 * written to the derived "Cash" asset and shown on the dashboard.
 *
 * Unchanged rules: pending rows skipped, Income adds, Expense/Investment
 * subtract, unknown category contributes nothing. Transfers are excluded
 * explicitly (they would net to zero anyway, but relying on that would break the
 * moment a transfer row carried a category).
 *
 * Throws if any `amountCents` is not an integer, so a leaked float fails loudly
 * instead of quietly shifting the user's net worth.
 */
export function deriveCashBalanceCents(
  transactions: readonly CashLedgerTransaction[],
  categories: readonly CashLedgerCategory[],
): Cents {
  const typeOf = categoryTypeIndex(categories);
  const contributions = transactions
    .filter((tx) => !tx.pending && !isTransfer(tx))
    .map((tx) => categoryEffect(tx, tx.categoryId == null ? undefined : typeOf.get(tx.categoryId)));

  return sumCents(contributions);
}

/**
 * Per-account balances: `opening + income − expenses ± transfers`.
 *
 * One row per account in `accounts`, in the order given, plus a trailing
 * `accountId: null` bucket when any counted transaction has no account or points
 * at an account that is not in `accounts`. That bucket exists so a row can never
 * silently disappear from net worth — it is money the user entered.
 *
 * Archived accounts are still returned and still counted: excluding a closed
 * account that has a non-zero balance would quietly change net worth.
 */
export function deriveAccountBalances(
  accounts: readonly LedgerAccount[],
  transactions: readonly CashLedgerTransaction[],
  categories: readonly CashLedgerCategory[],
): AccountBalance[] {
  const typeOf = categoryTypeIndex(categories);
  const known = new Map(accounts.map((a) => [a.id, a]));

  /** accountId (or null) -> signed effects, kept as a list for exact summation. */
  const activity = new Map<number | null, Cents[]>();
  for (const account of accounts) activity.set(account.id, []);
  const push = (accountId: number | null | undefined, cents: Cents) => {
    const key = accountId != null && known.has(accountId) ? accountId : null;
    const bucket = activity.get(key);
    if (bucket) bucket.push(cents);
    else activity.set(key, [cents]);
  };

  for (const tx of transactions) {
    if (tx.pending) continue;
    if (isTransfer(tx)) {
      // Both legs, same magnitude, opposite signs: net-neutral by construction.
      assertCents(tx.amountCents, "amountCents");
      push(tx.accountId, negateCents(tx.amountCents));
      push(tx.transferAccountId, tx.amountCents);
      continue;
    }
    push(tx.accountId, categoryEffect(tx, tx.categoryId == null ? undefined : typeOf.get(tx.categoryId)));
  }

  const rows: AccountBalance[] = accounts.map((account) => {
    const opening = signedOpening(account);
    const activityCents = sumCents(activity.get(account.id) ?? []);
    const balanceCents = sumCents([opening, activityCents]);
    return {
      accountId: account.id,
      kind: account.kind,
      openingBalanceCents: account.openingBalanceCents,
      activityCents,
      balanceCents,
      owedCents: account.kind === "liability" && balanceCents < 0 ? negateCents(balanceCents) : 0,
      archived: account.archived === true,
    };
  });

  const unassigned = activity.get(null);
  if (unassigned && unassigned.length > 0) {
    const activityCents = sumCents(unassigned);
    rows.push({
      accountId: null,
      kind: "asset",
      openingBalanceCents: 0,
      activityCents,
      balanceCents: activityCents,
      owedCents: 0,
      archived: false,
    });
  }

  return rows;
}

export type NetWorthInput = {
  accounts: readonly LedgerAccount[];
  transactions: readonly CashLedgerTransaction[];
  categories: readonly CashLedgerCategory[];
  /**
   * Rows of the standalone `assets` table. "Cash"-category rows are EXCLUDED by
   * default: that asset is auto-derived from the same ledger the accounts are
   * derived from, so counting both double-counts the user's cash.
   */
  standaloneAssets?: readonly StandaloneAsset[];
  /** Set to true only if you have already removed the derived Cash row yourself. */
  includeCashAsset?: boolean;
  /**
   * The calendar day being computed. A standalone asset whose `acquiredOn` is
   * AFTER this day contributes exactly 0 and is listed in `notYetAcquired`.
   *
   * Omit it and every asset counts, whatever its acquisition date — which is the
   * behaviour every caller had before acquisition existed, so an un-migrated
   * caller cannot change its own figures by accident. Callers computing TODAY
   * pass `todayKey()`; the result is identical to the cent, because everything
   * owned was acquired in the past.
   */
  asOfKey?: DateKey;
};

/**
 * Net worth in exact cents, with the asset and liability halves derived from the
 * SAME per-account balances so they cannot disagree.
 *
 * A liability that has been overpaid stops being a liability and becomes an asset
 * (its balance is positive), rather than a negative debt that inflates net worth
 * twice.
 */
export function deriveNetWorth(input: NetWorthInput): NetWorth {
  const {
    accounts,
    transactions,
    categories,
    standaloneAssets = [],
    includeCashAsset = false,
    asOfKey,
  } = input;

  if (asOfKey !== undefined && !isDateKey(asOfKey)) {
    throw new Error(`deriveNetWorth: invalid asOfKey ${JSON.stringify(asOfKey)}`);
  }

  const balances = deriveAccountBalances(accounts, transactions, categories);

  const assetParts: Cents[] = [];
  const liabilityParts: Cents[] = [];
  let unassignedCents: Cents = 0;

  for (const row of balances) {
    if (row.accountId === null) {
      unassignedCents = row.balanceCents;
      assetParts.push(row.balanceCents);
      continue;
    }
    if (row.kind === "liability") {
      // Owed -> a positive liability; overpaid -> a positive asset.
      if (row.balanceCents < 0) liabilityParts.push(negateCents(row.balanceCents));
      else assetParts.push(row.balanceCents);
      continue;
    }
    assetParts.push(row.balanceCents);
  }

  const eligible = standaloneAssets.filter(
    (asset) => includeCashAsset || asset.category !== "Cash",
  );

  // An asset acquired after the day being computed did not exist yet, so it
  // contributes 0 — not its current value. An asset with NO resolved
  // acquisition date is counted, deliberately: absence of a date is not a claim
  // that the asset is in the future.
  const counted: StandaloneAsset[] = [];
  const notYetAcquired: NotYetAcquiredAsset[] = [];

  for (const asset of eligible) {
    const acquiredOn = asset.acquiredOn;
    if (asOfKey === undefined || acquiredOn === null || acquiredOn === undefined) {
      counted.push(asset);
      continue;
    }
    if (!isDateKey(acquiredOn)) {
      throw new Error(
        `deriveNetWorth: asset ${asset.id ?? asset.category} has an invalid acquiredOn ` +
          `${JSON.stringify(acquiredOn)}`,
      );
    }
    if (acquiredOn > asOfKey) {
      assertCents(asset.currentValueCents, "currentValueCents");
      notYetAcquired.push({
        id: asset.id ?? null,
        category: asset.category,
        acquiredOn,
        currentValueCents: asset.currentValueCents,
      });
      continue;
    }
    counted.push(asset);
  }

  const standaloneAssetsCents = sumCents(counted.map((asset) => asset.currentValueCents));
  // Counted, but backed by nothing in the ledger. Named, never removed.
  const unbackedAssetsCents = sumCents(
    counted
      .filter((asset) => asset.acquisitionEvidence === "asset_created_at")
      .map((asset) => asset.currentValueCents),
  );
  assetParts.push(standaloneAssetsCents);

  const totalAssetsCents = sumCents(assetParts);
  const totalLiabilitiesCents = sumCents(liabilityParts);

  return {
    totalAssetsCents,
    totalLiabilitiesCents,
    netWorthCents: sumCents([totalAssetsCents, negateCents(totalLiabilitiesCents)]),
    standaloneAssetsCents,
    unbackedAssetsCents,
    notYetAcquired,
    unassignedCents,
    accounts: balances,
  };
}
