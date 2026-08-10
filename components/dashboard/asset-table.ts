/**
 * The home page's assets table, as data.
 *
 * WHY THIS FILE EXISTS
 *
 * 1. **The table was ungrouped while the bar above it was grouped.** The table
 *    rendered `assets.map(...)` — one row per HOLDING — so two crypto holdings
 *    printed two rows both labelled "Crypto", each with its own percentage, while
 *    the allocation bar directly above them (`allocationRows`) had already
 *    collapsed them into a single Crypto slice. The same screen answered "how much
 *    crypto do I hold?" two different ways.
 *
 * 2. **Cash was exiled to a footnote.** The table listed only standalone assets
 *    and printed a paragraph explaining where the owner's cash had gone. Cash is
 *    an asset; it belongs in the list. It is now a line item like any other —
 *    sourced from the ACCOUNT BALANCES, never from the auto-derived `Cash` asset
 *    row. See "THE CASH RULE" below: this is a presentational move, and net worth
 *    is unchanged to the cent (`auditNetWorthFromTable` proves it).
 *
 * 3. **There must not be a third grouping implementation.** The sidebar groups
 *    holdings by category (components/shared/sidebar-assets.ts) and the allocation
 *    bar groups values by (category, currency)
 *    (components/assets/currency-totals.ts). This module adds NO arithmetic of its
 *    own: it calls `allocationRows()` exactly once and hands the *same row objects*
 *    to the bar and to the table, and it builds its holding lines with the
 *    sidebar's own `countedAssets` / `assetHolding` / `accountHolding`. Every
 *    figure the table prints is therefore literally the figure the bar prints —
 *    not a recomputation that happens to agree today.
 *
 * 4. **There is no jsdom in this repo**, so anything inside a component cannot be
 *    unit-tested. Grouping, ordering, the mixed-currency presentation, the
 *    single-holding rule, the default expansion rule and — above all — the
 *    hide/exclude filter and the wording of its warning all live here and are
 *    covered by __tests__/asset-table.test.ts. ./asset-table-card.tsx only renders.
 *
 * FOUR RULES THIS MODULE HOLDS
 *
 *  - NOTHING IS RE-DERIVED. `view.allocations` is the array `allocationRows()`
 *    returned; `category.entries` are elements of that same array, by reference.
 *  - NO FX. A category spanning two currencies is never collapsed into one "$"
 *    figure: it keeps one entry per currency, renders "$1,200.00 + EUR 300.00" and
 *    is flagged `mixed`. There is deliberately no `totalCents` on a category, so
 *    a caller cannot accidentally add currencies together. The same holds for the
 *    hidden subtotal: hiding a USD row and a EUR row reports "$x + €y", never one
 *    number.
 *  - THE CASH RULE (see below).
 *  - A FILTERED TOTAL IS NEVER PRESENTED AS THE REAL ONE. Whenever anything is
 *    hidden the view also carries `filter.unfilteredTotalsLabel` — the honest
 *    figure — and a `filter.notice` sentence that states both. The renderer shows
 *    them together; there is no code path that yields a filtered total with no
 *    accompanying warning, because `filter.active` and `visibleTotalsLabel` are
 *    produced by the same function call.
 *
 * ## THE CASH RULE
 *
 * There are TWO representations of the same money:
 *
 *   - `assets` carries an auto-derived row of category "Cash" that `syncCashAsset`
 *     recomputes from the whole transaction ledger;
 *   - `accounts` carries the real accounts, whose `balanceCents` are derived from
 *     that SAME ledger (plus their opening balances).
 *
 * `deriveNetWorth` counts the accounts and drops the derived `Cash` asset row —
 * counting both would double the owner's cash. This table follows exactly that
 * split: the derived `Cash` asset row is dropped (through the sidebar's own
 * `countedAssets`), and the "Cash" category is built from the ASSET-KIND ACCOUNTS
 * instead. So cash is visible as a line item, and the arithmetic behind net worth
 * is byte-for-byte what it was. `derivedCashCount` / `derivedCashLabel` still
 * report the dropped row so the UI can say which of the two it is showing.
 *
 * Liability accounts are NOT listed here: a mortgage is not an asset, and showing
 * an amount owed inside an "Assets" table as a positive number is the exact lie
 * `describeBalance` exists to prevent. They reach net worth through
 * `deriveNetWorth`, and the sidebar and /accounts list them.
 */
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
import { negateCents, sumCents, type Cents } from "@/lib/money";

