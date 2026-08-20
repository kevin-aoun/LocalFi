
import { isTransfer } from "@/lib/cash-balance";
import { monthKey, toDateKey, type DateKey, type MonthKey } from "@/lib/dates";
import type { Cents } from "@/lib/money";

export type LedgerRow = {
  id?: number;
  date: Date | string | number;

  categoryId?: number | null;

  accountId?: number | null;

  transferAccountId?: number | null;
  amountCents: Cents;
  comment?: string | null;
  pending?: boolean | null;
};

export type LedgerCategory = { id: number; name: string; type: string; color?: string };
export type LedgerAccountRef = { id: number; name: string };
export type LedgerSortColumn = "date" | "category" | "amount";
export type LedgerSortDirection = "asc" | "desc";

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

export type LedgerAccountFilter = number | "unassigned" | null;

export type LedgerFilters = {

  query?: string | null;

  month?: MonthKey | null;

  type?: string | null;
  categoryId?: number | null;
  accountId?: LedgerAccountFilter;

  fromKey?: DateKey | null;

  toKey?: DateKey | null;
};

export function ledgerRowDateKey(row: LedgerRow): DateKey {
  const value = row.date;
  return toDateKey(value instanceof Date ? value : new Date(value));
}

export function ledgerRowMonthKey(row: LedgerRow): MonthKey {
  const value = row.date;
  return monthKey(value instanceof Date ? value : new Date(value));
}

export function normalizeQuery(query: string | null | undefined): string {
  if (typeof query !== "string") return "";
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

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

export function normalizeDateRange(
  fromKey: DateKey | null | undefined,
  toKey: DateKey | null | undefined,
): { fromKey: DateKey | null; toKey: DateKey | null } {
  const from = fromKey ?? null;
  const to = toKey ?? null;
  if (from !== null && to !== null && from > to) return { fromKey: to, toKey: from };
  return { fromKey: from, toKey: to };
}

export type PreparedLedgerFilters = {

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

    categoryId: filters.categoryId ?? null,
    accountId: filters.accountId ?? null,
    fromKey,
    toKey,
  };
}

export function matchesPreparedFilters(
  row: LedgerRow,
  index: LedgerIndex,
  filters: PreparedLedgerFilters,
): boolean {
  const transfer = isTransfer(row);

  if (filters.type === "transfer") {
    if (!transfer) return false;
  } else if (filters.type !== "all") {

    if (transfer) return false;
    const category = row.categoryId == null ? undefined : index.categories.get(row.categoryId);
    if ((category?.type ?? "").toLowerCase() !== filters.type) return false;
  }

  if (filters.categoryId !== null && row.categoryId !== filters.categoryId) return false;

  if (filters.accountId === "unassigned") {
    if (row.accountId != null || row.transferAccountId != null) return false;
  } else if (filters.accountId !== null) {
    if (row.accountId !== filters.accountId && row.transferAccountId !== filters.accountId) {
      return false;
    }
  }

  const needsDate = filters.month !== null || filters.fromKey !== null || filters.toKey !== null;
  if (needsDate) {
    const dateKey = ledgerRowDateKey(row);
    if (filters.month !== null && dateKey.slice(0, 7) !== filters.month) return false;
    if (filters.fromKey !== null && dateKey < filters.fromKey) return false;
    if (filters.toKey !== null && dateKey > filters.toKey) return false;
  }

  if (filters.terms.length > 0) {
    const haystack = ledgerSearchText(row, index);
    for (const term of filters.terms) {
      if (!haystack.includes(term)) return false;
    }
  }

  return true;
}

export function matchesLedgerFilters(
  row: LedgerRow,
  index: LedgerIndex,
  filters: LedgerFilters,
): boolean {
  return matchesPreparedFilters(row, index, prepareLedgerFilters(filters));
}

export function filterLedger<T extends LedgerRow>(
  rows: readonly T[],
  index: LedgerIndex,
  filters: LedgerFilters,
): T[] {
  const prepared = prepareLedgerFilters(filters);
  return rows.filter((row) => matchesPreparedFilters(row, index, prepared));
}

export function sortLedger<T extends LedgerRow>(
  rows: readonly T[],
  index: LedgerIndex,
  column: LedgerSortColumn = "date",
  direction: LedgerSortDirection = "desc",
): T[] {
  const labelOf = (row: LedgerRow) =>
    isTransfer(row)
      ? "Transfer"
      : (row.categoryId == null ? "" : index.categories.get(row.categoryId)?.name) ?? "";
  const multiplier = direction === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    let comparison: number;
    if (column === "date") {
      comparison = new Date(a.date).getTime() - new Date(b.date).getTime();
    } else if (column === "category") {
      comparison = labelOf(a).localeCompare(labelOf(b));
    } else {
      comparison = a.amountCents - b.amountCents;
    }

    if (comparison !== 0) return comparison * multiplier;
    return ((a.id ?? 0) - (b.id ?? 0)) * multiplier;
  });
}

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
