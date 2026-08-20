
import { isSpendable, isTransfer } from "@/lib/cash-balance";
import { negateCents, sumCents, type Cents } from "@/lib/money";
import type { LedgerCategory, LedgerRow } from "./ledger-filter-logic";

export type LedgerSummary = {

  incomeCents: Cents;

  expenseCents: Cents;

  investmentCents: Cents;

  transferCents: Cents;
  transferCount: number;

  netCents: Cents;

  countedCount: number;

  uncategorizedCount: number;

  pendingCount: number;
};

type Buckets = { income: Cents[]; expense: Cents[]; investment: Cents[]; transfer: Cents[] };

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

  percentage: number;
  color: string;
  count: number;
};

export type LedgerBreakdown = {

  type: string;
  totalCents: Cents;

  data: BreakdownSlice[];
};

const DEFAULT_SLICE_COLOR = "#64748b";

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
