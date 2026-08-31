
import type { AccountRow } from "@/components/accounts/account-form-logic";
import {
  allocationRows,
  formatCurrencyTotals,
  totalsByCurrency,
  type AllocationRow,
  type CurrencyTotal,
} from "@/components/assets/currency-totals";
import {
  accountHolding,
  assetHolding,
  countedAssets,
  derivedCashAssets,
  DERIVED_CASH_CATEGORY,
  type SidebarAssetRow,
  type SidebarHolding,
} from "@/components/shared/sidebar-assets";
import { formatMoney, negateCents, sumCents, type Cents } from "@/lib/money";
import { addCanonicalDecimals } from "@/lib/ledger/decimal";

export const CASH_CATEGORY = DERIVED_CASH_CATEGORY;

export const ACCOUNT_MANAGE_HREF = "/accounts";

export type AssetTableHolding<T extends SidebarAssetRow> = SidebarHolding &
  (
    | {
        source: "asset";

        asset: T;
        account: null;
      }
    | {
        source: "account";
        asset: null;

        account: AccountRow;
      }
    | {
        source: "crypto-summary";
        asset: null;
        account: null;
      }
  );

export type AssetCategoryRow<T extends SidebarAssetRow> = {

  key: string;

  name: string;

  entries: AllocationRow[];

  totalLabel: string;

  mixed: boolean;
  currencies: string[];

  count: number;
  holdings: AssetTableHolding<T>[];

  collapsible: boolean;

  inlineHolding: AssetTableHolding<T> | null;

  defaultExpanded: boolean;
};

export type AssetTableFilter<T extends SidebarAssetRow> = {

  active: boolean;
  hiddenCount: number;
  visibleCount: number;

  totalCount: number;

  hidden: AssetTableHolding<T>[];

  hiddenTotalsLabel: string;

  unfilteredTotalsLabel: string;

  allHidden: boolean;

  badgeLabel: string | null;

  notice: string | null;
};

export type AssetTableView<T extends SidebarAssetRow> = {

  categories: AssetCategoryRow<T>[];

  allocations: AllocationRow[];

  currencyTotals: CurrencyTotal[];

  visibleTotalsLabel: string;

  mixed: boolean;

  isEmpty: boolean;

  filter: AssetTableFilter<T>;

  derivedCashCount: number;

  derivedCashLabel: string | null;

  cashAccountCount: number;
};

export const ASSET_TABLE_AUTO_EXPAND_LIMIT = 8;

export const ASSET_CATEGORY_COLORS: Record<string, string> = {
  Cash: "hsl(var(--chart-1))",
  Savings: "hsl(var(--chart-2))",
  Investments: "#10b981",
  Crypto: "#ff57eb",
  Properties: "hsl(var(--chart-5))",
  Vehicles: "#8b5cf6",
  Commodities: "hsl(var(--chart-3))",
  Other: "#6b7280",
};

export function assetCategoryColor(category: string): string {
  return ASSET_CATEGORY_COLORS[category] ?? "hsl(var(--muted))";
}

export type HiddenKeys = ReadonlySet<string> | readonly string[];

const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

function asKeySet(hidden: HiddenKeys | undefined): ReadonlySet<string> {
  if (hidden === undefined) return EMPTY_KEYS;
  return hidden instanceof Set ? hidden : new Set(hidden);
}

export function withHidden(
  current: HiddenKeys,
  keys: readonly string[],
  hidden: boolean,
): Set<string> {
  const next = new Set(asKeySet(current));
  for (const key of keys) {
    if (hidden) next.add(key);
    else next.delete(key);
  }
  return next;
}

export function categoryHoldingKeys<T extends SidebarAssetRow>(
  category: AssetCategoryRow<T>,
): string[] {
  return category.holdings.map((holding) => holding.key);
}

export type AssetTableInput<T extends SidebarAssetRow> = {

  assets: readonly T[];

  accounts: readonly AccountRow[];

  hidden?: HiddenKeys;
};

