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
 *   - `kind: "asset"`    — how much is in it, as a non-negative magnitude;
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
 */
import { isDateKey, type DateKey } from "./dates";
import { assertCents, negateCents, sumCents, type Cents } from "./money";

type AcquisitionEvidence = "linked_transaction" | "inferred_unique_purchase" | "asset_created_at";

/** Normalize and validate the ISO-style currency code stored on ledger rows. */
export function normalizeLedgerCurrency(value: unknown, fallback = "USD"): string {
  const raw = typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  const code = raw.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(`Invalid currency: ${JSON.stringify(value)}. Expected a three-letter code.`);
  }
  return code;
}

/** Discriminates the two halves of the accounts table. */
export type AccountKind = "asset" | "liability";

export type CashLedgerTransaction = {
  /** NULL for a transfer, or for a row whose category was deleted. */
  categoryId?: number | null;
  /** Non-negative magnitude. */
  amountCents: Cents;
  /**
   * Historical row meaning (DECISION: DEC-003). Optional only so pure helpers
   * can still consume pre-0009 in-memory fixtures; persisted rows always carry it.
   */
  direction?: "inflow" | "outflow" | "transfer" | null;
  /** Historical denomination. Optional only for legacy in-memory fixtures. */
  currency?: string | null;
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
  /** First calendar day on which the opening balance contributes. */
  openingBalanceDate?: DateKey | null;
  /** ISO denomination for the opening balance and every attached ledger row. */
  currency?: string | null;
  archived?: boolean | null;
};

export type AccountBalance = {
  /** `null` identifies the synthetic bucket for rows with no (or an unknown) account. */
  accountId: number | null;
  /** The one denomination of every cent in this row. */
  currency: string;
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
  /** ISO denomination of `currentValueCents`. */
  currency?: string | null;
  /** Archived holdings are retained but do not contribute to current net worth. */
  archived?: boolean | null;
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
  currency: string;
};

/** One mathematically valid net-worth aggregate, scoped to one denomination. */
export type CurrencyNetWorth = {
  currency: string;
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
  standaloneAssetsCents: Cents;
  unbackedAssetsCents: Cents;
  unassignedCents: Cents;
};

