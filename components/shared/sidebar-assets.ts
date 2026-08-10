/**
 * The sidebar's net-worth panel, as data.
 *
 * WHY THIS FILE EXISTS
 *
 * 1. **The sidebar was a second, disagreeing source of truth.** It called
 *    `getAssets()` and grouped the raw `assets` rows by category. That list
 *    INCLUDES the auto-derived `Cash` row, which `deriveNetWorth` deliberately
 *    excludes from `standaloneAssets` because it is computed from the same ledger
 *    the account balances are computed from — counting both doubles the user's
 *    cash. So the sidebar printed a Cash figure the home page had deliberately
 *    left out, and showed no accounts at all: a mortgage was invisible in the one
 *    piece of chrome that is on every single page.
 *
 *    The panel now reads `getNetWorth()` + `getAccountBalances()` — the same pair
 *    the dashboard and /accounts use — and formats them with the same
 *    `presentNetWorth`. `auditSidebarTotals` below exists so a test can prove the
 *    rows drawn here add up to exactly the figures the action supplied.
 *
 * 2. **There is no jsdom in this repo**, so anything inside a component cannot be
 *    unit-tested. Grouping, ordering, per-currency subtotals, liability
 *    presentation and the contents of an expanded row are all decisions that would
 *    be expensive to get wrong, so they live here and are covered by
 *    __tests__/sidebar-assets.test.ts. components/shared/sidebar.tsx only renders.
 *
 * THREE RULES THIS MODULE HOLDS
 *
 *  - NET WORTH IS NOT RE-DERIVED. `presentNetWorth` echoes what `getNetWorth()`
 *    returned. `auditSidebarTotals` is a TEST instrument and is never rendered.
 *  - A LIABILITY IS NOT A NEGATIVE ASSET. Every liability figure here is the
 *    amount OWED, as a positive magnitude, via `describeBalance`.
 *  - NO FX. There is no exchange-rate source in this app, so a group spanning two
 *    currencies renders "$1,200.00 + LBP 500.00" and is flagged, never a single
 *    "$" figure. See components/assets/currency-totals.ts.
 */
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

/**
 * The category of the asset row `syncCashAsset` maintains from the ledger.
 * `deriveNetWorth` excludes it from `standaloneAssets` by this exact name; the
 * sidebar must exclude it by the same one or the two disagree.
 */
export const DERIVED_CASH_CATEGORY = "Cash";

/** The `assets` columns this panel needs. Everything else is ignored. */
export type SidebarAssetRow = {
  id: number;
  category: string;
  /** Current value in integer cents, denominated in `currency`. */
  currentValueCents: Cents;
  currency: string;
  notes?: string | null;
  commodityType?: string | null;
  priceSymbol?: string | null;
  /** A weight or a coin count — NOT money, so a real. `0` is a real quantity. */
  quantity?: number | null;
  unit?: string | null;
  archived?: boolean | null;
};

export type SidebarTone = "positive" | "negative" | "neutral";

/** One line inside an expanded group. */
export type SidebarHolding = {
  /** Stable React key. */
  key: string;
  name: string;
  /** Second line: account type, commodity, quantity — or null when there is none. */
  detail: string | null;
  /** Already formatted in the row's OWN currency. */
  amountLabel: string;
  /** "owed", "overdrawn", "in credit — overpaid", … or null. */
  note: string | null;
  tone: SidebarTone;
};

export type SidebarGroupKind = "accounts" | "liabilities" | "assets";

export type SidebarGroup = {
  /** Stable key, also what the expanded/collapsed set stores. */
  key: string;
  name: string;
  kind: SidebarGroupKind;
  /** Per-currency subtotal string. Never a cross-currency sum. */
  totalLabel: string;
  /** True when the group spans more than one currency. */
  mixed: boolean;
  currencies: string[];
  count: number;
  rows: SidebarHolding[];
  /** Shown when the group is expanded and has no rows. */
  emptyMessage: string;
  /** The page that OWNS these records. */
  href: string;
  manageLabel: string;
};