type ListedRow<T extends SidebarAssetRow> = {
  key: string;
  category: string;
  currency: string;
  currentValueCents: Cents;
  holding: AssetTableHolding<T>;
};

function listedRows<T extends SidebarAssetRow>(input: AssetTableInput<T>): ListedRow<T>[] {
  const rows: ListedRow<T>[] = [];

  for (const account of input.accounts) {

    if ((account.balanceKind ?? account.kind) === "liability") continue;
    const holding: AssetTableHolding<T> = {
      ...accountHolding(account),
      source: "account",
      asset: null,
      account,
    };
    rows.push({
      key: holding.key,
      category: CASH_CATEGORY,
      currency: account.currency,

      currentValueCents: account.balanceCents,
      holding,
    });
  }

  const cryptoGroups = new Map<string, T[]>();
  for (const asset of countedAssets(input.assets)) {
    if (asset.category === "Crypto" && asset.priceSymbol && asset.quantityExact) {
      const key = `${asset.priceSymbol}\u0000${asset.currency}`;
      const group = cryptoGroups.get(key);
      if (group) group.push(asset);
      else cryptoGroups.set(key, [asset]);
      continue;
    }
    const holding: AssetTableHolding<T> = {
      ...assetHolding(asset),
      source: "asset",
      asset,
      account: null,
    };
    rows.push({
      key: holding.key,
      category: asset.category,
      currency: asset.currency,
      currentValueCents: asset.currentValueCents,
      holding,
    });
  }

  for (const [key, assets] of cryptoGroups) {
    const [first] = assets;
    const valueCents = sumCents(assets.map((asset) => asset.currentValueCents));
    const quantity = assets.reduce(
      (total, asset) => addCanonicalDecimals(total, asset.quantityExact!),
      "0",
    );
    const symbol = first.priceSymbol!;
    const holding: AssetTableHolding<T> = {
      key: `crypto:${key}`,
      name: symbol,
      detail: `${quantity} coins`,
      amountLabel: formatMoney(valueCents, first.currency),
      note: null,
      tone: valueCents > 0 ? "positive" : valueCents < 0 ? "negative" : "neutral",
      source: "crypto-summary",
      asset: null,
      account: null,
    };
    rows.push({
      key: holding.key,
      category: "Crypto",
      currency: first.currency,
      currentValueCents: valueCents,
      holding,
    });
  }

  return rows;
}

function holdingWord(count: number): string {
  return count === 1 ? "holding" : "holdings";
}

function buildFilter<T extends SidebarAssetRow>(
  all: readonly ListedRow<T>[],
  hiddenRows: readonly ListedRow<T>[],
): AssetTableFilter<T> {
  const hiddenCount = hiddenRows.length;
  const totalCount = all.length;
  const visibleCount = totalCount - hiddenCount;

  const hiddenTotalsLabel = formatCurrencyTotals(totalsByCurrency(hiddenRows));
  const unfilteredTotalsLabel = formatCurrencyTotals(totalsByCurrency(all));

  const active = hiddenCount > 0;

  return {
    active,
    hiddenCount,
    visibleCount,
    totalCount,
    hidden: hiddenRows.map((row) => row.holding),
    hiddenTotalsLabel,
    unfilteredTotalsLabel,
    allHidden: totalCount > 0 && visibleCount === 0,
    badgeLabel: active ? `${hiddenCount} hidden · ${hiddenTotalsLabel} excluded` : null,
    notice: active
      ? `Filtered view: ${hiddenCount} of ${totalCount} ${holdingWord(totalCount)} hidden, ` +
        `worth ${hiddenTotalsLabel}. The total and percentages below leave ` +
        `${hiddenCount === 1 ? "it" : "them"} out; your full assets total is ` +
        `${unfilteredTotalsLabel}.`
      : null,
  };
}


