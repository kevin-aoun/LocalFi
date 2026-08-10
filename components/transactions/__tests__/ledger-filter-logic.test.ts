/**
 * The ledger's search / date-range / month / type / category / account predicate.
 *
 * Before this module the transactions page had month, type and category
 * dropdowns and NOTHING else: no free-text search and no date range, so finding
 * "that coffee thing in March" meant paging through the whole ledger by hand.
 * The filtering also lived inline in the page component, where none of it could
 * be tested.
 *
 * These tests must pass under `bun run test:tz` (UTC+14 and UTC-11): a filter
 * that drops the 1st of the month east of UTC is the same class of bug as the
 * one transaction-form-logic.ts exists to prevent.
 */
import { describe, expect, it } from "vitest";
import {
  buildLedgerIndex,
  filterLedger,
  ledgerRowDateKey,
  ledgerSearchText,
  matchesLedgerFilters,
  normalizeDateRange,
  normalizeQuery,
  sortLedger,
  type LedgerRow,
} from "../ledger-filter-logic";

const CATEGORIES = [
  { id: 1, name: "Groceries", type: "Expense", color: "#ef4444" },
  { id: 2, name: "Salary", type: "Income", color: "#22c55e" },
  { id: 3, name: "Brokerage", type: "Investment", color: "#3b82f6" },
];

const ACCOUNTS = [
  { id: 10, name: "Main Checking" },
  { id: 11, name: "Rainy Day Savings" },
];

const INDEX = buildLedgerIndex(CATEGORIES, ACCOUNTS);

/** A confirmed expense on Main Checking. */
function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: 1,
    date: new Date(2026, 6, 28),
    categoryId: 1,
    accountId: 10,
    transferAccountId: null,
    amountCents: 4500,
    comment: "Spinneys run",
    pending: false,
    ...over,
  };
}

describe("ledgerRowDateKey", () => {
  it("reads the LOCAL calendar day, whatever the stored representation", () => {
    expect(ledgerRowDateKey(row({ date: new Date(2026, 6, 28) }))).toBe("2026-07-28");
    // The same instant arriving as a number (post-serialization) must agree.
    expect(ledgerRowDateKey(row({ date: new Date(2026, 6, 28).getTime() }))).toBe("2026-07-28");
  });

  it("never shifts the 1st of a month into the previous one", () => {
    // toISOString() would report 2026-07-31 east of UTC.
    expect(ledgerRowDateKey(row({ date: new Date(2026, 7, 1) }))).toBe("2026-08-01");
  });
});

describe("normalizeQuery", () => {
  it("treats an absent, empty or whitespace-only query as no query at all", () => {
    expect(normalizeQuery(undefined)).toBe("");
    expect(normalizeQuery(null)).toBe("");
    expect(normalizeQuery("")).toBe("");
    expect(normalizeQuery("   \t ")).toBe("");
  });

  it("lowercases and collapses whitespace", () => {
    expect(normalizeQuery("  Coffee   SHOP ")).toBe("coffee shop");
  });
});

describe("sortLedger", () => {
  it("shows the most recent transaction first by default without mutating input", () => {
    const rows = [
      row({ id: 1, date: new Date(2026, 5, 1) }),
      row({ id: 2, date: new Date(2026, 7, 1) }),
      row({ id: 3, date: new Date(2026, 6, 1) }),
    ];

    expect(sortLedger(rows, INDEX).map((item) => item.id)).toEqual([2, 3, 1]);
    expect(rows.map((item) => item.id)).toEqual([1, 2, 3]);
  });

  it("uses newest id first for transactions on the same date", () => {
    const rows = [row({ id: 4 }), row({ id: 9 }), row({ id: 5 })];
    expect(sortLedger(rows, INDEX).map((item) => item.id)).toEqual([9, 5, 4]);
  });
});

