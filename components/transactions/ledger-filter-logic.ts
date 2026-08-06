/**
 * The ledger's filter predicate — free-text search, date range, month, type,
 * category and account — as pure functions.
 *
 * WHY THIS FILE EXISTS
 *
 * The transactions page shipped with three dropdowns (month, type, category) and
 * nothing else: no free-text search and no date range, so "that coffee thing in
 * March" meant paging through the ledger by hand. Worse, the filtering lived
 * inline in the page component, where no part of it could be tested — including
 * the date comparisons, which are exactly the code most likely to be wrong.
 *
 * Two rules this module is careful about:
 *
 *   - **Dates are CALENDAR DAYS, not instants.** Every comparison happens on
 *     'YYYY-MM-DD' keys produced by `toDateKey` from LOCAL components, so a range
 *     that starts on the 1st contains the 1st in every timezone. Comparing raw
 *     `Date` instants (what the page used to do) drops month-boundary rows east
 *     of UTC. String comparison on 'YYYY-MM-DD' is lexicographic *and*
 *     chronological, so it needs no arithmetic.
 *
 *   - **A transfer is neither income nor expense.** Whether a row is a transfer
 *     is decided by `isTransfer` in lib/cash-balance.ts — the same authority the
 *     budgets page uses — never by an ad-hoc `categoryId === null` check here.
 *     A transfer that (wrongly) carries a category is still a transfer.
 *
 * Filtering is in memory and single-pass over the rows, with the category and
 * account lookups hoisted into Maps by `buildLedgerIndex`, so a few thousand
 * rows re-filter on every keystroke without a visible pause.
 */
import { isTransfer } from "@/lib/cash-balance";
import { monthKey, toDateKey, type DateKey, type MonthKey } from "@/lib/dates";
import type { Cents } from "@/lib/money";

/**
 * The subset of a transaction row the ledger view needs. Deliberately loose
 * about `date` (a `Date` from Drizzle, or a number/string once it has been
 * through serialization) and about the optional columns, so the page can pass
 * its own richer row type straight through.
 */
export type LedgerRow = {
  id?: number;
  date: Date | string | number;
  /** NULL for a transfer, or for a row whose category was deleted. */
  categoryId?: number | null;
  /** The account the money moves out of / into. NULL = unassigned. */
  accountId?: number | null;
  /** Set ONLY on a transfer: the destination account. */
  transferAccountId?: number | null;
  amountCents: Cents;
  comment?: string | null;
  pending?: boolean | null;
};

export type LedgerCategory = { id: number; name: string; type: string; color?: string };
export type LedgerAccountRef = { id: number; name: string };

/** Hoisted lookups, built once per render rather than per row. */
export type LedgerIndex = {
  categories: Map<number, LedgerCategory>;
  accounts: Map<number, LedgerAccountRef>;
};

export function buildLedgerIndex(
  categories: readonly LedgerCategory[],
  accounts: readonly LedgerAccountRef[] = [],
): LedgerIndex {
  return {
    categories: new Map(categories.map((c) => [c.id, c])),
    accounts: new Map(accounts.map((a) => [a.id, a])),
  };
}

/** `null` = every account; `"unassigned"` = only rows with no account. */
export type LedgerAccountFilter = number | "unassigned" | null;

export type LedgerFilters = {
  /** Free text over comment + category name + account names. Empty = no filter. */
  query?: string | null;
  /** 'YYYY-MM' to restrict to one month; null = every month. */
  month?: MonthKey | null;
  /** 'all' | 'income' | 'expense' | 'investment' | 'transfer' (case-insensitive). */
  type?: string | null;
  categoryId?: number | null;
  accountId?: LedgerAccountFilter;
  /** Inclusive 'YYYY-MM-DD' lower bound; null = unbounded. */
  fromKey?: DateKey | null;
  /** Inclusive 'YYYY-MM-DD' upper bound; null = unbounded. */
  toKey?: DateKey | null;
};

/** The calendar day a row falls on, in LOCAL terms. Never via `toISOString()`. */
export function ledgerRowDateKey(row: LedgerRow): DateKey {
  const value = row.date;
  return toDateKey(value instanceof Date ? value : new Date(value));
}

/** The budget month a row falls in, in LOCAL terms. */
export function ledgerRowMonthKey(row: LedgerRow): MonthKey {
  const value = row.date;
  return monthKey(value instanceof Date ? value : new Date(value));
}

