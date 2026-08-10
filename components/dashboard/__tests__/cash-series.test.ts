/**
 * Regression tests for items 8 and 9.
 *
 * 8. The candlestick series skipped `Investment` transactions while the
 *    `cashBalance` on the same card subtracted them, so the chart's close could
 *    never match the label above it. The key test here derives the whole series
 *    and asserts its final close IS `deriveCashBalanceCents(...)`.
 *
 * 9. `growth` / `growthAmount` were hardcoded `0`, i.e. the "vs. last month"
 *    block was decoration.
 *
 * The grouping tests must also pass under `bun run test:tz` (UTC+14 / UTC-11):
 * the old `getGroupKey` used `toISOString()`.
 */
import { describe, expect, it } from "vitest";
import { deriveCashBalanceCents } from "@/lib/cash-balance";
import { sumCents } from "@/lib/money";
import {
  buildCashCandles,
  cashContributionCents,
  computeCashGrowth,
  countsTowardsCash,
  formatPeriodLabel,
  groupKey,
} from "../cash-series";

const CATEGORIES = [
  { id: 1, type: "Income" },
  { id: 2, type: "Expense" },
  { id: 3, type: "Investment" },
];

const tx = (
  over: Partial<{
    categoryId: number | null;
    amountCents: number;
    date: Date;
    pending: boolean;
    transferAccountId: number | null;
    direction: "inflow" | "outflow" | "transfer" | null;
    currency: string;
  }> = {},
) => ({
  categoryId: 2,
  amountCents: 1000,
  date: new Date(2026, 6, 15),
  pending: false,
  ...over,
});