/**
 * The category the account-sourced cash lines are filed under.
 *
 * Deliberately the SAME string the derived asset row uses, because they are the
 * same money and the owner should see one "Cash" row, not two. It is safe: the
 * derived row never reaches this table (`countedAssets` drops it by this exact
 * name), so a "Cash" category here is always account-sourced.
 */
export const CASH_CATEGORY = DERIVED_CASH_CATEGORY;

/** Where an account is managed. Assets are managed on this page; accounts are not. */
export const ACCOUNT_MANAGE_HREF = "/accounts";

/**
 * One holding inside a category: exactly the sidebar's line (name, detail,
 * formatted amount, tone) plus the record it came from.
 *
 * A DISCRIMINATED UNION, on purpose. This table owns the per-holding Edit and
 * Delete controls, and those act on an `assets` row. An account line has no
 * `assets` row — offering Delete on it would either do nothing or delete an
 * unrelated asset with a colliding id. `source` forces the renderer to choose,
 * and TypeScript refuses to let `holding.asset.id` be written without checking.
 */
export type AssetTableHolding<T extends SidebarAssetRow> = SidebarHolding &
  (
    | {
        source: "asset";
        /** The `assets` row this line was built from. Edit / Delete act on it. */
        asset: T;
        account: null;
      }
    | {
        source: "account";
        asset: null;
        /** The `accounts` row this line was built from. Managed on /accounts. */
        account: AccountRow;
      }
  );

/**
 * One category row: the collapsed summary the owner asked for, plus the holdings
 * behind it.
 *
 * There is no `totalCents` field, on purpose. A category may span currencies, and
 * the only honest total for that case is a per-currency one — so the numbers live
 * in `entries` (one per currency, straight from `allocationRows`) and the display
 * string in `totalLabel`.
 *
 * Everything here describes the VISIBLE holdings only. A holding the viewer has
 * hidden is not in `holdings`, not in `count`, and not behind `entries` — that is
 * what "hidden means excluded from the totals" means, and it is why `view.filter`
 * must be rendered alongside these figures.
 */
export type AssetCategoryRow<T extends SidebarAssetRow> = {
  /** Stable React key, and what the expanded/collapsed set stores. */
  key: string;
  /** The asset category, e.g. "Crypto". */
  name: string;
  /**
   * This category's (category, currency) allocation rows — the SAME objects the
   * allocation bar renders, in the bar's own order. One entry in the ordinary
   * single-currency case; one per currency otherwise.
   */
  entries: AllocationRow[];
  /** "$1,200.00", or "$1,200.00 + EUR 300.00". Never a cross-currency sum. */
  totalLabel: string;
  /** True when this category spans more than one currency. */
  mixed: boolean;
  currencies: string[];
  /** How many VISIBLE holdings are in this category. Always `holdings.length`. */
  count: number;
  holdings: AssetTableHolding<T>[];
  /**
   * False when the category holds exactly one thing. A disclosure triangle that
   * reveals a single line repeating the total it was hiding is pointless nesting,
   * so such a category renders INLINE: the holding's own detail and its Edit /
   * Delete controls sit on the category row itself.
   */
  collapsible: boolean;
  /** The single holding to render on the row itself when `collapsible` is false. */
  inlineHolding: AssetTableHolding<T> | null;
  /** Whether this category starts expanded. See `ASSET_TABLE_AUTO_EXPAND_LIMIT`. */
  defaultExpanded: boolean;
};

