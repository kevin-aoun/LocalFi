
import { describe, expect, it } from "vitest";

import { deriveCashBalanceCents } from "@/lib/cash-balance";
import {
  CSV_HEADERS,
  buildTransactionsCsv,
  cashFlowByPeriod,
  categoryBreakdown,
  centsToDecimalString,
  compareFlows,
  currencyScope,
  filterByCurrency,
  flowInRange,
  formatPercent,
  formatSavingsRate,
  previousPeriodRange,
  sameRangeLastYear,
  savingsRate,
  savingsRateExcludingInvestments,
  shiftYears,
  toReportTransactions,
  type ReportCategory,
  type ReportTransaction,
} from "@/lib/reports";

const CATEGORIES: ReportCategory[] = [
  { id: 1, name: "Salary", type: "Income" },
  { id: 2, name: "Groceries", type: "Expense" },
  { id: 3, name: "Rent", type: "Expense" },
  { id: 4, name: "Brokerage", type: "Investment" },
];

function tx(values: {
  dateKey: string;
  amountCents: number;
  categoryId?: number | null;
  pending?: boolean;
  accountId?: number | null;
  transferAccountId?: number | null;
  direction?: "inflow" | "outflow" | "transfer";
  currency?: string;
}): ReportTransaction {
  return {
    dateKey: values.dateKey,
    amountCents: values.amountCents,
    categoryId: values.categoryId ?? null,
    pending: values.pending ?? false,

    accountId: "accountId" in values ? values.accountId ?? null : 1,
    transferAccountId: values.transferAccountId ?? null,
    direction: values.direction,
    currency: values.currency,
  };
}

