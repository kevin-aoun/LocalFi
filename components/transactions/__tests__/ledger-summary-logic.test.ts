/**
 * The ledger's income / expense / breakdown totals.
 *
 * WHY THESE TESTS EXIST: before transfers were a first-class row type, moving
 * $1,000 from checking to savings had to be entered as an "Investment" expense.
 * The app then booked it as a net-worth LOSS and counted it as spend. A transfer
 * is neither income nor expense, and the ONLY authority on that is
 * `isTransfer` / `isSpendable` in lib/cash-balance.ts — the same rule the budgets
 * page uses, so the ledger and the budgets page cannot disagree.
 *
 * Every assertion below is about that exclusion or about integer-cent exactness.
 */
import { describe, expect, it } from "vitest";
import { isSpendable, isTransfer } from "@/lib/cash-balance";
import { categoryBreakdown, summarizeLedger } from "../ledger-summary-logic";
import type { LedgerRow } from "../ledger-filter-logic";

const CATEGORIES = [
  { id: 1, name: "Groceries", type: "Expense", color: "#ef4444" },
  { id: 2, name: "Salary", type: "Income", color: "#22c55e" },
  { id: 3, name: "Brokerage", type: "Investment", color: "#3b82f6" },
  { id: 4, name: "Rent", type: "Expense", color: "#f97316" },
];

function tx(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: 1,
    date: new Date(2026, 6, 28),
    categoryId: 1,
    accountId: 10,
    transferAccountId: null,
    amountCents: 4500,
    comment: "Spinneys",
    pending: false,
    ...over,
  };
}

/** A transfer: no category, both accounts set. */
function transfer(over: Partial<LedgerRow> = {}): LedgerRow {
  return tx({ categoryId: null, accountId: 10, transferAccountId: 11, amountCents: 100_000, ...over });
}

describe("summarizeLedger", () => {
  it("adds income and subtracts expense and investment, in exact cents", () => {
    const summary = summarizeLedger(
      [
        tx({ id: 1, categoryId: 2, amountCents: 500_000 }), // income
        tx({ id: 2, categoryId: 1, amountCents: 4_599 }), // expense
        tx({ id: 3, categoryId: 4, amountCents: 120_000 }), // expense
        tx({ id: 4, categoryId: 3, amountCents: 50_000 }), // investment
      ],
      CATEGORIES,
    );
    expect(summary.incomeCents).toBe(500_000);
    expect(summary.expenseCents).toBe(124_599);
    expect(summary.investmentCents).toBe(50_000);
    expect(summary.netCents).toBe(500_000 - 124_599 - 50_000);
  });

  it("EXCLUDES a transfer from income, expense, investment and net", () => {
    const withoutTransfer = summarizeLedger([tx({ categoryId: 2, amountCents: 300_000 })], CATEGORIES);
    const withTransfer = summarizeLedger(
      [tx({ categoryId: 2, amountCents: 300_000 }), transfer({ id: 9 })],
      CATEGORIES,
    );

    expect(withTransfer.incomeCents).toBe(withoutTransfer.incomeCents);
    expect(withTransfer.expenseCents).toBe(withoutTransfer.expenseCents);
    expect(withTransfer.investmentCents).toBe(withoutTransfer.investmentCents);
    // The one figure that must be identical: a transfer is net-neutral.
    expect(withTransfer.netCents).toBe(withoutTransfer.netCents);
  });

  it("reports transfers separately rather than hiding them", () => {
    const summary = summarizeLedger(
      [transfer({ id: 1, amountCents: 100_000 }), transfer({ id: 2, amountCents: 25_000 })],
      CATEGORIES,
    );
    expect(summary.transferCount).toBe(2);
    expect(summary.transferCents).toBe(125_000);
    expect(summary.incomeCents).toBe(0);
    expect(summary.expenseCents).toBe(0);
  });

  it("ignores the category on a transfer row instead of trusting it", () => {
    // This is the exact shape the old "fake it as an Investment" workaround
    // produced. It must NOT count as investment spend.
    const mislabelled = transfer({ categoryId: 3, amountCents: 100_000 });
    const summary = summarizeLedger([mislabelled], CATEGORIES);
    expect(summary.investmentCents).toBe(0);
    expect(summary.transferCents).toBe(100_000);
  });

  it("defers to the shared rule, so the ledger cannot disagree with budgets", () => {
    const t = transfer();
    expect(isTransfer(t)).toBe(true);
    expect(isSpendable(t)).toBe(false);
    expect(isSpendable(tx())).toBe(true);
  });

  it("excludes pending rows from the totals but counts them", () => {
    const summary = summarizeLedger(
      [tx({ id: 1, categoryId: 1, amountCents: 1_000 }), tx({ id: 2, categoryId: 1, amountCents: 9_999, pending: true })],
      CATEGORIES,
    );
    expect(summary.expenseCents).toBe(1_000);
    expect(summary.pendingCount).toBe(1);
  });

  it("counts a row whose category was deleted nowhere, and says so", () => {
    const summary = summarizeLedger([tx({ categoryId: 999, amountCents: 7_777 })], CATEGORIES);
    expect(summary.incomeCents).toBe(0);
    expect(summary.expenseCents).toBe(0);
    expect(summary.investmentCents).toBe(0);
    expect(summary.uncategorizedCount).toBe(1);
  });

  it("treats a 0-cent transaction as a real row, not an absent one", () => {
    const summary = summarizeLedger([tx({ categoryId: 1, amountCents: 0 })], CATEGORIES);
    expect(summary.expenseCents).toBe(0);
    expect(summary.uncategorizedCount).toBe(0);
    expect(summary.countedCount).toBe(1);
  });

  it("is empty, not NaN, for an empty ledger", () => {
    const summary = summarizeLedger([], CATEGORIES);
    expect(summary).toMatchObject({
      incomeCents: 0,
      expenseCents: 0,
      investmentCents: 0,
      transferCents: 0,
      netCents: 0,
      transferCount: 0,
    });
  });
});

