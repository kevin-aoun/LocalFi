
import { describe, expect, it } from "vitest";

import {
  RANGE_PRESETS,
  RANGE_PRESET_LABELS,
  comparisonRange,
  deltaTone,
  describeCurrencyCaveat,
  describeExclusions,
  describeUnassigned,
  formatDelta,
  formatRangeLabel,
  periodLabel,
  rangeForPreset,
  suggestPeriod,
  toCashFlowChartRows,
} from "@/components/reports/report-view-logic";
import { cashFlowByPeriod, emptyFlowTotals, type ReportCategory } from "@/lib/reports";

const TODAY = "2026-07-28";

describe("rangeForPreset", () => {
  it("this month and last month are whole calendar months", () => {
    expect(rangeForPreset("this-month", TODAY)).toEqual({
      startKey: "2026-07-01",
      endKey: "2026-07-31",
    });
    expect(rangeForPreset("last-month", TODAY)).toEqual({
      startKey: "2026-06-01",
      endKey: "2026-06-30",
    });
  });

  it("crosses a year boundary without arithmetic on the day-of-month", () => {
    expect(rangeForPreset("last-month", "2026-01-31")).toEqual({
      startKey: "2025-12-01",
      endKey: "2025-12-31",
    });

    expect(rangeForPreset("last-month", "2026-03-31")).toEqual({
      startKey: "2026-02-01",
      endKey: "2026-02-28",
    });
  });

  it("last 3 / 12 months are whole months ending with the current one", () => {
    expect(rangeForPreset("last-3-months", TODAY)).toEqual({
      startKey: "2026-05-01",
      endKey: "2026-07-31",
    });
    expect(rangeForPreset("last-12-months", TODAY)).toEqual({
      startKey: "2025-08-01",
      endKey: "2026-07-31",
    });
  });

  it("year to date ends TODAY, and last year is the whole previous year", () => {
    expect(rangeForPreset("year-to-date", TODAY)).toEqual({
      startKey: "2026-01-01",
      endKey: "2026-07-28",
    });
    expect(rangeForPreset("last-year", TODAY)).toEqual({
      startKey: "2025-01-01",
      endKey: "2025-12-31",
    });
  });

  it("all time spans the data, and reaches a future-dated transaction", () => {
    expect(
      rangeForPreset("all-time", TODAY, { earliestKey: "2019-03-04", latestKey: "2026-07-01" }),
    ).toEqual({ startKey: "2019-03-04", endKey: TODAY });
    expect(
      rangeForPreset("all-time", TODAY, { earliestKey: "2019-03-04", latestKey: "2027-01-15" }),
    ).toEqual({ startKey: "2019-03-04", endKey: "2027-01-15" });
  });

  it("all time falls back to this month on an empty ledger", () => {
    expect(rangeForPreset("all-time", TODAY, {})).toEqual({
      startKey: "2026-07-01",
      endKey: TODAY,
    });
  });

  it("custom has no implied range", () => {
    expect(rangeForPreset("custom", TODAY)).toBeNull();
  });

  it("every preset has a label", () => {
    for (const preset of RANGE_PRESETS) {
      expect(RANGE_PRESET_LABELS[preset]).toBeTruthy();
    }
  });

  it("refuses a malformed 'today'", () => {
    expect(() => rangeForPreset("this-month", "2026-7-1")).toThrow(/YYYY-MM-DD/);
  });
});

describe("suggestPeriod", () => {
  it("scales with the length of the range", () => {
    expect(suggestPeriod({ startKey: "2026-07-01", endKey: "2026-07-31" })).toBe("weekly");
    expect(suggestPeriod({ startKey: "2026-01-01", endKey: "2026-12-31" })).toBe("monthly");
    expect(suggestPeriod({ startKey: "2019-01-01", endKey: "2026-12-31" })).toBe("yearly");
  });
});

describe("periodLabel", () => {
  it("labels each period type from local components", () => {
    expect(periodLabel("2026", "yearly")).toBe("2026");
    expect(periodLabel("2026-03", "monthly")).toBe("Mar 26");
    expect(periodLabel("2026-01-12", "weekly")).toBe("Jan 12");
  });
});

describe("formatRangeLabel", () => {
  it("renders both ends of the range", () => {
    expect(formatRangeLabel({ startKey: "2026-01-01", endKey: "2026-03-31" })).toBe(
      "Jan 1, 2026 - Mar 31, 2026",
    );
  });
});

