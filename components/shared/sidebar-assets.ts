
import {
  ACCOUNT_TYPE_LABELS,
  describeBalance,
  groupAccountsByKind,
  isAccountType,
  presentNetWorth,
  type AccountRow,
  type NetWorthDisplay,
} from "@/components/accounts/account-form-logic";
import {
  formatCurrencyTotals,
  normalizeCurrency,
  totalsByCurrency,
} from "@/components/assets/currency-totals";
import { netWorthCurrencies } from "@/components/dashboard/net-worth-series";
import type { NetWorth } from "@/lib/cash-balance";
import { formatMoney, negateCents, sumCents, type Cents } from "@/lib/money";
import { describePriceSource, pricedHolding } from "@/lib/prices";

export const DERIVED_CASH_CATEGORY = "Cash";

export type SidebarAssetRow = {
  id: number;
  category: string;

  currentValueCents: Cents;
  currency: string;
  notes?: string | null;
  commodityType?: string | null;
  priceSymbol?: string | null;

  quantity?: number | null;
  unit?: string | null;
  archived?: boolean | null;
};

export type SidebarTone = "positive" | "negative" | "neutral";

export type SidebarHolding = {

  key: string;
  name: string;

  detail: string | null;

  amountLabel: string;

  note: string | null;
  tone: SidebarTone;
};

export type SidebarGroupKind = "accounts" | "liabilities" | "assets";

export type SidebarGroup = {

  key: string;
  name: string;
  kind: SidebarGroupKind;

  totalLabel: string;

  mixed: boolean;
  currencies: string[];
  count: number;
  rows: SidebarHolding[];

  emptyMessage: string;

  href: string;
  manageLabel: string;
};

export type SidebarViewInput = {

  netWorth: NetWorth;

  accounts: readonly AccountRow[];

  assets: readonly SidebarAssetRow[];
};

export type SidebarView = {
  groups: SidebarGroup[];

  summary: NetWorthDisplay;

  summaries: Array<NetWorthDisplay & { currency: string }>;

  currency: string;

  mixed: boolean;
  currencies: string[];

  isEmpty: boolean;

  derivedCashCount: number;

  derivedCashLabel: string | null;
};

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0].trim();
  return line === "" ? text.trim() : line;
}

function formatQuantity(quantity: number): string {
  return String(quantity);
}

export function countedAssets<T extends { category: string; archived?: boolean | null }>(
  assets: readonly T[],
): T[] {
  return assets.filter(
    (asset) => asset.category !== DERIVED_CASH_CATEGORY && asset.archived !== true,
  );
}

export function derivedCashAssets<T extends { category: string }>(
  assets: readonly T[],
): T[] {
  return assets.filter((asset) => asset.category === DERIVED_CASH_CATEGORY);
}

export function assetHoldingName(asset: SidebarAssetRow): string {
  const notes = trimOrNull(asset.notes);
  if (notes !== null) return firstLine(notes);
  const symbol = trimOrNull(asset.commodityType) ?? trimOrNull(asset.priceSymbol);
  if (symbol !== null) return symbol;
  return `${asset.category} holding`;
}


export function assetHoldingDetail(asset: SidebarAssetRow): string | null {
  const parts: string[] = [];
  const symbol = trimOrNull(asset.commodityType) ?? trimOrNull(asset.priceSymbol);
  if (symbol !== null && assetHoldingName(asset) !== symbol) parts.push(symbol);

  const quantity = asset.quantity;
  if (quantity !== null && quantity !== undefined && Number.isFinite(quantity)) {
    const unit = trimOrNull(asset.unit);
    parts.push(unit === null ? formatQuantity(quantity) : `${formatQuantity(quantity)} ${unit}`);
  }

  return parts.length === 0 ? null : parts.join(" · ");
}






export function accountHolding(account: AccountRow): SidebarHolding {
  const display = describeBalance(account);
  const type = isAccountType(account.type) ? ACCOUNT_TYPE_LABELS[account.type] : account.type;
  return {
    key: `account-${account.id}`,
    name: account.name,
    detail: account.archived ? `${type} · archived` : type,
    amountLabel: display.amountLabel,
    note: display.note,
    tone: display.tone,
  };
}


export function assetPriceNote(asset: SidebarAssetRow): string | null {
  const spec = pricedHolding(asset.priceSymbol);
  if (spec === null) return null;

  const source = describePriceSource(spec.symbol);
  switch (source.kind) {
    case "proxy":
      return `priced via ${source.badge}`;
    case "none":
      return "no live price source — value not refreshed";
    case "direct":
      return null;
  }
}


export function assetHolding(asset: SidebarAssetRow): SidebarHolding {
  return {
    key: `asset-${asset.id}`,
    name: assetHoldingName(asset),
    detail: assetHoldingDetail(asset),
    amountLabel: formatMoney(asset.currentValueCents, normalizeCurrency(asset.currency)),
    note: assetPriceNote(asset),


    tone:
      asset.currentValueCents > 0
        ? "positive"
        : asset.currentValueCents < 0
          ? "negative"
          : "neutral",
  };
}





type ValuedRow = { currentValueCents: Cents; currency: string };


function subtotal(values: readonly ValuedRow[], fallbackCurrency: string) {
  const totals = totalsByCurrency(values);
  return {
    totalLabel:
      totals.length === 0
        ? formatMoney(0, normalizeCurrency(fallbackCurrency))
        : formatCurrencyTotals(totals),
    mixed: totals.length > 1,
    currencies: totals.map((total) => total.currency),
  };
}