describe("flowInRange", () => {
  it("derives income and consumption directly from signed category movements", () => {
    const rows = [
      { ...tx({ dateKey: "2026-03-01", amountCents: 100_000, categoryId: 1 }), categoryMovementCents: -100_000 },
      { ...tx({ dateKey: "2026-03-02", amountCents: 20_000, categoryId: 2 }), categoryMovementCents: 20_000 },
      { ...tx({ dateKey: "2026-03-03", amountCents: 5_000, categoryId: 2 }), categoryMovementCents: -5_000 },
    ];
    expect(flowInRange(rows, CATEGORIES, "2026-03-01", "2026-03-31")).toMatchObject({
      incomeCents: 100_000,
      expenseCents: 15_000,
      netCents: 85_000,
      countedCount: 3,
    });
  });
  it("splits income and expenses, both as positive magnitudes, and nets them", () => {
    const rows = [
      tx({ dateKey: "2026-03-01", amountCents: 500_000, categoryId: 1 }),
      tx({ dateKey: "2026-03-05", amountCents: 12_345, categoryId: 2 }),
      tx({ dateKey: "2026-03-10", amountCents: 150_000, categoryId: 3 }),
    ];
    const totals = flowInRange(rows, CATEGORIES, "2026-03-01", "2026-03-31");

    expect(totals.incomeCents).toBe(500_000);
    expect(totals.expenseCents).toBe(162_345);
    expect(totals.netCents).toBe(337_655);
    expect(totals.countedCount).toBe(3);
  });

  it("counts an Investment category as money out, and reports it separately", () => {
    const rows = [
      tx({ dateKey: "2026-03-01", amountCents: 500_000, categoryId: 1 }),
      tx({ dateKey: "2026-03-02", amountCents: 100_000, categoryId: 2 }),
      tx({ dateKey: "2026-03-03", amountCents: 200_000, categoryId: 4 }),
    ];
    const totals = flowInRange(rows, CATEGORIES, "2026-03-01", "2026-03-31");

    expect(totals.expenseCents).toBe(300_000);
    expect(totals.investmentCents).toBe(200_000);
    expect(totals.consumptionCents).toBe(100_000);
    expect(totals.netCents).toBe(200_000);
  });

  it("EXCLUDES transfers from both income and expense", () => {
    const rows = [
      tx({ dateKey: "2026-03-01", amountCents: 500_000, categoryId: 1 }),

      tx({
        dateKey: "2026-03-02",
        amountCents: 250_000,
        categoryId: 2,
        accountId: 1,
        transferAccountId: 2,
      }),
    ];
    const totals = flowInRange(rows, CATEGORIES, "2026-03-01", "2026-03-31");

    expect(totals.incomeCents).toBe(500_000);
    expect(totals.expenseCents).toBe(0);
    expect(totals.netCents).toBe(500_000);
    expect(totals.transferCount).toBe(1);
    expect(totals.countedCount).toBe(1);
  });

  it("EXCLUDES pending rows, but reports what they would have added", () => {
    const rows = [
      tx({ dateKey: "2026-03-01", amountCents: 500_000, categoryId: 1 }),
      tx({ dateKey: "2026-03-04", amountCents: 90_000, categoryId: 2, pending: true }),
      tx({ dateKey: "2026-03-05", amountCents: 30_000, categoryId: 1, pending: true }),
    ];
    const totals = flowInRange(rows, CATEGORIES, "2026-03-01", "2026-03-31");

    expect(totals.incomeCents).toBe(500_000);
    expect(totals.expenseCents).toBe(0);
    expect(totals.pendingCount).toBe(2);
    expect(totals.pendingIncomeCents).toBe(30_000);
    expect(totals.pendingExpenseCents).toBe(90_000);
  });

  it("a pending transfer is a transfer, not pending income or expense", () => {
    const rows = [
      tx({
        dateKey: "2026-03-02",
        amountCents: 250_000,
        categoryId: null,
        accountId: 1,
        transferAccountId: 2,
        pending: true,
      }),
    ];
    const totals = flowInRange(rows, CATEGORIES, "2026-03-01", "2026-03-31");

    expect(totals.pendingIncomeCents).toBe(0);
    expect(totals.pendingExpenseCents).toBe(0);
    expect(totals.transferCount).toBe(1);
  });

  it("a row whose category is missing or unknown contributes nothing but is counted", () => {
    const rows = [
      tx({ dateKey: "2026-03-01", amountCents: 500_000, categoryId: 1 }),
      tx({ dateKey: "2026-03-02", amountCents: 4_242, categoryId: 99 }),
      tx({ dateKey: "2026-03-03", amountCents: 1_111, categoryId: null }),
    ];
    const totals = flowInRange(rows, CATEGORIES, "2026-03-01", "2026-03-31");

    expect(totals.incomeCents).toBe(500_000);
    expect(totals.expenseCents).toBe(0);
    expect(totals.uncategorizedCount).toBe(2);
  });

  it("honours BOTH ends of the range inclusively", () => {
    const rows = [
      tx({ dateKey: "2026-02-28", amountCents: 100, categoryId: 2 }),
      tx({ dateKey: "2026-03-01", amountCents: 200, categoryId: 2 }),
      tx({ dateKey: "2026-03-31", amountCents: 400, categoryId: 2 }),
      tx({ dateKey: "2026-04-01", amountCents: 800, categoryId: 2 }),
    ];
    const totals = flowInRange(rows, CATEGORIES, "2026-03-01", "2026-03-31");
    expect(totals.expenseCents).toBe(600);
  });

  it("agrees with deriveCashBalanceCents: net === the cash rule over the same rows", () => {
    const rows = [
      tx({ dateKey: "2026-03-01", amountCents: 500_000, categoryId: 1 }),
      tx({ dateKey: "2026-03-02", amountCents: 100_000, categoryId: 2 }),
      tx({ dateKey: "2026-03-03", amountCents: 200_000, categoryId: 4 }),
      tx({ dateKey: "2026-03-04", amountCents: 90_000, categoryId: 2, pending: true }),
      tx({ dateKey: "2026-03-05", amountCents: 7_777, categoryId: 99 }),
      tx({ dateKey: "2026-03-06", amountCents: 250_000, accountId: 1, transferAccountId: 2 }),
    ];
    const totals = flowInRange(rows, CATEGORIES, "2026-03-01", "2026-03-31");

    expect(totals.netCents).toBe(deriveCashBalanceCents(rows, CATEGORIES));
  });

  it("keeps the stored direction when category metadata changes later", () => {
    const rows = [
      tx({
        dateKey: "2026-03-01",
        amountCents: 50_000,
        categoryId: 1,
        direction: "inflow",
      }),
    ];
    const renamedAsExpense = [{ id: 1, name: "Salary", type: "Expense" }];
    const totals = flowInRange(rows, renamedAsExpense, "2026-03-01", "2026-03-31");
    expect(totals.incomeCents).toBe(50_000);
    expect(totals.expenseCents).toBe(0);
  });

  it("throws on a malformed range rather than silently reporting zero", () => {
    expect(() => flowInRange([], CATEGORIES, "2026-3-1", "2026-03-31")).toThrow(/date key/i);
    expect(() => flowInRange([], CATEGORIES, "2026-03-01", "not-a-day")).toThrow(/date key/i);
  });

  it("throws when an amount is not an integer number of cents", () => {
    const rows = [tx({ dateKey: "2026-03-01", amountCents: 45.5, categoryId: 2 })];
    expect(() => flowInRange(rows, CATEGORIES, "2026-03-01", "2026-03-31")).toThrow(/cents/i);
  });
});

