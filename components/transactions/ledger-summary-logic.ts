/**
 * The ledger's income / expense / breakdown totals, in exact integer cents.
 *
 * WHY THIS FILE EXISTS
 *
 * Two reasons, and the first is the important one.
 *
 * 1. **A transfer is neither income nor expense.** Before transfers were a row
 *    type, moving $1,000 from checking to savings had to be entered as an
 *    "Investment" expense — so the app booked it as a net-worth LOSS and counted
 *    it as spend. The authority on what counts is `isTransfer` / `isSpendable` in
 *    lib/cash-balance.ts, the SAME rule the budgets page and the cash balance
 *    use. Re-deriving "is this spend?" locally is how the ledger and the budgets
 *    page start disagreeing, so this module never does: it asks.
 *
 * 2. The totals used to be computed inline in the page component, where they
 *    could not be tested.
 *
 * Money is summed with `sumCents`, which throws on a non-integer, so a leaked
 * float fails loudly instead of quietly shifting a total.
 */
import { isSpendable, isTransfer } from "@/lib/cash-balance";
import { negateCents, sumCents, type Cents } from "@/lib/money";
import type { LedgerCategory, LedgerRow } from "./ledger-filter-logic";

export type LedgerSummary = {
  /** Confirmed, non-transfer rows on Income categories. */
  incomeCents: Cents;
  /** Confirmed, non-transfer rows on Expense categories. */
  expenseCents: Cents;
  /** Confirmed, non-transfer rows on Investment categories. */
  investmentCents: Cents;
  /**
   * Money moved between the user's own accounts. Reported so the figure is
   * visible, and counted in NOTHING else: a transfer is net-neutral.
   */
  transferCents: Cents;
  transferCount: number;
  /** income − expense − investment. Transfers contribute exactly 0. */
  netCents: Cents;
  /** Rows counted into one of the three buckets above. */
  countedCount: number;
  /** Confirmed non-transfer rows whose category is missing or unknown. */
  uncategorizedCount: number;
  /** Rows excluded from every total because they have not been confirmed yet. */
  pendingCount: number;
};

type Buckets = { income: Cents[]; expense: Cents[]; investment: Cents[]; transfer: Cents[] };

/**
 * Totals for a set of ledger rows.
 *
 * Excluded from income/expense/investment, via the shared rule:
 *   - transfers (`isTransfer`) — they are movements, not spend;
 *   - pending rows (`isSpendable`) — same rule that keeps them out of the cash
 *     balance, so the headline figures agree;
 *   - rows whose category is missing or was deleted — counted nowhere and
 *     reported as `uncategorizedCount`, rather than silently treated as spend.
 */
export function summarizeLedger(
  rows: readonly LedgerRow[],
  categories: readonly LedgerCategory[],
): LedgerSummary {
  const typeOf = new Map(categories.map((c) => [c.id, c.type]));
  const buckets: Buckets = { income: [], expense: [], investment: [], transfer: [] };
  let countedCount = 0;
  let uncategorizedCount = 0;
  let pendingCount = 0;

  for (const row of rows) {
    if (row.pending) {
      pendingCount += 1;
      continue;
    }

    // Asked, never re-derived. A transfer that wrongly carries a category is
    // still a transfer — lib/cash-balance ignores the category outright.
    if (isTransfer(row)) {
      buckets.transfer.push(row.amountCents);
      continue;
    }
    if (!isSpendable(row)) continue;

    const type = row.categoryId == null ? undefined : typeOf.get(row.categoryId);
    switch (type) {
      case "Income":
        buckets.income.push(row.amountCents);
        countedCount += 1;
        break;
      case "Expense":
        buckets.expense.push(row.amountCents);
        countedCount += 1;
        break;
      case "Investment":
        buckets.investment.push(row.amountCents);
        countedCount += 1;
        break;
      default:
        uncategorizedCount += 1;
    }
  }

  const incomeCents = sumCents(buckets.income);
  const expenseCents = sumCents(buckets.expense);
  const investmentCents = sumCents(buckets.investment);

  return {
    incomeCents,
    expenseCents,
    investmentCents,
    transferCents: sumCents(buckets.transfer),
    transferCount: buckets.transfer.length,
    netCents: sumCents([incomeCents, negateCents(expenseCents), negateCents(investmentCents)]),
    countedCount,
    uncategorizedCount,
    pendingCount,
  };
}

export type BreakdownSlice = {
  name: string;
  valueCents: Cents;
  /** Share of the bucket total, 0..100. A share is not money: a float is right. */
  percentage: number;
  color: string;
  count: number;
};

export type LedgerBreakdown = {
  /** 'Income' | 'Expense' | 'Investment' — the bucket that was broken down. */
  type: string;
  totalCents: Cents;
  /** Largest slice first. */
  data: BreakdownSlice[];
};

const DEFAULT_SLICE_COLOR = "#64748b";

/**
 * Per-category totals within one type.
 *
 * Transfers are excluded here too, and by the same rule — otherwise the old
 * "fake it as an Investment" rows would reappear as the largest slice of the
 * Investment breakdown.
 */
export function categoryBreakdown(
  rows: readonly LedgerRow[],
  categories: readonly LedgerCategory[],
  type: string,
): LedgerBreakdown {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const groups = new Map<string, { amounts: Cents[]; color: string; count: number }>();

  for (const row of rows) {
    if (isTransfer(row) || !isSpendable(row)) continue;
    const category = row.categoryId == null ? undefined : byId.get(row.categoryId);
    if (!category || category.type !== type) continue;

    const group = groups.get(category.name) ?? {
      amounts: [],
      color: category.color ?? DEFAULT_SLICE_COLOR,
      count: 0,
    };
    // A 0-cent row is a real row: it must still create/keep its slice.
    group.amounts.push(row.amountCents);
    group.count += 1;
    groups.set(category.name, group);
  }

  const totals = [...groups.entries()].map(([name, group]) => ({
    name,
    valueCents: sumCents(group.amounts),
    color: group.color,
    count: group.count,
  }));
  const totalCents = sumCents(totals.map((t) => t.valueCents));

  const data: BreakdownSlice[] = totals
    .map((t) => ({
      ...t,
      percentage: totalCents > 0 ? (t.valueCents / totalCents) * 100 : 0,
    }))
    .sort((a, b) => b.valueCents - a.valueCents);

  return { type, totalCents, data };
}

/**
 * Which bucket the breakdown card should show for the current type filter.
 * "all" and "transfer" fall back to Expense, which is what the user almost
 * always wants to see broken down.
 */
export function breakdownTypeFor(typeFilter: string | null | undefined): string {
  switch ((typeFilter ?? "").trim().toLowerCase()) {
    case "income":
      return "Income";
    case "investment":
      return "Investment";
    default:
      return "Expense";
  }
}