describe("free-text search", () => {
  it("matches on the comment", () => {
    expect(matchesLedgerFilters(row({ comment: "Spinneys run" }), INDEX, { query: "spinneys" })).toBe(
      true,
    );
    expect(matchesLedgerFilters(row({ comment: "Spinneys run" }), INDEX, { query: "zara" })).toBe(
      false,
    );
  });

  it("matches on the CATEGORY NAME even when the comment does not contain it", () => {
    const tx = row({ comment: "Spinneys run", categoryId: 1 });
    expect(tx.comment).not.toContain("rocer");
    expect(matchesLedgerFilters(tx, INDEX, { query: "groceries" })).toBe(true);
    expect(matchesLedgerFilters(tx, INDEX, { query: "salary" })).toBe(false);
  });

  it("matches on the account name, including a transfer's destination", () => {
    const transfer = row({
      categoryId: null,
      accountId: 10,
      transferAccountId: 11,
      comment: null,
    });
    expect(matchesLedgerFilters(transfer, INDEX, { query: "rainy" })).toBe(true);
    expect(matchesLedgerFilters(transfer, INDEX, { query: "main" })).toBe(true);
    expect(matchesLedgerFilters(transfer, INDEX, { query: "brokerage" })).toBe(false);
  });

  it("keeps every row when the query is empty", () => {
    const rows = [row({ id: 1 }), row({ id: 2, comment: null, categoryId: null })];
    expect(filterLedger(rows, INDEX, { query: "" })).toHaveLength(2);
    expect(filterLedger(rows, INDEX, { query: "    " })).toHaveLength(2);
    expect(filterLedger(rows, INDEX, {})).toHaveLength(2);
  });

  it("is case- and whitespace-insensitive on both sides", () => {
    const tx = row({ comment: "Coffee   Shop" });
    expect(matchesLedgerFilters(tx, INDEX, { query: "coffee shop" })).toBe(true);
    expect(matchesLedgerFilters(tx, INDEX, { query: "  COFFEE  SHOP  " })).toBe(true);
  });

  it("requires ALL terms, so a second word narrows instead of widening", () => {
    const groceries = row({ comment: "Coffee beans", categoryId: 1 });
    // "coffee" is in the comment, "groceries" is the category: both must match.
    expect(matchesLedgerFilters(groceries, INDEX, { query: "coffee groceries" })).toBe(true);
    expect(matchesLedgerFilters(groceries, INDEX, { query: "coffee salary" })).toBe(false);
  });

  it("survives a row with no comment, no category and no account", () => {
    const orphan = row({ comment: null, categoryId: null, accountId: null });
    expect(() => matchesLedgerFilters(orphan, INDEX, { query: "anything" })).not.toThrow();
    expect(matchesLedgerFilters(orphan, INDEX, { query: "anything" })).toBe(false);
    expect(matchesLedgerFilters(orphan, INDEX, { query: "" })).toBe(true);
  });

  it("exposes the searchable text it built, for debugging", () => {
    const text = ledgerSearchText(row(), INDEX);
    expect(text).toContain("spinneys run");
    expect(text).toContain("groceries");
    expect(text).toContain("main checking");
  });
});

describe("date-range filter", () => {
  const jan = row({ id: 1, date: new Date(2026, 0, 15) });
  const feb1 = row({ id: 2, date: new Date(2026, 1, 1) });
  const feb28 = row({ id: 3, date: new Date(2026, 1, 28) });
  const mar = row({ id: 4, date: new Date(2026, 2, 3) });
  const rows = [jan, feb1, feb28, mar];

  it("is INCLUSIVE at both ends", () => {
    const kept = filterLedger(rows, INDEX, { fromKey: "2026-02-01", toKey: "2026-02-28" });
    expect(kept.map((r) => r.id)).toEqual([2, 3]);
  });

  it("accepts an open lower or upper bound", () => {
    expect(filterLedger(rows, INDEX, { fromKey: "2026-02-01" }).map((r) => r.id)).toEqual([2, 3, 4]);
    expect(filterLedger(rows, INDEX, { toKey: "2026-02-01" }).map((r) => r.id)).toEqual([1, 2]);
  });

  it("swaps a backwards range instead of returning nothing", () => {
    expect(normalizeDateRange("2026-02-28", "2026-02-01")).toEqual({
      fromKey: "2026-02-01",
      toKey: "2026-02-28",
    });
    const kept = filterLedger(rows, INDEX, { fromKey: "2026-02-28", toKey: "2026-02-01" });
    expect(kept.map((r) => r.id)).toEqual([2, 3]);
  });

  it("keeps the 1st of the month in range in every timezone", () => {
    // The old inline filter compared instants; east of UTC the 1st could be
    // dropped from a range that starts on the 1st.
    const kept = filterLedger([feb1], INDEX, { fromKey: "2026-02-01", toKey: "2026-02-01" });
    expect(kept).toHaveLength(1);
  });
});

describe("month filter", () => {
  const rows = [
    row({ id: 1, date: new Date(2026, 6, 1) }),
    row({ id: 2, date: new Date(2026, 6, 31) }),
    row({ id: 3, date: new Date(2026, 7, 1) }),
  ];

  it("keeps exactly the rows in that local month, boundaries included", () => {
    expect(filterLedger(rows, INDEX, { month: "2026-07" }).map((r) => r.id)).toEqual([1, 2]);
    expect(filterLedger(rows, INDEX, { month: "2026-08" }).map((r) => r.id)).toEqual([3]);
  });

  it("ignores a null month", () => {
    expect(filterLedger(rows, INDEX, { month: null })).toHaveLength(3);
  });
});