export type SidebarViewInput = {
  /** Straight from `getNetWorth()`. Echoed, never recomputed. */
  netWorth: NetWorth;
  /** Straight from `getAccountBalances({ includeArchived: true })`. */
  accounts: readonly AccountRow[];
  /** Straight from `getAssets()`. The derived Cash row is filtered out here. */
  assets: readonly SidebarAssetRow[];
};

export type SidebarView = {
  groups: SidebarGroup[];
  /** First denomination, retained as the single-currency compatibility view. */
  summary: NetWorthDisplay;
  /** Every denomination-scoped summary; the renderer always uses this list. */
  summaries: Array<NetWorthDisplay & { currency: string }>;
  /** The currency the totals may honestly be labelled with. */
  currency: string;
  /** True when accounts/assets disagree about currency, so the label is a caveat. */
  mixed: boolean;
  currencies: string[];
  /** Nothing at all to show — no accounts and no countable standalone assets. */
  isEmpty: boolean;
  /** How many derived Cash rows were excluded (0 or 1 in practice). */
  derivedCashCount: number;
  /** What that excluded row is worth, formatted — for the explanatory note. */
  derivedCashLabel: string | null;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Notes may be a paragraph; a sidebar row gets the first line of it. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0].trim();
  return line === "" ? text.trim() : line;
}

/**
 * A quantity is a real (grams, troy ounces, a fractional coin count), not money,
 * so it is rendered as-is rather than through `formatMoney`. Written out with
 * `String` rather than `toLocaleString` so 0.0345 BTC never becomes "0.035".
 */
function formatQuantity(quantity: number): string {
  return String(quantity);
}

// ---------------------------------------------------------------------------
// Standalone assets
// ---------------------------------------------------------------------------

/**
 * The standalone asset rows that COUNT — i.e. exactly the ones `deriveNetWorth`
 * put into `standaloneAssetsCents`.
 *
 * The derived Cash row is dropped. It mirrors the ledger, and the ledger already
 * reaches net worth through the account balances; listing it here would show the
 * user a figure the home page deliberately left out and imply their cash is worth
 * twice what it is.
 */
export function countedAssets<T extends { category: string; archived?: boolean | null }>(
  assets: readonly T[],
): T[] {
  return assets.filter(
    (asset) => asset.category !== DERIVED_CASH_CATEGORY && asset.archived !== true,
  );
}

/** The derived Cash rows that were excluded, so the UI can explain the absence. */
export function derivedCashAssets<T extends { category: string }>(
  assets: readonly T[],
): T[] {
  return assets.filter((asset) => asset.category === DERIVED_CASH_CATEGORY);
}

/**
 * What an individual holding is called in an expanded row.
 *
 * The `assets` table has no name column, so the label is the most specific thing
 * the row actually carries: the user's note, else the commodity/price symbol,
 * else a generic "<Category> holding". Never blank — a nameless row still has to
 * be clickable and readable.
 */
export function assetHoldingName(asset: SidebarAssetRow): string {
  const notes = trimOrNull(asset.notes);
  if (notes !== null) return firstLine(notes);
  const symbol = trimOrNull(asset.commodityType) ?? trimOrNull(asset.priceSymbol);
  if (symbol !== null) return symbol;
  return `${asset.category} holding`;
}

/**
 * The second line of an expanded asset row: what it is and how much of it there
 * is. `null` when the row carries neither.
 *
 * A quantity of `0` is a REAL quantity and is printed. `asset.quantity ? …` would
 * hide it — the falsy-zero mistake this codebase has already made four times.
 */
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

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One account as a sidebar row. The amount comes from `describeBalance`, which is
 * the same function /accounts and the dashboard use — so a $600 card debt reads
 * "$600.00 owed" here exactly as it does there, and never "-$600.00".
 */
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