export function buildAssetTable<T extends SidebarAssetRow>(
  input: AssetTableInput<T>,
): AssetTableView<T> {
  const all = listedRows(input);
  const hiddenKeys = asKeySet(input.hidden);

  const visible: ListedRow<T>[] = [];
  const hiddenRows: ListedRow<T>[] = [];
  for (const row of all) {
    if (hiddenKeys.has(row.key)) hiddenRows.push(row);
    else visible.push(row);
  }


  const allocations = allocationRows(visible);
  const currencyTotals = totalsByCurrency(visible);

  const entriesByCategory = new Map<string, AllocationRow[]>();
  const order: string[] = [];
  for (const entry of allocations) {
    const existing = entriesByCategory.get(entry.type);
    if (existing) {
      existing.push(entry);
    } else {
      entriesByCategory.set(entry.type, [entry]);
      order.push(entry.type);
    }
  }

  const holdingsByCategory = new Map<string, AssetTableHolding<T>[]>();
  for (const row of visible) {
    const bucket = holdingsByCategory.get(row.category);
    if (bucket) bucket.push(row.holding);
    else holdingsByCategory.set(row.category, [row.holding]);
  }



  const autoExpand = visible.length <= ASSET_TABLE_AUTO_EXPAND_LIMIT;

  const categories: AssetCategoryRow<T>[] = order.map((name) => {
    const entries = entriesByCategory.get(name) ?? [];
    const holdings = holdingsByCategory.get(name) ?? [];
    const collapsible = holdings.length > 1;

    return {
      key: `category:${name}`,
      name,
      entries,


      totalLabel: formatCurrencyTotals(
        entries.map((entry) => ({
          currency: entry.currency,
          totalCents: entry.totalCents,
          count: entry.count,
        })),
      ),
      mixed: entries.length > 1,
      currencies: entries.map((entry) => entry.currency),
      count: holdings.length,
      holdings,
      collapsible,
      inlineHolding: collapsible ? null : (holdings[0] ?? null),
      defaultExpanded: collapsible && autoExpand,
    };
  });

  const cashRows = derivedCashAssets(input.assets);

  return {
    categories,
    allocations,
    currencyTotals,


    visibleTotalsLabel: formatCurrencyTotals(currencyTotals),
    mixed: currencyTotals.length > 1,
    isEmpty: all.length === 0,
    filter: buildFilter(all, hiddenRows),
    derivedCashCount: cashRows.length,
    derivedCashLabel:
      cashRows.length === 0 ? null : formatCurrencyTotals(totalsByCurrency(cashRows)),
    cashAccountCount: all.filter((row) => row.holding.source === "account").length,
  };
}


export function defaultExpandedKeys<T extends SidebarAssetRow>(
  view: AssetTableView<T>,
): Set<string> {
  return new Set(
    view.categories.filter((category) => category.defaultExpanded).map((category) => category.key),
  );
}






export function auditNetWorthFromTable<T extends SidebarAssetRow>(
  input: AssetTableInput<T>,
  extras: { unassignedCents: Cents },
): {

  listedCents: Cents;

  cashCents: Cents;

  standaloneAssetsCents: Cents;
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
} {
  const rows = listedRows(input);
  const cashCents = sumCents(
    rows.filter((row) => row.holding.source === "account").map((row) => row.currentValueCents),
  );
  const standaloneAssetsCents = sumCents(
    rows.filter((row) => row.holding.source === "asset" || row.holding.source === "crypto-summary")
      .map((row) => row.currentValueCents),
  );
  const listedCents = sumCents([cashCents, standaloneAssetsCents]);

  const assetParts: Cents[] = [listedCents, extras.unassignedCents];
  const liabilityParts: Cents[] = [];
  for (const account of input.accounts) {
    if ((account.balanceKind ?? account.kind) !== "liability") continue;

    if (account.balanceCents < 0) liabilityParts.push(negateCents(account.balanceCents));
    else assetParts.push(account.balanceCents);
  }

  const totalAssetsCents = sumCents(assetParts);
  const totalLiabilitiesCents = sumCents(liabilityParts);

  return {
    listedCents,
    cashCents,
    standaloneAssetsCents,
    totalAssetsCents,
    totalLiabilitiesCents,
    netWorthCents: sumCents([totalAssetsCents, negateCents(totalLiabilitiesCents)]),
  };
}