/**
 * What the eye toggles did to the figures, in the words the UI must print.
 *
 * This exists because the owner chose "hiding changes the numbers" over "hiding
 * is cosmetic". That choice is only safe if the filtered state is impossible to
 * miss and impossible to mistake for the truth, so the honest total travels with
 * the filtered one, always, in the same object.
 */
export type AssetTableFilter<T extends SidebarAssetRow> = {
  /** True when at least one holding is hidden. The UI must warn whenever this is true. */
  active: boolean;
  hiddenCount: number;
  visibleCount: number;
  /** Hidden + visible. Not affected by the filter. */
  totalCount: number;
  /** The hidden holdings themselves, in table order, so each can be restored individually. */
  hidden: AssetTableHolding<T>[];
  /** What the hidden holdings are worth, per currency. Never a cross-currency sum. */
  hiddenTotalsLabel: string;
  /** The total INCLUDING everything hidden — i.e. the owner's real asset position. */
  unfilteredTotalsLabel: string;
  /** True when every holding is hidden, so the visible total is $0.00. */
  allHidden: boolean;
  /**
   * A compact marker to sit beside the total, e.g. "1 hidden · $99.62 excluded".
   * `null` when nothing is hidden.
   */
  badgeLabel: string | null;
  /**
   * The full sentence, naming the count, the excluded value and the real total.
   * `null` when nothing is hidden. Lives here rather than in JSX so the wording
   * is unit-tested — a warning that reports the wrong number is worse than none.
   */
  notice: string | null;
};

export type AssetTableView<T extends SidebarAssetRow> = {
  /** Category rows, in the same order as the allocation legend above them. */
  categories: AssetCategoryRow<T>[];
  /**
   * `allocationRows(visible rows)`, computed ONCE. The bar renders this; the table
   * rows reference its elements. That is why the two cannot disagree — including
   * while filtered, since both are filtered by the same single call.
   */
  allocations: AllocationRow[];
  /**
   * Per-currency totals over the same rows — i.e. the very denominators
   * `allocationRows` divided by. The bar draws one track per entry.
   */
  currencyTotals: CurrencyTotal[];
  /**
   * Header subtotal for what is VISIBLE: "$1,200.00" or "$1,200.00 + EUR 300.00",
   * and "$0.00" when everything is hidden. Never render this without
   * `filter.notice` when `filter.active` is true.
   */
  visibleTotalsLabel: string;
  /** True when the VISIBLE holdings span more than one currency. */
  mixed: boolean;
  /**
   * True when there is nothing to list at all — no accounts and no countable
   * standalone assets. Hiding everything does NOT make the table empty: that is
   * `filter.allHidden`, and it needs a warning, not an "add your first asset" card.
   */
  isEmpty: boolean;
  /** The eye-toggle state, and the wording that must accompany it. */
  filter: AssetTableFilter<T>;
  /** How many derived Cash asset rows were left out (0 or 1 in practice). */
  derivedCashCount: number;
  /** What those excluded rows are worth, formatted — for the explanatory note. */
  derivedCashLabel: string | null;
  /** How many asset-kind accounts are listed under "Cash". */
  cashAccountCount: number;
};

/**
 * Expand every category by default while the whole table is at most this many
 * holdings; collapse them all beyond it.
 *
 * WHY A SIZE RULE RATHER THAN A FIXED DEFAULT. The complaint this table fixes is
 * "Crypto appears twice", not "the table is too long" — at the owner's size (4
 * holdings in 3 categories) collapsing everything would hide the lines he can see
 * today and push the per-holding Edit / Delete controls behind a click, which is a
 * functional regression dressed up as tidiness. Grouping alone already fixes the
 * complaint: Crypto is now ONE row, with a total and one percentage, and its
 * holdings are indented underneath it. Past a screenful the trade flips — the
 * summary becomes the point — so the default flips with it. Either way the state
 * is the user's to toggle.
 */
export const ASSET_TABLE_AUTO_EXPAND_LIMIT = 8;

/**
 * Category colours, shared by the allocation bar and the table's category dots so
 * a row and its slice are the same colour. Presentation only.
 */
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