/**
 * What the user must be told about where this row's NUMBER came from, or null
 * when there is nothing to disclose.
 *
 * Two cases, and both of them are the whole reason this function exists:
 *
 *  - PROXY. Gold and silver are not priced from a gold or silver quote. They are
 *    priced from the market price of a token that claims to represent one troy
 *    ounce (PAXG, KAG). The owner is fine with that; the owner is NOT fine with
 *    not knowing. So every row valued that way says so, next to the money,
 *    everywhere the money appears — the sidebar and the home page's assets table
 *    both build their lines from this function.
 *
 *  - NO SOURCE. Platinum and palladium have no keyless per-ounce feed at all, so
 *    a row carrying XPT/XPD keeps whatever value it was last given and can never
 *    be refreshed. Saying nothing would present a hand-typed, possibly ancient
 *    figure as if it were live. It is marked instead.
 *
 * Rows with no `price_symbol` are hand-valued and get nothing: there is no
 * pricing claim to qualify. BTC/ETH get nothing either — CoinGecko quotes those
 * coins directly, so the price IS the thing.
 */
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

/** One standalone asset as a sidebar row. */
export function assetHolding(asset: SidebarAssetRow): SidebarHolding {
  return {
    key: `asset-${asset.id}`,
    name: assetHoldingName(asset),
    detail: assetHoldingDetail(asset),
    amountLabel: formatMoney(asset.currentValueCents, normalizeCurrency(asset.currency)),
    note: assetPriceNote(asset),
    // A holding worth exactly 0 is a real holding, not a missing one: it is shown,
    // counted, and rendered neutral rather than dressed up as a gain.
    tone:
      asset.currentValueCents > 0
        ? "positive"
        : asset.currentValueCents < 0
          ? "negative"
          : "neutral",
  };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

type ValuedRow = { currentValueCents: Cents; currency: string };

/**
 * Per-currency subtotal for a group.
 *
 * An EMPTY group is `$0.00` in the panel's currency — a group with no holdings
 * has a total of zero, which is a fact, not a missing value.
 */
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

/**
 * The panel's groups, in reading order: the accounts you hold, what you owe, then
 * each standalone asset category.
 *
 * The two account groups are ALWAYS present, even when empty, because "you have
 * no liabilities" is information and an absent section is not. Asset categories
 * appear only when they have holdings, sorted by name — with no FX source there
 * is no honest way to order categories by size across currencies, and a stable
 * alphabetical order beats a magnitude order that silently compares LBP to USD.
 */
export function buildSidebarGroups(input: SidebarViewInput): SidebarGroup[] {
  const { accounts, assets } = input;
  const { currency } = netWorthCurrencies([...accounts, ...assets]);

  // Archived accounts INCLUDED: their balances still count towards the net worth
  // printed above them, so hiding them would make the rows stop adding up.
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
    // `owedCents`, never `balanceCents`: this group is what is OWED, as a positive
    // magnitude. An overpaid card owes 0 and says so.
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

/**
 * Everything the sidebar panel renders.
 *
 * The headline figures are `presentNetWorth(netWorth, …)` — a pure format of what
 * `getNetWorth()` returned. No subtraction happens here, which is precisely why
 * this panel cannot print a different net worth from the home page.
 */
export function buildSidebarView(input: SidebarViewInput): SidebarView {
  const { netWorth, accounts, assets } = input;

  // The same currency check the dashboard performs, over the same two lists, so
  // the two headlines carry the same symbol or the same caveat.
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

// ---------------------------------------------------------------------------
// Audit (tests only)
// ---------------------------------------------------------------------------

/**
 * Add up EXACTLY the rows the sidebar draws and return them in `getNetWorth()`'s
 * shape.
 *
 * THIS IS A TEST INSTRUMENT. The component must never call it: `presentNetWorth`
 * echoes the figures the action supplies, and re-deriving net worth in the UI is
 * the whole class of bug this module exists to prevent. Its only job is to let a
 * test assert `auditSidebarTotals(input)` equals the `getNetWorth()` figures fed
 * into the same input — i.e. that what the user sees listed is what the headline
 * claims, with nothing double-counted and nothing dropped.
 *
 * `unassignedCents` is taken from the supplied totals rather than recomputed:
 * `getAccountBalances()` returns only real account rows, so transactions with no
 * account are not among the sidebar's rows. The panel prints that figure
 * separately (`summary.unassignedLabel`) instead of letting it vanish.
 *
 * The audit is currency-scoped for the same reason as `deriveNetWorth`: without
 * FX, even test-only arithmetic must not manufacture a mixed scalar.
 */
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
    // Mirrors deriveNetWorth: owed is a liability, overpaid is an asset.
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