export type NetWorth = {
  /**
   * DECISION: DEC-004 — sorted, denomination-scoped totals. No row contains a
   * cent from another currency.
   */
  currencyTotals: CurrencyNetWorth[];
  /** The valid scalar aggregate, available only for a single denomination. */
  aggregate: CurrencyNetWorth | null;
  /** Exactly one currency when a scalar aggregate is valid; otherwise null. */
  aggregateCurrency: string | null;
  /** Single-currency compatibility scalar; zero when `aggregate` is null. */
  totalAssetsCents: Cents;
  /** Single-currency compatibility scalar; zero when `aggregate` is null. */
  totalLiabilitiesCents: Cents;
  /** Single-currency compatibility scalar; zero when `aggregate` is null. */
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
  if (tx.direction !== null && tx.direction !== undefined) return tx.direction === "transfer";
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
 * Stored direction wins. Category metadata is consulted only for legacy
 * in-memory rows that predate migration 0009.
 */
export function transactionCashDirection(
  tx: CashLedgerTransaction,
  categoryType: string | undefined,
): CategoryCashDirection | "transfer" {
  if (tx.direction === "inflow" || tx.direction === "outflow" || tx.direction === "transfer") {
    return tx.direction;
  }
  if (tx.direction !== null && tx.direction !== undefined) {
    throw new Error(`Invalid transaction direction: ${String(tx.direction)}`);
  }
  if (isTransfer(tx)) return "transfer";
  return categoryCashDirection(categoryType);
}

function assertMagnitude(cents: Cents, label: string): void {
  assertCents(cents, label);
  if (cents < 0) throw new Error(`${label} must be a non-negative magnitude`);
}

/**
 * The signed effect of a NON-transfer row on the account holding it. A persisted
 * direction remains effective after category deletion; only a legacy fixture
 * with neither direction nor usable category metadata contributes 0.
 */
function categoryEffect(tx: CashLedgerTransaction, categoryType: string | undefined): Cents {
  assertMagnitude(tx.amountCents, "amountCents");
  switch (transactionCashDirection(tx, categoryType)) {
    case "inflow":
      return tx.amountCents;
    case "outflow":
      return negateCents(tx.amountCents);
    default:
      return 0;
  }
}

function categoryTypeIndex(categories: readonly CashLedgerCategory[]): Map<number, string> {
  return new Map(categories.map((c) => [c.id, c.type]));
}

/** The single sign flip: a liability's stored magnitude becomes a negative contribution. */
function signedOpening(account: LedgerAccount, asOfKey?: DateKey): Cents {
  assertMagnitude(account.openingBalanceCents, `account ${account.id} openingBalanceCents`);
  if (account.openingBalanceDate !== null && account.openingBalanceDate !== undefined) {
    if (!isDateKey(account.openingBalanceDate)) {
      throw new Error(
        `account ${account.id} has invalid openingBalanceDate ${JSON.stringify(account.openingBalanceDate)}`,
      );
    }
    if (asOfKey !== undefined && asOfKey < account.openingBalanceDate) return 0;
  }
  return account.kind === "liability"
    ? negateCents(account.openingBalanceCents)
    : account.openingBalanceCents;
}

/**
 * One exact cash balance, scoped to a single denomination.
 *
 * Pending rows are skipped; stored inflows add and stored outflows subtract.
 * Legacy rows without direction fall back to category type, and an unknown
 * legacy category contributes nothing. Transfers are excluded explicitly (they
 * would net to zero anyway, but relying on that would break the moment a
 * transfer row carried a category).
 *
 * Throws if any `amountCents` is not an integer, so a leaked float fails loudly
 * instead of quietly shifting the user's net worth.
 */
export type CurrencyCashBalance = {
  currency: string;
  balanceCents: Cents;
};

function countedCashTransactions(
  transactions: readonly CashLedgerTransaction[],
  categories: readonly CashLedgerCategory[],
): Array<{ transaction: CashLedgerTransaction; contributionCents: Cents; currency: string }> {
  const typeOf = categoryTypeIndex(categories);
  return transactions.map((tx) => {
    assertMagnitude(tx.amountCents, "amountCents");
    const currency = normalizeLedgerCurrency(tx.currency, "USD");
    const contributionCents =
      tx.pending || isTransfer(tx)
        ? 0
        : categoryEffect(tx, tx.categoryId == null ? undefined : typeOf.get(tx.categoryId));
    return { transaction: tx, contributionCents, currency };
  });
}

/**
 * DECISION: DEC-004 — derive one sorted cash subtotal per stored transaction
 * currency. Pending rows and transfers do not create otherwise-empty buckets.
 */
export function deriveCashBalancesByCurrency(
  transactions: readonly CashLedgerTransaction[],
  categories: readonly CashLedgerCategory[],
): CurrencyCashBalance[] {
  const contributions = new Map<string, Cents[]>();
  for (const row of countedCashTransactions(transactions, categories)) {
    if (row.transaction.pending || isTransfer(row.transaction)) continue;
    const bucket = contributions.get(row.currency);
    if (bucket) bucket.push(row.contributionCents);
    else contributions.set(row.currency, [row.contributionCents]);
  }

  return [...contributions.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({ currency, balanceCents: sumCents(cents) }));
}

/**
 * Exact cash balance for one denomination. Passing `currency` is required when
 * the counted ledger contains more than one denomination; an unscoped mixed
 * scalar would violate DEC-004 and therefore fails loudly.
 */
export function deriveCashBalanceCents(
  transactions: readonly CashLedgerTransaction[],
  categories: readonly CashLedgerCategory[],
  options?: { currency?: string },
): Cents {
  const balances = deriveCashBalancesByCurrency(transactions, categories);
  if (options?.currency !== undefined) {
    const currency = normalizeLedgerCurrency(options.currency);
    return balances.find((balance) => balance.currency === currency)?.balanceCents ?? 0;
  }
  if (balances.length > 1) {
    throw new Error(
      `Cash balance spans ${balances.map((balance) => balance.currency).join(", ")}; select one currency`,
    );
  }

  return balances[0]?.balanceCents ?? 0;
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
  options?: { asOfKey?: DateKey },
): AccountBalance[] {
  const asOfKey = options?.asOfKey;
  if (asOfKey !== undefined && !isDateKey(asOfKey)) {
    throw new Error(`deriveAccountBalances: invalid asOfKey ${JSON.stringify(asOfKey)}`);
  }
  const typeOf = categoryTypeIndex(categories);
  const known = new Map(accounts.map((a) => [a.id, a]));
  const accountCurrency = new Map(
    accounts.map((account) => [
      account.id,
      normalizeLedgerCurrency(account.currency, "USD"),
    ]),
  );

  /** Account id -> signed effects, kept as a list for exact summation. */
  const activity = new Map<number, Cents[]>();
  for (const account of accounts) activity.set(account.id, []);
  /** Unknown/unassigned rows can legitimately span currencies, so bucket them separately. */
  const unassignedActivity = new Map<string, Cents[]>();
  const push = (
    accountId: number | null | undefined,
    cents: Cents,
    transactionCurrency: string,
  ) => {
    if (accountId != null && known.has(accountId)) {
      const expected = accountCurrency.get(accountId)!;
      if (transactionCurrency !== expected) {
        throw new Error(
          `Transaction currency ${transactionCurrency} does not match account ${accountId} currency ${expected}`,
        );
      }
      activity.get(accountId)!.push(cents);
      return;
    }
    const bucket = unassignedActivity.get(transactionCurrency);
    if (bucket) bucket.push(cents);
    else unassignedActivity.set(transactionCurrency, [cents]);
  };

  for (const tx of transactions) {
    assertMagnitude(tx.amountCents, "amountCents");
    if (tx.pending) continue;
    const sourceCurrency = normalizeLedgerCurrency(
      tx.currency,
      tx.accountId == null ? "USD" : accountCurrency.get(tx.accountId) ?? "USD",
    );
    if (isTransfer(tx)) {
      // Both legs, same magnitude, opposite signs: net-neutral by construction.
      const destinationCurrency =
        tx.transferAccountId == null
          ? sourceCurrency
          : accountCurrency.get(tx.transferAccountId) ?? sourceCurrency;
      if (destinationCurrency !== sourceCurrency) {
        throw new Error(
          `Cannot derive a cross-currency transfer (${sourceCurrency} to ${destinationCurrency}) without FX`,
        );
      }
      push(tx.accountId, negateCents(tx.amountCents), sourceCurrency);
      push(tx.transferAccountId, tx.amountCents, sourceCurrency);
      continue;
    }
    push(
      tx.accountId,
      categoryEffect(tx, tx.categoryId == null ? undefined : typeOf.get(tx.categoryId)),
      sourceCurrency,
    );
  }

  const rows: AccountBalance[] = accounts.map((account) => {
    const opening = signedOpening(account, asOfKey);
    const activityCents = sumCents(activity.get(account.id) ?? []);
    const balanceCents = sumCents([opening, activityCents]);
    return {
      accountId: account.id,
      currency: accountCurrency.get(account.id)!,
      kind: account.kind,
      openingBalanceCents: account.openingBalanceCents,
      activityCents,
      balanceCents,
      // CONTRACT-012: the stored kind is an input/UI expectation. Current sign
      // alone says whether money is owned or owed (overdrafts and overpayments
      // therefore cross sides without rewriting account metadata).
      owedCents: balanceCents < 0 ? negateCents(balanceCents) : 0,
      archived: account.archived === true,
    };
  });

  for (const [currency, unassigned] of [...unassignedActivity].sort(([a], [b]) => a.localeCompare(b))) {
    const activityCents = sumCents(unassigned);
    rows.push({
      accountId: null,
      currency,
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

  const balances = deriveAccountBalances(accounts, transactions, categories, { asOfKey });

  type BucketParts = {
    assetParts: Cents[];
    liabilityParts: Cents[];
    standaloneParts: Cents[];
    unbackedParts: Cents[];
    unassignedParts: Cents[];
  };
  const buckets = new Map<string, BucketParts>();
  const bucketFor = (currency: string): BucketParts => {
    const existing = buckets.get(currency);
    if (existing) return existing;
    const created: BucketParts = {
      assetParts: [],
      liabilityParts: [],
      standaloneParts: [],
      unbackedParts: [],
      unassignedParts: [],
    };
    buckets.set(currency, created);
    return created;
  };

  for (const row of balances) {
    const bucket = bucketFor(row.currency);
    if (row.accountId === null) {
      bucket.unassignedParts.push(row.balanceCents);
      bucket.assetParts.push(row.balanceCents);
      continue;
    }
    // CONTRACT-012: current sign, never expected account kind, classifies the
    // balance-sheet side. This covers asset overdrafts and liability overpayments.
    if (row.balanceCents < 0) bucket.liabilityParts.push(negateCents(row.balanceCents));
    else bucket.assetParts.push(row.balanceCents);
  }

  const eligible = standaloneAssets.filter(
    (asset) =>
      asset.archived !== true && (includeCashAsset || asset.category !== "Cash"),
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
        currency: normalizeLedgerCurrency(asset.currency, "USD"),
      });
      continue;
    }
    counted.push(asset);
  }

  for (const asset of counted) {
    assertCents(asset.currentValueCents, "currentValueCents");
    const bucket = bucketFor(normalizeLedgerCurrency(asset.currency, "USD"));
    bucket.standaloneParts.push(asset.currentValueCents);
    bucket.assetParts.push(asset.currentValueCents);
    if (asset.acquisitionEvidence === "asset_created_at") {
      bucket.unbackedParts.push(asset.currentValueCents);
    }
  }

  // A brand-new USD-default ledger can still record an honest zero snapshot.
  if (buckets.size === 0) bucketFor("USD");

  const currencyTotals: CurrencyNetWorth[] = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, parts]) => {
      const totalAssetsCents = sumCents(parts.assetParts);
      const totalLiabilitiesCents = sumCents(parts.liabilityParts);
      return {
        currency,
        totalAssetsCents,
        totalLiabilitiesCents,
        netWorthCents: sumCents([totalAssetsCents, negateCents(totalLiabilitiesCents)]),
        standaloneAssetsCents: sumCents(parts.standaloneParts),
        unbackedAssetsCents: sumCents(parts.unbackedParts),
        unassignedCents: sumCents(parts.unassignedParts),
      };
    });
  const aggregate = currencyTotals.length === 1 ? currencyTotals[0] : null;

  return {
    currencyTotals,
    aggregate,
    aggregateCurrency: aggregate?.currency ?? null,
    // Compatibility scalars are zero in mixed state, never the invalid sum.
    // Rendering and persistence use `currencyTotals` / `aggregate` exclusively.
    totalAssetsCents: aggregate?.totalAssetsCents ?? 0,
    totalLiabilitiesCents: aggregate?.totalLiabilitiesCents ?? 0,
    netWorthCents: aggregate?.netWorthCents ?? 0,
    standaloneAssetsCents: aggregate?.standaloneAssetsCents ?? 0,
    unbackedAssetsCents: aggregate?.unbackedAssetsCents ?? 0,
    notYetAcquired,
    unassignedCents: aggregate?.unassignedCents ?? 0,
    accounts: balances,
  };
}