describe("the chart and the headline use ONE rule", () => {
  it("charts signed real-account legs so openings and split transfers count once", () => {
    const movements = [
      tx({ categoryId: null, amountCents: 100_000, direction: "inflow", date: new Date(2026, 0, 1) }),
      tx({ categoryId: null, amountCents: 20_000, direction: "outflow", date: new Date(2026, 0, 2) }),
      tx({ categoryId: null, amountCents: 15_000, direction: "inflow", date: new Date(2026, 0, 2) }),
    ];
    const candles = buildCashCandles(movements, [], "daily");
    expect(candles[candles.length - 1].closeCents).toBe(95_000);
  });

  it("summing the per-row contributions reproduces deriveCashBalanceCents", () => {
    const ledger = [
      tx({ categoryId: 1, amountCents: 500000, date: new Date(2026, 5, 1) }),
      tx({ categoryId: 2, amountCents: 4500, date: new Date(2026, 5, 3) }),
      tx({ categoryId: 3, amountCents: 100000, date: new Date(2026, 6, 2) }),
      tx({ categoryId: 99, amountCents: 777, date: new Date(2026, 6, 3) }), // unknown category
      tx({ categoryId: null, amountCents: 888, date: new Date(2026, 6, 4) }), // no category
      tx({ categoryId: 2, amountCents: 1200, date: new Date(2026, 6, 5), pending: true }),
    ];

    const summed = sumCents(
      countsTowardsCash(ledger).map((row) => cashContributionCents(row, CATEGORIES)),
    );
    expect(summed).toBe(deriveCashBalanceCents(ledger, CATEGORIES));
    expect(summed).toBe(500000 - 4500 - 100000);
  });

  it("the final candle's close equals the headline balance", () => {
    const ledger = [
      tx({ categoryId: 1, amountCents: 500000, date: new Date(2026, 5, 1) }),
      tx({ categoryId: 2, amountCents: 4500, date: new Date(2026, 5, 3) }),
      // THE BUG: this Investment row was skipped by the chart but subtracted by
      // the headline, so the two disagreed by exactly $1,000.
      tx({ categoryId: 3, amountCents: 100000, date: new Date(2026, 6, 2) }),
    ];

    for (const period of ["daily", "weekly", "monthly"] as const) {
      const candles = buildCashCandles(ledger, CATEGORIES, period);
      expect(candles[candles.length - 1].closeCents).toBe(
        deriveCashBalanceCents(ledger, CATEGORIES),
      );
    }
  });

  it("an Investment row moves the chart down, it does not vanish", () => {
    const candles = buildCashCandles(
      [
        tx({ categoryId: 1, amountCents: 100000, date: new Date(2026, 5, 1) }),
        tx({ categoryId: 3, amountCents: 40000, date: new Date(2026, 6, 1) }),
      ],
      CATEGORIES,
      "monthly",
    );

    expect(candles.map((c) => [c.period, c.closeCents])).toEqual([
      ["2026-06", 100000],
      ["2026-07", 60000],
    ]);
  });

  it("uses stored direction instead of editable category metadata", () => {
    const ledger = [
      tx({
        categoryId: 2,
        direction: "inflow",
        currency: "USD",
        amountCents: 10_000,
        date: new Date(2026, 5, 1),
      }),
      tx({
        categoryId: null,
        direction: "outflow",
        currency: "USD",
        amountCents: 2_000,
        date: new Date(2026, 5, 2),
      }),
    ];

    const candles = buildCashCandles(ledger, CATEGORIES, "monthly", "USD");
    expect(candles.at(-1)?.closeCents).toBe(8_000);
  });

  it("builds each selected currency without cross-denomination candles", () => {
    const ledger = [
      tx({ direction: "inflow", currency: "USD", amountCents: 10_000 }),
      tx({ direction: "inflow", currency: "EUR", amountCents: 20_000 }),
    ];

    expect(buildCashCandles(ledger, CATEGORIES, "monthly", "USD").at(-1)?.closeCents).toBe(
      10_000,
    );
    expect(buildCashCandles(ledger, CATEGORIES, "monthly", "EUR").at(-1)?.closeCents).toBe(
      20_000,
    );
    expect(computeCashGrowth(ledger, CATEGORIES, new Date(2026, 6, 20), "EUR")).toEqual({
      baselineCents: 0,
      growthAmountCents: 20_000,
      growthPercent: null,
    });
  });

  it("excludes pending rows, exactly like the headline does", () => {
    const ledger = [
      tx({ categoryId: 1, amountCents: 100000, date: new Date(2026, 5, 1) }),
      tx({ categoryId: 2, amountCents: 50000, date: new Date(2026, 5, 2), pending: true }),
    ];
    const candles = buildCashCandles(ledger, CATEGORIES, "monthly");
    expect(candles[candles.length - 1].closeCents).toBe(100000);
    expect(deriveCashBalanceCents(ledger, CATEGORIES)).toBe(100000);
  });

  it("excludes transfers, exactly like the headline does", () => {
    const ledger = [
      tx({ categoryId: 1, amountCents: 100000, date: new Date(2026, 5, 1) }),
      tx({ categoryId: 2, amountCents: 50000, date: new Date(2026, 5, 2), transferAccountId: 7 }),
    ];
    const candles = buildCashCandles(ledger, CATEGORIES, "monthly");
    expect(candles[candles.length - 1].closeCents).toBe(100000);
    expect(deriveCashBalanceCents(ledger, CATEGORIES)).toBe(100000);
  });

  it("carries each candle's open from the previous close", () => {
    const candles = buildCashCandles(
      [
        tx({ categoryId: 1, amountCents: 10000, date: new Date(2026, 5, 1) }),
        tx({ categoryId: 2, amountCents: 3000, date: new Date(2026, 6, 1) }),
        tx({ categoryId: 2, amountCents: 2000, date: new Date(2026, 6, 20) }),
      ],
      CATEGORIES,
      "monthly",
    );

    expect(candles).toEqual([
      { period: "2026-06", openCents: 0, closeCents: 10000, highCents: 10000, lowCents: 0 },
      { period: "2026-07", openCents: 10000, closeCents: 5000, highCents: 10000, lowCents: 5000 },
    ]);
  });

  it("returns nothing for an empty ledger", () => {
    expect(buildCashCandles([], CATEGORIES, "monthly")).toEqual([]);
  });
});

describe("bucket keys use the LOCAL calendar day", () => {
  it("keeps a local-midnight transaction in its own day and month", () => {
    const date = new Date(2026, 6, 1); // 1 July, local midnight
    expect(groupKey(date, "daily")).toBe("2026-07-01");
    expect(groupKey(date, "monthly")).toBe("2026-07");
    // THE BUG: east of UTC, toISOString() put this in 2026-06-30 / 2026-06.
    expect(groupKey(date, "daily")).not.toBe("2026-06-30");
  });

  it("groups a week onto its local Sunday", () => {
    // 2026-07-15 is a Wednesday; the Sunday before is 2026-07-12.
    expect(groupKey(new Date(2026, 6, 15), "weekly")).toBe("2026-07-12");
    expect(groupKey(new Date(2026, 6, 12), "weekly")).toBe("2026-07-12");
  });

  it("labels a bucket without drifting a day", () => {
    expect(formatPeriodLabel("2026-07-01", "daily")).toBe("Jul 1");
    expect(formatPeriodLabel("2026-01-01", "daily")).toBe("Jan 1");
    expect(formatPeriodLabel("2026-07", "monthly")).toBe("Jul 26");
  });

  it("puts a 1st-of-month transaction in that month's candle in any timezone", () => {
    const candles = buildCashCandles(
      [
        tx({ categoryId: 1, amountCents: 1000, date: new Date(2026, 5, 30) }),
        tx({ categoryId: 2, amountCents: 400, date: new Date(2026, 6, 1) }),
      ],
      CATEGORIES,
      "monthly",
    );
    expect(candles.map((c) => c.period)).toEqual(["2026-06", "2026-07"]);
  });
});