export function buildSidebarGroups(input: SidebarViewInput): SidebarGroup[] {
  const { accounts, assets } = input;
  const { currency } = netWorthCurrencies([...accounts, ...assets]);



  const grouped = groupAccountsByKind(accounts, { includeArchived: true });

  const assetAccounts: SidebarGroup = {
    key: "group:accounts",
    name: "Accounts",
    kind: "accounts",
    ...subtotal(
      grouped.assets.map((row) => ({
        currentValueCents: row.balanceCents,
        currency: row.currency,
      })),
      currency,
    ),
    count: grouped.assets.length,
    rows: grouped.assets.map(accountHolding),
    emptyMessage: "No accounts yet. Add one to give your transactions a home.",
    href: "/accounts",
    manageLabel: "Manage accounts",
  };

  const liabilities: SidebarGroup = {
    key: "group:liabilities",
    name: "Liabilities",
    kind: "liabilities",


    ...subtotal(
      grouped.liabilities.map((row) => ({
        currentValueCents: row.owedCents,
        currency: row.currency,
      })),
      currency,
    ),
    count: grouped.liabilities.length,
    rows: grouped.liabilities.map(accountHolding),
    emptyMessage: "Nothing owed. Add a credit card, loan or mortgage to see it here.",
    href: "/accounts",
    manageLabel: "Manage liabilities",
  };

  const byCategory = new Map<string, SidebarAssetRow[]>();
  for (const asset of countedAssets(assets)) {
    const bucket = byCategory.get(asset.category);
    if (bucket) bucket.push(asset);
    else byCategory.set(asset.category, [asset]);
  }

  const assetGroups: SidebarGroup[] = [...byCategory.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "en"))
    .map(([category, items]) => ({
      key: `category:${category}`,
      name: category,
      kind: "assets" as const,
      ...subtotal(items, currency),
      count: items.length,
      rows: items.map(assetHolding),
      emptyMessage: `No ${category.toLowerCase()} holdings yet.`,
      href: "/",
      manageLabel: "Manage assets",
    }));

  return [assetAccounts, liabilities, ...assetGroups];
}


export function buildSidebarView(input: SidebarViewInput): SidebarView {
  const { netWorth, accounts, assets } = input;



  const currencies = netWorth.currencyTotals.map((total) => total.currency);
  const mixed = netWorth.aggregateCurrency === null;
  const currency = netWorth.aggregateCurrency ?? currencies[0] ?? "USD";
  const groups = buildSidebarGroups(input);
  const cashRows = derivedCashAssets(assets);
  const summaries = netWorth.currencyTotals.map((total) => ({
    ...presentNetWorth(total, total.currency),
    currency: total.currency,
  }));

  return {
    groups,
    summary: summaries[0] ?? { ...presentNetWorth({
      totalAssetsCents: 0,
      totalLiabilitiesCents: 0,
      netWorthCents: 0,
      standaloneAssetsCents: 0,
      unassignedCents: 0,
    }, "USD"), currency: "USD" },
    summaries,
    currency,
    mixed,
    currencies,
    isEmpty: accounts.length === 0 && countedAssets(assets).length === 0,
    derivedCashCount: cashRows.length,
    derivedCashLabel:
      cashRows.length === 0
        ? null
        : formatCurrencyTotals(totalsByCurrency(cashRows)),
  };
}






export function auditSidebarTotals(input: SidebarViewInput): {
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
  standaloneAssetsCents: Cents;
  currencyTotals: Array<{
    currency: string;
    totalAssetsCents: Cents;
    totalLiabilitiesCents: Cents;
    netWorthCents: Cents;
    standaloneAssetsCents: Cents;
  }>;
} {
  const grouped = groupAccountsByKind(input.accounts, { includeArchived: true });
  type Parts = {
    assets: Cents[];
    liabilities: Cents[];
    standalone: Cents[];
  };
  const buckets = new Map<string, Parts>();
  const bucketFor = (currency: string) => {
    const code = normalizeCurrency(currency);
    const existing = buckets.get(code);
    if (existing) return existing;
    const created: Parts = { assets: [], liabilities: [], standalone: [] };
    buckets.set(code, created);
    return created;
  };

  for (const total of input.netWorth.currencyTotals) {
    bucketFor(total.currency).assets.push(total.unassignedCents);
  }
  for (const row of grouped.assets) {
    bucketFor(row.currency).assets.push(row.balanceCents);
  }
  for (const row of grouped.liabilities) {
    const bucket = bucketFor(row.currency);

    if (row.balanceCents < 0) bucket.liabilities.push(negateCents(row.balanceCents));
    else bucket.assets.push(row.balanceCents);
  }

  for (const asset of countedAssets(input.assets)) {
    const bucket = bucketFor(asset.currency);
    bucket.standalone.push(asset.currentValueCents);
    bucket.assets.push(asset.currentValueCents);
  }

  const currencyTotals = [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, parts]) => {
      const totalAssetsCents = sumCents(parts.assets);
      const totalLiabilitiesCents = sumCents(parts.liabilities);
      return {
        currency,
        totalAssetsCents,
        totalLiabilitiesCents,
        netWorthCents: sumCents([totalAssetsCents, negateCents(totalLiabilitiesCents)]),
        standaloneAssetsCents: sumCents(parts.standalone),
      };
    });
  const aggregate = currencyTotals.length === 1 ? currencyTotals[0] : null;

  return {
    totalAssetsCents: aggregate?.totalAssetsCents ?? 0,
    totalLiabilitiesCents: aggregate?.totalLiabilitiesCents ?? 0,
    netWorthCents: aggregate?.netWorthCents ?? 0,
    standaloneAssetsCents: aggregate?.standaloneAssetsCents ?? 0,
    currencyTotals,
  };
}