/** The colour for a category, with a neutral fallback for unknown ones. */
export function assetCategoryColor(category: string): string {
  return ASSET_CATEGORY_COLORS[category] ?? "hsl(var(--muted))";
}

// ---------------------------------------------------------------------------
// The hidden set (view state — never persisted, never written to the database)
// ---------------------------------------------------------------------------

/**
 * The keys the viewer has hidden.
 *
 * THIS IS VIEW STATE AND NOTHING ELSE. Nothing in this module, and nothing in
 * ./asset-table-card.tsx, writes it anywhere: no server action, no `assets` row,
 * no localStorage. It lives in a `useState` on the page and dies with the tab.
 *
 * WHY NOT PERSIST IT. Hiding a holding changes the money on screen. A filter the
 * owner set three weeks ago and forgot is precisely how a wrong number becomes a
 * believed number — he would open the app, read "$5,260.91", and be wrong about
 * his own position with no memory of having asked for it. Reloading the page is
 * the one moment the app can guarantee a clean slate, so it takes it. Re-hiding
 * something costs one click; un-believing a number you have been reading for a
 * month costs a lot more.
 */
export type HiddenKeys = ReadonlySet<string> | readonly string[];

const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

function asKeySet(hidden: HiddenKeys | undefined): ReadonlySet<string> {
  if (hidden === undefined) return EMPTY_KEYS;
  return hidden instanceof Set ? hidden : new Set(hidden);
}

/**
 * `current` with `keys` hidden (or shown). Returns a NEW set — React state is not
 * mutated in place — and never mutates the input.
 */
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

