
import { isDateKey, type DateKey } from "./dates";
import { assertCents, negateCents, sumCents, type Cents } from "./money";

type AcquisitionEvidence = "linked_transaction" | "inferred_unique_purchase" | "asset_created_at";

export function normalizeLedgerCurrency(value: unknown, fallback = "USD"): string {
  const raw = typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  const code = raw.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(`Invalid currency: ${JSON.stringify(value)}. Expected a three-letter code.`);
  }
  return code;
}


export type AccountKind = "asset" | "liability";

export type CashLedgerTransaction = {

  categoryId?: number | null;

  amountCents: Cents;

  direction?: "inflow" | "outflow" | "transfer" | null;

  currency?: string | null;
  pending?: boolean | null;

  accountId?: number | null;

  transferAccountId?: number | null;
};

export type CashLedgerCategory = {
  id: number;
  type: string;
};


export type LedgerAccount = {
  id: number;

  kind: string;

  openingBalanceCents: Cents;

  openingBalanceDate?: DateKey | null;

  currency?: string | null;
  archived?: boolean | null;
};

export type AccountBalance = {

  accountId: number | null;

  currency: string;
  kind: string;

  openingBalanceCents: Cents;

  activityCents: Cents;

  balanceCents: Cents;

  owedCents: Cents;
  archived: boolean;
};


export type StandaloneAsset = {

  id?: number;
  category: string;
  currentValueCents: Cents;

  currency?: string | null;

  archived?: boolean | null;

  acquiredOn?: DateKey | null;

  acquisitionEvidence?: AcquisitionEvidence | null;
};


export type NotYetAcquiredAsset = {
  id: number | null;
  category: string;
  acquiredOn: DateKey;

  currentValueCents: Cents;
  currency: string;
};


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

  currencyTotals: CurrencyNetWorth[];

  aggregate: CurrencyNetWorth | null;

  aggregateCurrency: string | null;

  totalAssetsCents: Cents;

  totalLiabilitiesCents: Cents;

  netWorthCents: Cents;

  standaloneAssetsCents: Cents;

  unbackedAssetsCents: Cents;

  notYetAcquired: NotYetAcquiredAsset[];

  unassignedCents: Cents;

  accounts: AccountBalance[];
};


export function isTransfer(tx: CashLedgerTransaction): boolean {
  if (tx.direction !== null && tx.direction !== undefined) return tx.direction === "transfer";
  return tx.transferAccountId !== null && tx.transferAccountId !== undefined;
}


export function isSpendable(tx: CashLedgerTransaction): boolean {
  return !isTransfer(tx) && !tx.pending;
}

export type CategoryCashDirection = "inflow" | "outflow" | "none";


export function categoryCashDirection(categoryType: string | undefined): CategoryCashDirection {
  if (categoryType === "Income") return "inflow";
  if (categoryType === "Expense" || categoryType === "Investment") return "outflow";
  return "none";
}


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


  const activity = new Map<number, Cents[]>();
  for (const account of accounts) activity.set(account.id, []);

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

  standaloneAssets?: readonly StandaloneAsset[];

  includeCashAsset?: boolean;

  asOfKey?: DateKey;
};


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


    if (row.balanceCents < 0) bucket.liabilityParts.push(negateCents(row.balanceCents));
    else bucket.assetParts.push(row.balanceCents);
  }

  const eligible = standaloneAssets.filter(
    (asset) =>
      asset.archived !== true && (includeCashAsset || asset.category !== "Cash"),
  );





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