describe("categoryBreakdown", () => {
  it("groups by category name and totals exactly", () => {
    const breakdown = categoryBreakdown(
      [
        tx({ id: 1, categoryId: 1, amountCents: 3_000 }),
        tx({ id: 2, categoryId: 1, amountCents: 1_500 }),
        tx({ id: 3, categoryId: 4, amountCents: 90_000 }),
      ],
      CATEGORIES,
      "Expense",
    );
    expect(breakdown.totalCents).toBe(94_500);
    expect(breakdown.data.map((d) => [d.name, d.valueCents, d.count])).toEqual([
      ["Rent", 90_000, 1],
      ["Groceries", 4_500, 2],
    ]);
  });

  it("EXCLUDES transfers from the breakdown, whatever category they carry", () => {
    const breakdown = categoryBreakdown(
      [tx({ id: 1, categoryId: 1, amountCents: 4_500 }), transfer({ id: 2, categoryId: 1 })],
      CATEGORIES,
      "Expense",
    );
    expect(breakdown.totalCents).toBe(4_500);
    expect(breakdown.data).toHaveLength(1);
    expect(breakdown.data[0].count).toBe(1);
  });

  it("percentages are shares that sum to 100, and never divide by zero", () => {
    const breakdown = categoryBreakdown(
      [tx({ id: 1, categoryId: 1, amountCents: 2_500 }), tx({ id: 2, categoryId: 4, amountCents: 7_500 })],
      CATEGORIES,
      "Expense",
    );
    expect(breakdown.data.map((d) => d.percentage)).toEqual([75, 25]);

    const empty = categoryBreakdown([], CATEGORIES, "Expense");
    expect(empty.totalCents).toBe(0);
    expect(empty.data).toEqual([]);
  });

  it("keeps a zero-amount category visible instead of dropping it", () => {
    const breakdown = categoryBreakdown([tx({ categoryId: 1, amountCents: 0 })], CATEGORIES, "Expense");
    expect(breakdown.data).toHaveLength(1);
    expect(breakdown.data[0]).toMatchObject({ name: "Groceries", valueCents: 0, percentage: 0 });
  });

  it("carries the category colour through for the bars", () => {
    const breakdown = categoryBreakdown([tx({ categoryId: 1 })], CATEGORIES, "Expense");
    expect(breakdown.data[0].color).toBe("#ef4444");
  });
});