/** Every holding key in a category — what the category-level eye toggles. */
export function categoryHoldingKeys<T extends SidebarAssetRow>(
  category: AssetCategoryRow<T>,
): string[] {
  return category.holdings.map((holding) => holding.key);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type AssetTableInput<T extends SidebarAssetRow> = {
  /** Straight from `getAssets()`. The derived Cash row is filtered out here. */
  assets: readonly T[];
  /**
   * Straight from `getAccountBalances({ includeArchived: true })`. Asset-kind rows
   * become the "Cash" category. Archived accounts are INCLUDED: their balances
   * still count towards net worth, so hiding them would make the list stop adding
   * up to the headline above it.
   */
  accounts: readonly AccountRow[];
  /** Holding keys the viewer has hidden. See `HiddenKeys`. */
  hidden?: HiddenKeys;
};

/** One listable line, before grouping: a value, a currency, and the row it prints. */
type ListedRow<T extends SidebarAssetRow> = {
  key: string;
  category: string;
  currency: string;
  currentValueCents: Cents;
  holding: AssetTableHolding<T>;
};

/**
 * Every line this table could list, in reading order: cash accounts first (it is
 * the money you can spend today), then the standalone assets in the order they
 * arrived, exactly as the sidebar's expanded rows do.
 *
 * Category ORDER on screen does not come from here — it comes from the allocation
 * bar (see `buildAssetTable`) — but the order of holdings WITHIN a category does.
 */
function listedRows<T extends SidebarAssetRow>(input: AssetTableInput<T>): ListedRow<T>[] {
  const rows: ListedRow<T>[] = [];

  for (const account of input.accounts) {
    // A liability is not an asset. See THE CASH RULE in the module docstring.
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
      // The net-worth contribution, i.e. exactly the figure `deriveNetWorth` used.
      currentValueCents: account.balanceCents,
      holding,
    });
  }

  for (const asset of countedAssets(input.assets)) {
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

  return rows;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** "1 holding" / "2 holdings" — a count of exactly 0 never reaches this. */
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

  // Per currency, both of them. Hiding a $5 row and a €3 row excludes
  // "$5.00 + €3.00" — there is no exchange rate that would make it one number.
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

/**
 * Everything the assets section renders — bar and table — from one pass over the
 * asset rows and the account balances.
 *
 * Categories are ordered by where they first appear in `allocations`, i.e. by the
 * bar's own order (dominant currency first, then descending value), so the table
 * reads top-to-bottom in the same order as the legend directly above it. The
 * sidebar sorts its categories alphabetically instead; it has no bar to agree
 * with, and ordering is presentation, not arithmetic — the figures are identical.
 *
 * FILTERING HAPPENS EXACTLY ONCE, here, before `allocationRows` is called. That is
 * what makes the percentages recompute against the visible subset for free, and
 * what keeps `category.entries` reference-identical to `view.allocations` whether
 * or not anything is hidden. Nothing downstream re-filters.
 */
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

  // THE single call. Everything below reads from these two results.
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

  // A holding worth exactly 0 is a real holding and is counted here like any
  // other: this is `visible.length`, never a filter on value.
  const autoExpand = visible.length <= ASSET_TABLE_AUTO_EXPAND_LIMIT;

  const categories: AssetCategoryRow<T>[] = order.map((name) => {
    const entries = entriesByCategory.get(name) ?? [];
    const holdings = holdingsByCategory.get(name) ?? [];
    const collapsible = holdings.length > 1;

    return {
      key: `category:${name}`,
      name,
      entries,
      // Built from `entries`, so even this string is the allocation figures and
      // not a second sum of the same rows.
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
    // `formatCurrencyTotals([])` is "$0.00": with everything hidden the visible
    // total is zero, which is a fact, not a missing value — and never "NaN".
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

/**
 * The keys that start expanded, for the component's initial state.
 *
 * A non-collapsible (single-holding) category is never in this set: it has no
 * disclosure control at all, so "expanded" would be meaningless for it.
 */
export function defaultExpandedKeys<T extends SidebarAssetRow>(
  view: AssetTableView<T>,
): Set<string> {
  return new Set(
    view.categories.filter((category) => category.defaultExpanded).map((category) => category.key),
  );
}

// ---------------------------------------------------------------------------
// Audit (tests only)
// ---------------------------------------------------------------------------

/**
 * Reconstruct net worth from EXACTLY the rows this table lists, plus the two
 * things it deliberately does not list.
 *
 * THIS IS A TEST INSTRUMENT, in the mould of `auditSidebarTotals`. The component
 * must never call it: re-deriving net worth in the UI is the whole class of bug
 * this module exists to prevent, and the page's headline comes from
 * `getNetWorth()`. Its only job is to let a test assert that moving cash INTO the
 * assets list did not move net worth by a cent — that the "Cash" line is the
 * account balances `deriveNetWorth` already counted, and not a second helping of
 * the same money via the derived `Cash` asset row.
 *
 * It sums the UNFILTERED listing on purpose: hiding a holding is a view filter,
 * so feeding a `hidden` set in must produce the identical net worth. A test
 * asserts exactly that.
 *
 * `unassignedCents` is taken from the supplied totals rather than recomputed:
 * `getAccountBalances()` returns only real account rows, so transactions with no
 * account are not among this table's rows.
 *
 * Currencies are added together here for the same reason `deriveNetWorth` does —
 * there is no FX source. That is why nothing renders this number.
 */
export function auditNetWorthFromTable<T extends SidebarAssetRow>(
  input: AssetTableInput<T>,
  extras: { unassignedCents: Cents },
): {
  /** Everything the table lists, unfiltered, summed across currencies. */
  listedCents: Cents;
  /** The "Cash" category's share of that — i.e. the asset-kind account balances. */
  cashCents: Cents;
  /** The standalone-asset share of that — i.e. `NetWorth.standaloneAssetsCents`. */
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
    rows.filter((row) => row.holding.source === "asset").map((row) => row.currentValueCents),
  );
  const listedCents = sumCents([cashCents, standaloneAssetsCents]);

  const assetParts: Cents[] = [listedCents, extras.unassignedCents];
  const liabilityParts: Cents[] = [];
  for (const account of input.accounts) {
    if ((account.balanceKind ?? account.kind) !== "liability") continue;
    // Mirrors deriveNetWorth: owed is a liability, overpaid is an asset.
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