describe("comparisonRange", () => {
  it("year over year shifts a whole month back one year", () => {
    expect(
      comparisonRange("year-over-year", { startKey: "2026-03-01", endKey: "2026-03-31" }, "monthly"),
    ).toEqual({ startKey: "2025-03-01", endKey: "2025-03-31" });
  });

  it("previous period uses the period machinery for a whole period", () => {
    expect(
      comparisonRange(
        "previous-period",
        { startKey: "2026-01-01", endKey: "2026-01-31" },
        "monthly",
      ),
    ).toEqual({ startKey: "2025-12-01", endKey: "2025-12-31" });
  });

  it("previous period shifts an ARBITRARY range back by its own length", () => {

    expect(
      comparisonRange(
        "previous-period",
        { startKey: "2026-03-10", endKey: "2026-03-19" },
        "monthly",
      ),
    ).toEqual({ startKey: "2026-02-28", endKey: "2026-03-09" });
  });

  it("year over year clamps a leap day rather than rolling into March", () => {
    expect(
      comparisonRange("year-over-year", { startKey: "2024-02-01", endKey: "2024-02-29" }, "monthly"),
    ).toEqual({ startKey: "2023-02-01", endKey: "2023-02-28" });
  });
});

describe("describeExclusions", () => {
  it("says nothing when there is nothing to say", () => {
    expect(describeExclusions(emptyFlowTotals())).toEqual([]);
  });

  it("reports pending, transfers and uncategorized rows in plain words", () => {
    const notes = describeExclusions({
      ...emptyFlowTotals(),
      pendingCount: 2,
      pendingIncomeCents: 30_000,
      pendingExpenseCents: 90_000,
      transferCount: 1,
      uncategorizedCount: 3,
    });
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain("2 pending transactions excluded");
    expect(notes[0]).toContain("$300.00 in");
    expect(notes[0]).toContain("$900.00 out");
    expect(notes[1]).toContain("1 transfer excluded");
    expect(notes[2]).toContain("3 transactions");
    expect(notes.join(" ")).not.toMatch(/NaN|Infinity|undefined/);
  });
});

describe("currency copy", () => {
  it("is silent for a single currency and explicit for several", () => {
    expect(
      describeCurrencyCaveat({
        currencies: ["USD"],
        primary: "USD",
        mixed: false,
        unassignedCount: 0,
      }),
    ).toBeNull();

    const caveat = describeCurrencyCaveat({
      currencies: ["LBP", "USD"],
      primary: "USD",
      mixed: true,
      unassignedCount: 0,
    });
    expect(caveat).toContain("LBP, USD");
    expect(caveat).toContain("no exchange rates");
  });

  it("explains where an account-less transaction was counted", () => {
    expect(
      describeUnassigned({ currencies: ["USD"], primary: "USD", mixed: false, unassignedCount: 0 }),
    ).toBeNull();
    expect(
      describeUnassigned({ currencies: ["USD"], primary: "USD", mixed: false, unassignedCount: 1 }),
    ).toContain("counted under USD");
  });
});

describe("toCashFlowChartRows", () => {
  const CATEGORIES: ReportCategory[] = [
    { id: 1, name: "Salary", type: "Income" },
    { id: 2, name: "Groceries", type: "Expense" },
  ];

  it("converts to decimals exactly once, plots money out downwards, and keeps cents", () => {
    const flows = cashFlowByPeriod({
      transactions: [
        { dateKey: "2026-03-01", amountCents: 500_000, categoryId: 1, accountId: 1 },
        { dateKey: "2026-03-02", amountCents: 4_550, categoryId: 2, accountId: 1 },
      ],
      categories: CATEGORIES,
      period: "monthly",
      fromKey: "2026-03-01",
      toKey: "2026-03-31",
    });
    const [row] = toCashFlowChartRows(flows, "monthly");

    expect(row.label).toBe("Mar 26");
    expect(row.income).toBe(5000);
    expect(row.expense).toBe(-45.5);
    expect(row.net).toBe(4954.5);
    expect(row.incomeCents).toBe(500_000);
    expect(row.expenseCents).toBe(4_550);
    expect(row.netCents).toBe(495_450);
  });
});

describe("deltaTone / formatDelta", () => {
  it("knows that spending more is not an improvement", () => {
    expect(deltaTone("income", 100)).toBe("good");
    expect(deltaTone("income", -100)).toBe("bad");
    expect(deltaTone("expense", 100)).toBe("bad");
    expect(deltaTone("expense", -100)).toBe("good");
    expect(deltaTone("net", 100)).toBe("good");
    expect(deltaTone("net", 0)).toBe("neutral");
  });

  it("formats a signed delta through formatMoney, never a hand-rolled toFixed", () => {
    expect(formatDelta(12_000)).toBe("+$120.00");
    expect(formatDelta(-4_550)).toBe("-$45.50");
    expect(formatDelta(0)).toBe("$0.00");
    expect(formatDelta(12_000, "LBP")).toBe("+LBP 120.00");
  });
});