describe("computeCashGrowth replaces the hardcoded zero", () => {
  const now = new Date(2026, 6, 20); // 20 July 2026

  it("measures the change since the end of last month", () => {
    const ledger = [
      tx({ categoryId: 1, amountCents: 100000, date: new Date(2026, 5, 1) }), // June: +1000
      tx({ categoryId: 1, amountCents: 50000, date: new Date(2026, 6, 5) }), // July: +500
      tx({ categoryId: 2, amountCents: 20000, date: new Date(2026, 6, 10) }), // July: -200
    ];

    const growth = computeCashGrowth(ledger, CATEGORIES, now);
    expect(growth.baselineCents).toBe(100000);
    expect(growth.growthAmountCents).toBe(30000);
    expect(growth.growthPercent).toBeCloseTo(30, 10);
  });

  it("agrees with the headline: baseline + growth === current balance", () => {
    const ledger = [
      tx({ categoryId: 1, amountCents: 777_77, date: new Date(2026, 4, 9) }),
      tx({ categoryId: 3, amountCents: 12_345, date: new Date(2026, 6, 2) }),
      tx({ categoryId: 2, amountCents: 6_789, date: new Date(2026, 6, 19) }),
    ];
    const growth = computeCashGrowth(ledger, CATEGORIES, now);
    expect(sumCents([growth.baselineCents, growth.growthAmountCents])).toBe(
      deriveCashBalanceCents(ledger, CATEGORIES),
    );
  });

  it("reports a negative move as negative", () => {
    const growth = computeCashGrowth(
      [
        tx({ categoryId: 1, amountCents: 100000, date: new Date(2026, 5, 1) }),
        tx({ categoryId: 2, amountCents: 25000, date: new Date(2026, 6, 3) }),
      ],
      CATEGORIES,
      now,
    );
    expect(growth.growthAmountCents).toBe(-25000);
    expect(growth.growthPercent).toBeCloseTo(-25, 10);
  });

  it("returns null percent (not Infinity, not 0) when last month closed at zero", () => {
    const growth = computeCashGrowth(
      [tx({ categoryId: 1, amountCents: 100000, date: new Date(2026, 6, 3) })],
      CATEGORIES,
      now,
    );
    expect(growth.baselineCents).toBe(0);
    expect(growth.growthAmountCents).toBe(100000);
    expect(growth.growthPercent).toBeNull();
  });

  it("is zero when nothing happened this month", () => {
    const growth = computeCashGrowth(
      [tx({ categoryId: 1, amountCents: 100000, date: new Date(2026, 5, 1) })],
      CATEGORIES,
      now,
    );
    expect(growth.growthAmountCents).toBe(0);
    expect(growth.growthPercent).toBe(0);
  });

  it("counts a transaction dated the 1st of this month as this month", () => {
    const growth = computeCashGrowth(
      [tx({ categoryId: 1, amountCents: 5000, date: new Date(2026, 6, 1) })],
      CATEGORIES,
      now,
    );
    // The old month-boundary bug would have filed this into June.
    expect(growth.baselineCents).toBe(0);
    expect(growth.growthAmountCents).toBe(5000);
  });

  it("ignores pending rows on both sides of the boundary", () => {
    const growth = computeCashGrowth(
      [
        tx({ categoryId: 1, amountCents: 100000, date: new Date(2026, 5, 1) }),
        tx({ categoryId: 2, amountCents: 9999, date: new Date(2026, 5, 2), pending: true }),
        tx({ categoryId: 2, amountCents: 8888, date: new Date(2026, 6, 2), pending: true }),
      ],
      CATEGORIES,
      now,
    );
    expect(growth.baselineCents).toBe(100000);
    expect(growth.growthAmountCents).toBe(0);
  });
});