describe("type filter", () => {
  const expense = row({ id: 1, categoryId: 1 });
  const income = row({ id: 2, categoryId: 2 });
  const investment = row({ id: 3, categoryId: 3 });
  const transfer = row({ id: 4, categoryId: null, transferAccountId: 11 });
  const rows = [expense, income, investment, transfer];

  it("filters by the category's type", () => {
    expect(filterLedger(rows, INDEX, { type: "expense" }).map((r) => r.id)).toEqual([1]);
    expect(filterLedger(rows, INDEX, { type: "income" }).map((r) => r.id)).toEqual([2]);
    expect(filterLedger(rows, INDEX, { type: "investment" }).map((r) => r.id)).toEqual([3]);
  });

  it("has a TRANSFER type of its own — a transfer is neither income nor expense", () => {
    expect(filterLedger(rows, INDEX, { type: "transfer" }).map((r) => r.id)).toEqual([4]);
    // and it is never swept up by the income/expense/investment buckets
    for (const type of ["income", "expense", "investment"]) {
      expect(filterLedger(rows, INDEX, { type }).map((r) => r.id)).not.toContain(4);
    }
  });

  it("keeps a transfer out of the expense bucket even if it carries a category", () => {
    // The schema allows it; lib/cash-balance ignores the category outright.
    const mislabelled = row({ id: 5, categoryId: 1, transferAccountId: 11 });
    expect(filterLedger([mislabelled], INDEX, { type: "expense" })).toHaveLength(0);
    expect(filterLedger([mislabelled], INDEX, { type: "transfer" })).toHaveLength(1);
  });

  it("passes everything through for 'all'", () => {
    expect(filterLedger(rows, INDEX, { type: "all" })).toHaveLength(4);
  });
});

describe("category filter", () => {
  it("matches on the exact category id", () => {
    const rows = [row({ id: 1, categoryId: 1 }), row({ id: 2, categoryId: 2 })];
    expect(filterLedger(rows, INDEX, { categoryId: 2 }).map((r) => r.id)).toEqual([2]);
  });

  it("never matches a transfer, which has no category", () => {
    const transfer = row({ id: 3, categoryId: null, transferAccountId: 11 });
    expect(filterLedger([transfer], INDEX, { categoryId: 1 })).toHaveLength(0);
  });
});

describe("account filter", () => {
  const onMain = row({ id: 1, accountId: 10 });
  const onSavings = row({ id: 2, accountId: 11 });
  const transfer = row({ id: 3, categoryId: null, accountId: 10, transferAccountId: 11 });
  const orphan = row({ id: 4, accountId: null });
  const rows = [onMain, onSavings, transfer, orphan];

  it("matches the account the row sits on", () => {
    expect(filterLedger(rows, INDEX, { accountId: 11 }).map((r) => r.id)).toEqual([2, 3]);
  });

  it("shows a transfer under BOTH of its accounts", () => {
    expect(filterLedger(rows, INDEX, { accountId: 10 }).map((r) => r.id)).toContain(3);
    expect(filterLedger(rows, INDEX, { accountId: 11 }).map((r) => r.id)).toContain(3);
  });

  it("can isolate rows that belong to no account", () => {
    expect(filterLedger(rows, INDEX, { accountId: "unassigned" }).map((r) => r.id)).toEqual([4]);
  });
});

describe("filters compose", () => {
  it("applies search, range, type and account together", () => {
    const rows = [
      row({ id: 1, date: new Date(2026, 1, 10), comment: "Coffee", categoryId: 1, accountId: 10 }),
      row({ id: 2, date: new Date(2026, 1, 10), comment: "Coffee", categoryId: 2, accountId: 10 }),
      row({ id: 3, date: new Date(2026, 5, 10), comment: "Coffee", categoryId: 1, accountId: 10 }),
      row({ id: 4, date: new Date(2026, 1, 10), comment: "Coffee", categoryId: 1, accountId: 11 }),
    ];
    const kept = filterLedger(rows, INDEX, {
      query: "coffee",
      fromKey: "2026-02-01",
      toKey: "2026-02-28",
      type: "expense",
      accountId: 10,
    });
    expect(kept.map((r) => r.id)).toEqual([1]);
  });

  it("returns the rows unchanged (same objects) so the caller can keep its own type", () => {
    const rows = [row({ id: 1 })];
    expect(filterLedger(rows, INDEX, {})[0]).toBe(rows[0]);
  });

  it("stays linear on a few thousand rows", () => {
    const many: LedgerRow[] = Array.from({ length: 5000 }, (_, i) =>
      row({ id: i, comment: `Row ${i}`, date: new Date(2026, i % 12, (i % 28) + 1) }),
    );
    const started = Date.now();
    const kept = filterLedger(many, INDEX, { query: "row 4321", fromKey: "2026-01-01" });
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