/** Lowercase, whitespace-collapsed. `""` means "no query", and matches everything. */
export function normalizeQuery(query: string | null | undefined): string {
  if (typeof query !== "string") return "";
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Everything a row can be searched by, as one normalized haystack: the comment,
 * the category name, the account name and — for a transfer — the destination
 * account name too, so searching "savings" finds the money you moved there.
 */
export function ledgerSearchText(row: LedgerRow, index: LedgerIndex): string {
  const parts: string[] = [];
  if (row.comment) parts.push(row.comment);

  const category = row.categoryId == null ? undefined : index.categories.get(row.categoryId);
  if (category) parts.push(category.name);

  const account = row.accountId == null ? undefined : index.accounts.get(row.accountId);
  if (account) parts.push(account.name);

  const destination =
    row.transferAccountId == null ? undefined : index.accounts.get(row.transferAccountId);
  if (destination) parts.push(destination.name);

  return normalizeQuery(parts.join(" "));
}

/**
 * 'YYYY-MM-DD' keys compare lexicographically, so a backwards range would simply
 * return nothing. Swapping is friendlier than silently showing an empty ledger.
 */
export function normalizeDateRange(
  fromKey: DateKey | null | undefined,
  toKey: DateKey | null | undefined,
): { fromKey: DateKey | null; toKey: DateKey | null } {
  const from = fromKey ?? null;
  const to = toKey ?? null;
  if (from !== null && to !== null && from > to) return { fromKey: to, toKey: from };
  return { fromKey: from, toKey: to };
}

/** Filters with the per-render work (query splitting, range ordering) done once. */
export type PreparedLedgerFilters = {
  /** All of these must appear somewhere in the row's searchable text. */
  terms: string[];
  month: MonthKey | null;
  type: "all" | "income" | "expense" | "investment" | "transfer";
  categoryId: number | null;
  accountId: LedgerAccountFilter;
  fromKey: DateKey | null;
  toKey: DateKey | null;
};

const KNOWN_TYPES = new Set(["all", "income", "expense", "investment", "transfer"]);

export function prepareLedgerFilters(filters: LedgerFilters): PreparedLedgerFilters {
  const normalized = normalizeQuery(filters.query);
  const rawType = typeof filters.type === "string" ? filters.type.trim().toLowerCase() : "all";
  const { fromKey, toKey } = normalizeDateRange(filters.fromKey, filters.toKey);

  return {
    terms: normalized === "" ? [] : normalized.split(" "),
    month: filters.month ?? null,
    type: (KNOWN_TYPES.has(rawType) ? rawType : "all") as PreparedLedgerFilters["type"],
    // `?? null` and not `|| null`: a category id is never 0, but keeping the
    // nullish form makes the falsy-zero trap impossible to reintroduce here.
    categoryId: filters.categoryId ?? null,
    accountId: filters.accountId ?? null,
    fromKey,
    toKey,
  };
}

/** Does this row survive already-prepared filters? */
export function matchesPreparedFilters(
  row: LedgerRow,
  index: LedgerIndex,
  filters: PreparedLedgerFilters,
): boolean {
  const transfer = isTransfer(row);

  // --- type -----------------------------------------------------------------
  if (filters.type === "transfer") {
    if (!transfer) return false;
  } else if (filters.type !== "all") {
    // A transfer is never income, expense or investment — even if the row
    // carries a category, which lib/cash-balance ignores outright.
    if (transfer) return false;
    const category = row.categoryId == null ? undefined : index.categories.get(row.categoryId);
    if ((category?.type ?? "").toLowerCase() !== filters.type) return false;
  }

  // --- category -------------------------------------------------------------
  if (filters.categoryId !== null && row.categoryId !== filters.categoryId) return false;

  // --- account (a transfer belongs to BOTH of its accounts) -----------------
  if (filters.accountId === "unassigned") {
    if (row.accountId != null || row.transferAccountId != null) return false;
  } else if (filters.accountId !== null) {
    if (row.accountId !== filters.accountId && row.transferAccountId !== filters.accountId) {
      return false;
    }
  }

  // --- dates (calendar days, computed once per row) -------------------------
  const needsDate = filters.month !== null || filters.fromKey !== null || filters.toKey !== null;
  if (needsDate) {
    const dateKey = ledgerRowDateKey(row);
    if (filters.month !== null && dateKey.slice(0, 7) !== filters.month) return false;
    if (filters.fromKey !== null && dateKey < filters.fromKey) return false;
    if (filters.toKey !== null && dateKey > filters.toKey) return false;
  }

  // --- free text (last: the most expensive) ---------------------------------
  if (filters.terms.length > 0) {
    const haystack = ledgerSearchText(row, index);
    for (const term of filters.terms) {
      if (!haystack.includes(term)) return false;
    }
  }

  return true;
}

/** Convenience wrapper for a single row (prepares the filters each call). */
export function matchesLedgerFilters(
  row: LedgerRow,
  index: LedgerIndex,
  filters: LedgerFilters,
): boolean {
  return matchesPreparedFilters(row, index, prepareLedgerFilters(filters));
}

/**
 * Apply the filters to a list, preparing them ONCE. Generic so the caller keeps
 * its own row type, and the surviving objects are the very same references.
 */
export function filterLedger<T extends LedgerRow>(
  rows: readonly T[],
  index: LedgerIndex,
  filters: LedgerFilters,
): T[] {
  const prepared = prepareLedgerFilters(filters);
  return rows.filter((row) => matchesPreparedFilters(row, index, prepared));
}

/** True when any filter is actually narrowing the ledger (for a "Clear" button). */
export function hasActiveFilters(filters: LedgerFilters): boolean {
  const prepared = prepareLedgerFilters(filters);
  return (
    prepared.terms.length > 0 ||
    prepared.month !== null ||
    prepared.type !== "all" ||
    prepared.categoryId !== null ||
    prepared.accountId !== null ||
    prepared.fromKey !== null ||
    prepared.toKey !== null
  );
}