describe("savingsRate", () => {
  it("is (income − expenses) / income as a fraction", () => {
    expect(savingsRate({ incomeCents: 500_000, expenseCents: 375_000 })).toBeCloseTo(0.25, 12);
  });

  it("is NULL when income is zero — never NaN, never Infinity", () => {
    expect(savingsRate({ incomeCents: 0, expenseCents: 0 })).toBeNull();
    expect(savingsRate({ incomeCents: 0, expenseCents: 120_000 })).toBeNull();
    expect(formatSavingsRate(savingsRate({ incomeCents: 0, expenseCents: 120_000 }))).toBe("—");
    expect(formatSavingsRate(null)).not.toMatch(/NaN|Infinity/);
  });

  it("is NEGATIVE when expenses exceed income", () => {
    const rate = savingsRate({ incomeCents: 100_000, expenseCents: 150_000 });
    expect(rate).toBeCloseTo(-0.5, 12);
    expect(formatSavingsRate(rate)).toBe("-50.0%");
  });

  it("is 100% when there are no expenses at all", () => {
    expect(savingsRate({ incomeCents: 100_000, expenseCents: 0 })).toBe(1);
    expect(formatSavingsRate(1)).toBe("100.0%");
  });

  it("treats money moved into investments as saved in the alternative measure", () => {
    const totals = {
      incomeCents: 500_000,
      expenseCents: 400_000,
      investmentCents: 300_000,
      consumptionCents: 100_000,
    };
    expect(savingsRate(totals)).toBeCloseTo(0.2, 12);
    expect(savingsRateExcludingInvestments(totals)).toBeCloseTo(0.8, 12);
  });

  it("never renders NaN or Infinity for a hostile rate", () => {
    expect(formatPercent(Number.NaN)).toBe("—");
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("cashFlowByPeriod", () => {
  const rows = [

    tx({ dateKey: "2026-01-15", amountCents: 400_000, categoryId: 1 }),
    tx({ dateKey: "2026-01-31", amountCents: 100_000, categoryId: 2 }),

    tx({ dateKey: "2026-02-01", amountCents: 50_000, categoryId: 2 }),
    tx({ dateKey: "2026-02-20", amountCents: 400_000, categoryId: 1 }),
  ];

  it("buckets a month boundary on the right side of midnight", () => {
    const flows = cashFlowByPeriod({
      transactions: rows,
      categories: CATEGORIES,
      period: "monthly",
      fromKey: "2026-01-01",
      toKey: "2026-02-28",
    });

    expect(flows.map((f) => f.key)).toEqual(["2026-01", "2026-02"]);
    expect(flows[0].startKey).toBe("2026-01-01");
    expect(flows[0].endKey).toBe("2026-01-31");
    expect(flows[0].expenseCents).toBe(100_000);
    expect(flows[1].startKey).toBe("2026-02-01");
    expect(flows[1].expenseCents).toBe(50_000);
  });

  it("emits a zero row for a period with no activity rather than skipping it", () => {
    const flows = cashFlowByPeriod({
      transactions: [tx({ dateKey: "2026-01-15", amountCents: 400_000, categoryId: 1 })],
      categories: CATEGORIES,
      period: "monthly",
      fromKey: "2026-01-01",
      toKey: "2026-03-31",
    });

    expect(flows).toHaveLength(3);
    expect(flows[1].incomeCents).toBe(0);
    expect(flows[1].expenseCents).toBe(0);
    expect(flows[1].netCents).toBe(0);
    expect(flows[1].savingsRate).toBeNull();
  });

  it("carries a per-period savings rate that is null when the period had no income", () => {
    const flows = cashFlowByPeriod({
      transactions: [tx({ dateKey: "2026-01-15", amountCents: 20_000, categoryId: 2 })],
      categories: CATEGORIES,
      period: "monthly",
      fromKey: "2026-01-01",
      toKey: "2026-01-31",
    });
    expect(flows[0].savingsRate).toBeNull();
  });

  it("supports weekly (Monday-anchored) and yearly periods", () => {
    const weekly = cashFlowByPeriod({
      transactions: rows,
      categories: CATEGORIES,
      period: "weekly",
      fromKey: "2026-01-15",
      toKey: "2026-01-15",
    });

    expect(weekly).toHaveLength(1);
    expect(weekly[0].startKey).toBe("2026-01-12");
    expect(weekly[0].endKey).toBe("2026-01-18");

    const yearly = cashFlowByPeriod({
      transactions: rows,
      categories: CATEGORIES,
      period: "yearly",
      fromKey: "2026-01-01",
      toKey: "2026-12-31",
    });
    expect(yearly).toHaveLength(1);
    expect(yearly[0].incomeCents).toBe(800_000);
  });

  it("returns [] for an inverted range", () => {
    expect(
      cashFlowByPeriod({
        transactions: rows,
        categories: CATEGORIES,
        period: "monthly",
        fromKey: "2026-03-01",
        toKey: "2026-01-01",
      }),
    ).toEqual([]);
  });
});

describe("shiftYears", () => {
  it("moves a calendar day back a year", () => {
    expect(shiftYears("2026-03-15", -1)).toBe("2025-03-15");
    expect(shiftYears("2026-03-15", 1)).toBe("2027-03-15");
  });

  it("clamps Feb 29 instead of rolling over into March", () => {

    expect(shiftYears("2024-02-29", -1)).toBe("2023-02-28");
    expect(shiftYears("2024-02-29", 4)).toBe("2028-02-29");
  });
});

describe("previousPeriodRange / sameRangeLastYear", () => {
  it("previous monthly period crosses a year boundary correctly", () => {
    const prev = previousPeriodRange("monthly", {
      key: "2026-01",
      startKey: "2026-01-01",
      endKey: "2026-01-31",
    });
    expect(prev).toEqual({ key: "2025-12", startKey: "2025-12-01", endKey: "2025-12-31" });
  });

  it("previous weekly period is the preceding Monday..Sunday", () => {
    const prev = previousPeriodRange("weekly", {
      key: "2026-01-12",
      startKey: "2026-01-12",
      endKey: "2026-01-18",
    });
    expect(prev.startKey).toBe("2026-01-05");
    expect(prev.endKey).toBe("2026-01-11");
  });

  it("same range last year shifts both ends", () => {
    expect(sameRangeLastYear({ startKey: "2026-03-01", endKey: "2026-03-31" })).toEqual({
      startKey: "2025-03-01",
      endKey: "2025-03-31",
    });
  });

  it("same range last year clamps a leap day", () => {
    expect(sameRangeLastYear({ startKey: "2024-02-01", endKey: "2024-02-29" })).toEqual({
      startKey: "2023-02-01",
      endKey: "2023-02-28",
    });
  });
});

describe("compareFlows", () => {
  const current = flowInRange(
    [
      tx({ dateKey: "2026-03-01", amountCents: 500_000, categoryId: 1 }),
      tx({ dateKey: "2026-03-02", amountCents: 300_000, categoryId: 2 }),
    ],
    CATEGORIES,
    "2026-03-01",
    "2026-03-31",
  );

  it("reports absolute and relative change against a prior period", () => {
    const previous = flowInRange(
      [
        tx({ dateKey: "2025-03-01", amountCents: 400_000, categoryId: 1 }),
        tx({ dateKey: "2025-03-02", amountCents: 300_000, categoryId: 2 }),
      ],
      CATEGORIES,
      "2025-03-01",
      "2025-03-31",
    );
    const cmp = compareFlows(current, previous);

    expect(cmp.previousHasData).toBe(true);
    expect(cmp.income.absoluteCents).toBe(100_000);
    expect(cmp.income.ratio).toBeCloseTo(0.25, 12);
    expect(cmp.expense.absoluteCents).toBe(0);
    expect(cmp.expense.ratio).toBe(0);
    expect(cmp.net.absoluteCents).toBe(100_000);
    expect(cmp.net.ratio).toBeCloseTo(1, 12);
  });

  it("says PLAINLY that the prior period has no data instead of showing +Infinity%", () => {
    const previous = flowInRange([], CATEGORIES, "2025-03-01", "2025-03-31");
    const cmp = compareFlows(current, previous);

    expect(cmp.previousHasData).toBe(false);
    expect(cmp.income.absoluteCents).toBe(500_000);
    expect(cmp.income.ratio).toBeNull();
    expect(cmp.expense.ratio).toBeNull();
    expect(cmp.net.ratio).toBeNull();
    expect(cmp.savingsRatePoints).toBeNull();
    expect(formatPercent(cmp.income.ratio)).toBe("—");
  });

  it("measures a relative change against the MAGNITUDE of a negative baseline", () => {
    const previous = flowInRange(
      [tx({ dateKey: "2025-03-02", amountCents: 100_000, categoryId: 2 })],
      CATEGORIES,
      "2025-03-01",
      "2025-03-31",
    );
    const cmp = compareFlows(current, previous);

    expect(cmp.net.absoluteCents).toBe(300_000);
    expect(cmp.net.ratio).toBeCloseTo(3, 12);
  });

  it("reports the savings-rate change in percentage POINTS", () => {
    const previous = flowInRange(
      [
        tx({ dateKey: "2025-03-01", amountCents: 500_000, categoryId: 1 }),
        tx({ dateKey: "2025-03-02", amountCents: 400_000, categoryId: 2 }),
      ],
      CATEGORIES,
      "2025-03-01",
      "2025-03-31",
    );
    const cmp = compareFlows(current, previous);

    expect(cmp.savingsRatePoints).toBeCloseTo(0.2, 12);
  });
});

describe("categoryBreakdown", () => {
  const rows = [
    tx({ dateKey: "2026-03-01", amountCents: 500_000, categoryId: 1 }),
    tx({ dateKey: "2026-03-02", amountCents: 300_000, categoryId: 3 }),
    tx({ dateKey: "2026-03-03", amountCents: 100_000, categoryId: 2 }),
    tx({ dateKey: "2026-03-04", amountCents: 50_000, categoryId: 2 }),
    tx({ dateKey: "2026-03-05", amountCents: 25_000, categoryId: 2, pending: true }),
    tx({ dateKey: "2026-03-06", amountCents: 999_999, accountId: 1, transferAccountId: 2 }),
    tx({ dateKey: "2026-04-01", amountCents: 111_111, categoryId: 2 }),
  ];

  it("totals money out per category, largest first, with shares of the total out", () => {
    const breakdown = categoryBreakdown({
      transactions: rows,
      categories: CATEGORIES,
      startKey: "2026-03-01",
      endKey: "2026-03-31",
      direction: "expense",
    });

    expect(breakdown.map((r) => r.name)).toEqual(["Rent", "Groceries"]);
    expect(breakdown[0].totalCents).toBe(300_000);
    expect(breakdown[1].totalCents).toBe(150_000);
    expect(breakdown[1].count).toBe(2);
    expect(breakdown[0].share).toBeCloseTo(2 / 3, 12);
    expect(breakdown[1].share).toBeCloseTo(1 / 3, 12);

    expect(breakdown.some((r) => r.totalCents === 999_999)).toBe(false);
  });

  it("keeps income out of the expense breakdown and vice versa", () => {
    const income = categoryBreakdown({
      transactions: rows,
      categories: CATEGORIES,
      startKey: "2026-03-01",
      endKey: "2026-03-31",
      direction: "income",
    });
    expect(income.map((r) => r.name)).toEqual(["Salary"]);
    expect(income[0].share).toBe(1);
  });

  it("reports an unknown category as an explicit row rather than dropping the money", () => {
    const breakdown = categoryBreakdown({
      transactions: [
        tx({ dateKey: "2026-03-01", amountCents: 100_000, categoryId: 2 }),
        tx({ dateKey: "2026-03-02", amountCents: 4_242, categoryId: 99 }),
      ],
      categories: CATEGORIES,
      startKey: "2026-03-01",
      endKey: "2026-03-31",
      direction: "all",
    });
    const orphan = breakdown.find((r) => r.categoryId === 99);
    expect(orphan).toBeDefined();
    expect(orphan?.totalCents).toBe(4_242);
    expect(orphan?.uncategorized).toBe(true);

    expect(orphan?.share).toBeNull();
  });

  it("has no share when the direction total is zero", () => {
    const breakdown = categoryBreakdown({
      transactions: [tx({ dateKey: "2026-03-01", amountCents: 0, categoryId: 2 })],
      categories: CATEGORIES,
      startKey: "2026-03-01",
      endKey: "2026-03-31",
      direction: "expense",
    });
    expect(breakdown[0].share).toBeNull();
  });
});

describe("currencyScope", () => {
  const accounts = [
    { id: 1, name: "Checking", currency: "USD" },
    { id: 2, name: "Beirut", currency: "LBP" },
    { id: 3, name: "Sparbuch", currency: "eur" },
  ];

  it("is not mixed when every counted row sits in one currency", () => {
    const scope = currencyScope(
      [tx({ dateKey: "2026-03-01", amountCents: 100, categoryId: 2, accountId: 1 })],
      accounts,
    );
    expect(scope.mixed).toBe(false);
    expect(scope.currencies).toEqual(["USD"]);
    expect(scope.primary).toBe("USD");
  });

  it("flags mixed currencies instead of adding them up", () => {
    const scope = currencyScope(
      [
        tx({ dateKey: "2026-03-01", amountCents: 100, categoryId: 2, accountId: 1 }),
        tx({ dateKey: "2026-03-02", amountCents: 200, categoryId: 2, accountId: 2 }),
        tx({ dateKey: "2026-03-03", amountCents: 300, categoryId: 2, accountId: 3 }),
      ],
      accounts,
    );
    expect(scope.mixed).toBe(true);
    expect(scope.currencies).toEqual(["EUR", "LBP", "USD"]);

    expect(scope.currencies).toContain(scope.primary);
  });

  it("does not let a transfer or a pending row invent a currency", () => {
    const scope = currencyScope(
      [
        tx({ dateKey: "2026-03-01", amountCents: 100, categoryId: 2, accountId: 1 }),
        tx({ dateKey: "2026-03-02", amountCents: 200, accountId: 2, transferAccountId: 3 }),
        tx({ dateKey: "2026-03-03", amountCents: 300, categoryId: 2, accountId: 3, pending: true }),
      ],
      accounts,
    );
    expect(scope.currencies).toEqual(["USD"]);
    expect(scope.mixed).toBe(false);
  });

  it("counts rows with no account, which belong to no currency", () => {
    const scope = currencyScope(
      [
        tx({ dateKey: "2026-03-01", amountCents: 100, categoryId: 2, accountId: 1 }),
        tx({ dateKey: "2026-03-02", amountCents: 200, categoryId: 2, accountId: null }),
      ],
      accounts,
    );
    expect(scope.unassignedCount).toBe(1);
  });

  it("filterByCurrency keeps unassigned rows with the primary currency only", () => {
    const rows = [
      tx({ dateKey: "2026-03-01", amountCents: 100, categoryId: 2, accountId: 1 }),
      tx({ dateKey: "2026-03-02", amountCents: 200, categoryId: 2, accountId: 2 }),
      tx({ dateKey: "2026-03-03", amountCents: 300, categoryId: 2, accountId: null }),
    ];
    expect(filterByCurrency(rows, accounts, "USD", { includeUnassigned: true })).toHaveLength(2);
    expect(filterByCurrency(rows, accounts, "LBP", { includeUnassigned: false })).toHaveLength(1);
  });

  it("uses stored transaction currency after the account currency changes", () => {
    const rows = [
      tx({
        dateKey: "2026-03-01",
        amountCents: 100,
        categoryId: 2,
        accountId: 1,
        currency: "EUR",
      }),
    ];
    expect(currencyScope(rows, accounts).currencies).toEqual(["EUR"]);
    expect(filterByCurrency(rows, accounts, "EUR")).toEqual(rows);
    expect(filterByCurrency(rows, accounts, "USD")).toEqual([]);
  });
});

describe("centsToDecimalString", () => {
  it("renders exact two-decimal strings with no float arithmetic", () => {
    expect(centsToDecimalString(4_550)).toBe("45.50");
    expect(centsToDecimalString(1)).toBe("0.01");
    expect(centsToDecimalString(0)).toBe("0.00");
    expect(centsToDecimalString(-4_550)).toBe("-45.50");
    expect(centsToDecimalString(100_000_000)).toBe("1000000.00");
    expect(centsToDecimalString(267)).toBe("2.67");
  });

  it("throws on a float, so a leaked non-integer never reaches a file", () => {
    expect(() => centsToDecimalString(45.5)).toThrow(/cents/i);
  });
});

describe("buildTransactionsCsv", () => {
  it("writes the header row the app's own importer recognises", () => {
    const csv = buildTransactionsCsv([]);
    const firstLine = csv.replace(/^\uFEFF/, "").split("\r\n")[0];
    expect(firstLine.split(",")).toEqual([...CSV_HEADERS]);
    expect(CSV_HEADERS.slice(0, 4)).toEqual(["Date", "Category", "Amount", "Description"]);
  });

  it("quotes fields containing a comma, a quote or a newline", () => {
    const csv = buildTransactionsCsv([
      {
        dateKey: "2026-03-01",
        categoryName: "Groceries",
        categoryType: "Expense",
        amountCents: 4_550,
        description: 'Coffee, "black"\nsecond line',
        accountName: "Checking",
        pending: false,
        transferAccountName: null,
        currency: "USD",
      },
    ]);
    expect(csv).toContain('"Coffee, ""black""\nsecond line"');
  });
});

describe("toReportTransactions", () => {
  it("uses the LOCAL calendar day of the stored timestamp", () => {

    const rows = toReportTransactions([
      { date: new Date(2026, 0, 31), amountCents: 100, categoryId: 2 },
      { date: new Date(2026, 1, 1), amountCents: 200, categoryId: 2 },
    ]);
    expect(rows.map((r) => r.dateKey)).toEqual(["2026-01-31", "2026-02-01"]);
  });

  it("keeps the ledger fields the balance rule needs", () => {
    const [row] = toReportTransactions([
      {
        date: new Date(2026, 2, 15),
        amountCents: 500,
        categoryId: 7,
        pending: true,
        accountId: 3,
        transferAccountId: 4,
      },
    ]);
    expect(row).toMatchObject({
      dateKey: "2026-03-15",
      amountCents: 500,
      categoryId: 7,
      pending: true,
      accountId: 3,
      transferAccountId: 4,
    });
  });
});
