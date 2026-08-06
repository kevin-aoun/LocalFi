/**
 * The model itself, with no database and no network.
 *
 * THE PROPERTY THIS FILE EXISTS FOR: buying an asset is a CONVERSION, not a gain.
 * Cash falls by what was paid, the holding appears worth the same, and net worth
 * on the purchase day is EXACTLY unchanged — 0 cents of step. Everything else
 * here (zero before acquisition, pending/transfer handling, carried prices,
 * refusing to price a day it cannot know) protects that same honesty.
 */
import { describe, expect, it } from "vitest";

import {
  eachDay,
  measureContinuity,
  reconstructNetWorthSeries,
  resolveHoldings,
  type HistoryAsset,
  type HistoryCategory,
  type HistoryTransaction,
} from "../reconstruct";
import { HISTORICAL_PRICE_SOURCES, buildSeries, type PriceSeries } from "../prices";
import type { LedgerAccount } from "@/lib/cash-balance";
import type { PriceSymbol } from "@/lib/prices";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATEGORIES: HistoryCategory[] = [
  { id: 1, name: "Salary", type: "Income" },
  { id: 2, name: "Food", type: "Expense" },
  { id: 3, name: "Commodities", type: "Investment" },
  { id: 4, name: "Crypto", type: "Investment" },
];

const ACCOUNTS: LedgerAccount[] = [{ id: 1, kind: "asset", openingBalanceCents: 0 }];

/** Local-midnight unix seconds, so `createdAt` round-trips in every timezone. */
function secondsFor(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
}

function flatSeries(symbol: PriceSymbol, points: Array<[string, number]>): PriceSeries {
  return buildSeries(
    symbol,
    HISTORICAL_PRICE_SOURCES[symbol]!,
    points.map(([dateKey, priceUsd]) => ({ dateKey, priceUsd })),
  );
}

function seriesMap(...entries: PriceSeries[]): Map<PriceSymbol, PriceSeries> {
  return new Map(entries.map((s) => [s.symbol, s]));
}

function dayOf<T extends { dateKey: string }>(days: readonly T[], key: string): T {
  const found = days.find((d) => d.dateKey === key);
  if (!found) throw new Error(`no reconstructed day for ${key}`);
  return found;
}

// ---------------------------------------------------------------------------

describe("eachDay", () => {
  it("walks calendar days inclusively, across a month boundary", () => {
    expect(eachDay("2026-01-30", "2026-02-02")).toEqual([
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
  });

  it("handles a single day and a leap day", () => {
    expect(eachDay("2026-03-01", "2026-03-01")).toEqual(["2026-03-01"]);
    expect(eachDay("2024-02-28", "2024-03-01")).toEqual(["2024-02-28", "2024-02-29", "2024-03-01"]);
  });
});

describe("a purchase day shows NO jump — the whole point of the model", () => {
  // $10,000.00 of salary on the 1st, then $3,800.00 of it becomes 2 oz of gold
  // on the 10th, at exactly the $1,900.00/oz close of that day.
  const transactions: HistoryTransaction[] = [
    { id: 1, dateKey: "2026-01-01", categoryId: 1, amountCents: 1_000_000, accountId: 1 },
    { id: 2, dateKey: "2026-01-10", categoryId: 3, amountCents: 380_000, accountId: 1, comment: "Gold (2oz)" },
  ];
  const assets: HistoryAsset[] = [
    {
      id: 1,
      category: "Commodities",
      currentValueCents: 400_000,
      quantity: 2,
      unit: "oz",
      priceSymbol: "XAU",
      createdAt: secondsFor("2026-01-20"), // added to the app long after the purchase
    },
  ];
  const gold = flatSeries("XAU", [
    ["2026-01-08", 1900],
    ["2026-01-09", 1900],
    ["2026-01-10", 1900],
    ["2026-01-11", 1900],
    ["2026-01-12", 2000], // +$100/oz
  ]);

  const result = reconstructNetWorthSeries({
    accounts: ACCOUNTS,
    transactions,
    categories: CATEGORIES,
    assets,
    seriesBySymbol: seriesMap(gold),
    fromKey: "2026-01-08",
    toKey: "2026-01-12",
  });

  it("reconstructs the range", () => {
    expect(result.ok).toBe(true);
  });

  it("is EXACTLY continuous across the purchase: 0 cents of step", () => {
    if (!result.ok) throw new Error("reconstruction failed");
    const before = dayOf(result.days, "2026-01-09");
    const purchase = dayOf(result.days, "2026-01-10");

    // Cash falls by 380000 and 2 oz worth 380000 appear on the other side.
    expect(before.accountsCents).toBe(1_000_000);
    expect(before.holdingsCents).toBe(0);
    expect(purchase.accountsCents).toBe(620_000);
    expect(purchase.holdingsCents).toBe(380_000);

    expect(purchase.netWorthCents).toBe(before.netWorthCents);
    expect(purchase.netWorthCents - before.netWorthCents).toBe(0);
    expect(purchase.netWorthCents).toBe(1_000_000);
  });

  it("reports the continuity residual as exactly 0", () => {
    if (!result.ok) throw new Error("reconstruction failed");
    expect(result.continuity).toHaveLength(1);
    expect(result.continuity[0]).toMatchObject({
      dateKey: "2026-01-10",
      paidCents: 380_000,
      valuedCents: 380_000,
      residualCents: 0,
    });
  });

  it("moves net worth ONLY when the price moves, by exactly the price movement", () => {
    if (!result.ok) throw new Error("reconstruction failed");
    // 2 oz × +$100.00 = +$200.00, and not a cent more.
    expect(dayOf(result.days, "2026-01-11").netWorthCents).toBe(1_000_000);
    expect(dayOf(result.days, "2026-01-12").netWorthCents).toBe(1_020_000);
    expect(dayOf(result.days, "2026-01-12").holdingsCents).toBe(400_000);
  });

  it("contributes 0 before the purchase, not the holding's current value", () => {
    if (!result.ok) throw new Error("reconstruction failed");
    const before = dayOf(result.days, "2026-01-08");
    expect(before.holdings[0]).toMatchObject({ held: false, valueCents: 0, basis: "not-held" });
  });

  it("dates the acquisition from the ledger, not from assets.created_at", () => {
    if (!result.ok) throw new Error("reconstruction failed");
    expect(result.holdings[0]).toMatchObject({
      acquiredOn: "2026-01-10",
      acquisitionSource: "ledger",
      acquisitionTxId: 2,
      acquisitionCostCents: 380_000,
    });
  });
});

describe("the owner's real shape: a quantity the ledger does not fully explain", () => {
  // 1.1376 oz on the row, but the ledger only records paying $3,800.00 on
  // 2025-09-30, when PAXG closed at $3,849.23 — i.e. about 0.9872 oz. The rest
  // of the metal was added without a transaction, so no reconstruction can date
  // it. That must be REPORTED, never smoothed away.
  const result = reconstructNetWorthSeries({
    accounts: ACCOUNTS,
    transactions: [
      { id: 7, dateKey: "2025-09-30", categoryId: 3, amountCents: 380_000, accountId: 1, comment: "Gold (1oz)" },
    ],
    categories: CATEGORIES,
    assets: [
      {
        id: 2,
        category: "Commodities",
        currentValueCents: 486_157,
        quantity: 1.1376,
        unit: "oz",
        priceSymbol: "XAU",
        createdAt: secondsFor("2026-01-31"),
      },
    ],
    seriesBySymbol: seriesMap(flatSeries("XAU", [["2025-09-29", 3830.0], ["2025-09-30", 3849.23]])),
    fromKey: "2025-09-29",
    toKey: "2025-09-30",
  });

  it("values the holding at quantity × that day's price, rounded to the cent once", () => {
    if (!result.ok) throw new Error("reconstruction failed");
    // 1.1376 × 3849.23 = 4378.884048 -> $4,378.88
    expect(dayOf(result.days, "2025-09-30").holdingsCents).toBe(437_888);
  });

  it("surfaces the purchase-day step instead of hiding it", () => {
    if (!result.ok) throw new Error("reconstruction failed");
    expect(result.continuity[0]).toMatchObject({
      dateKey: "2025-09-30",
      paidCents: 380_000,
      valuedCents: 437_888,
      residualCents: 57_888, // +$578.88 the ledger cannot account for
    });
  });
});

describe("holdings with no purchase transaction (the owner's BTC and ETH)", () => {
  const assets: HistoryAsset[] = [
    {
      id: 4,
      category: "Crypto",
      currentValueCents: 9_962,
      quantity: 0.001537,
      unit: "coins",
      priceSymbol: "BTC",
      createdAt: secondsFor("2026-04-08"),
    },
    {
      id: 5,
      category: "Crypto",
      currentValueCents: 29_972,
      quantity: 0.156777,
      unit: "coins",
      priceSymbol: "ETH",
      createdAt: secondsFor("2026-04-10"),
    },
  ];
  const result = reconstructNetWorthSeries({
    accounts: ACCOUNTS,
    transactions: [{ id: 1, dateKey: "2026-04-01", categoryId: 1, amountCents: 500_000, accountId: 1 }],
    categories: CATEGORIES,
    assets,
    seriesBySymbol: seriesMap(
      flatSeries("BTC", [["2026-04-07", 70_000], ["2026-04-08", 71_661.76], ["2026-04-09", 71_000], ["2026-04-10", 72_000]]),
      flatSeries("ETH", [["2026-04-07", 2300], ["2026-04-10", 2351.6]]),
    ),
    fromKey: "2026-04-07",
    toKey: "2026-04-10",
  });

  it("treats assets.created_at as the acquisition date and says so", () => {
    if (!result.ok) throw new Error("reconstruction failed");
    expect(result.holdings.map((h) => [h.symbol, h.acquiredOn, h.acquisitionSource])).toEqual([
      ["BTC", "2026-04-08", "asset_created_at"],
      ["ETH", "2026-04-10", "asset_created_at"],
    ]);
    const warned = result.warnings.filter((w) => w.code === "acquisition_from_created_at");
    expect(warned).toHaveLength(2);
    expect(warned[0].message).toMatch(/no purchase transaction/i);
  });

  it("gives them exactly 0 before that day — never their current value", () => {
    if (!result.ok) throw new Error("reconstruction failed");
    expect(dayOf(result.days, "2026-04-07").holdingsCents).toBe(0);
    expect(dayOf(result.days, "2026-04-07").netWorthCents).toBe(500_000);
    // 0.001537 × 71661.76 = 110.144... -> $110.14, ETH still absent
    expect(dayOf(result.days, "2026-04-08").holdingsCents).toBe(11_014);
  });

  it("refuses to date them from an unrelated purchase in the same category", () => {
    // Two Crypto assets and one Crypto purchase: nothing says which row it bought.
    const { holdings } = resolveHoldings(
      assets,
      [{ id: 9, dateKey: "2026-01-01", categoryId: 4, amountCents: 20_000, accountId: 1 }],
      CATEGORIES,
      new Map(),
    );
    expect(holdings.every((h) => h.acquisitionSource === "asset_created_at")).toBe(true);
  });

  it("DOES use an explicit linked transaction, whatever the category count", () => {
    const { holdings } = resolveHoldings(
      [{ ...assets[0], linkedTransactionIds: "[9]" }, assets[1]],
      [{ id: 9, dateKey: "2026-01-05", categoryId: 4, amountCents: 20_000, accountId: 1 }],
      CATEGORIES,
      new Map(),
    );
    expect(holdings[0]).toMatchObject({ acquiredOn: "2026-01-05", acquisitionSource: "ledger" });
    expect(holdings[1].acquisitionSource).toBe("asset_created_at");
  });
});

describe("prices that are missing for a day", () => {
  const assets: HistoryAsset[] = [
    {
      id: 1,
      category: "Commodities",
      currentValueCents: 400_000,
      quantity: 2,
      unit: "oz",
      priceSymbol: "XAU",
      createdAt: secondsFor("2026-01-05"),
    },
  ];

  it("carries the last known close forward over a weekend, and reports how many days", () => {
    const result = reconstructNetWorthSeries({
      accounts: ACCOUNTS,
      transactions: [],
      categories: CATEGORIES,
      assets,
      seriesBySymbol: seriesMap(flatSeries("XAU", [["2026-01-05", 1900], ["2026-01-08", 1950]])),
      fromKey: "2026-01-05",
      toKey: "2026-01-08",
    });
    if (!result.ok) throw new Error("reconstruction failed");

    expect(dayOf(result.days, "2026-01-06").holdingsCents).toBe(380_000);
    expect(dayOf(result.days, "2026-01-06").holdings[0]).toMatchObject({
      priceCarriedForward: true,
      priceAsOfKey: "2026-01-05",
    });
    expect(dayOf(result.days, "2026-01-08").holdings[0].priceCarriedForward).toBe(false);
    const carried = result.warnings.find((w) => w.code === "price_carried_forward");
    expect(carried?.message).toMatch(/XAU: 2 day\(s\)/);
    expect(dayOf(result.days, "2026-01-06").sourceNote).toMatch(/carried forward from 2026-01-05/);
  });

  it("REFUSES the whole range when a held day precedes the price window", () => {
    const result = reconstructNetWorthSeries({
      accounts: ACCOUNTS,
      transactions: [],
      categories: CATEGORIES,
      assets,
      seriesBySymbol: seriesMap(flatSeries("XAU", [["2026-01-07", 1900]])),
      fromKey: "2026-01-05",
      toKey: "2026-01-08",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("no_price_for_day");
    expect(result.error.message).toMatch(/365 days/);
  });

  it("only carries the stored value when explicitly allowed, and marks the day", () => {
    const result = reconstructNetWorthSeries({
      accounts: ACCOUNTS,
      transactions: [],
      categories: CATEGORIES,
      assets,
      seriesBySymbol: seriesMap(flatSeries("XAU", [["2026-01-07", 1900]])),
      fromKey: "2026-01-05",
      toKey: "2026-01-07",
      carryUnpriced: true,
    });
    if (!result.ok) throw new Error("reconstruction failed");
    expect(dayOf(result.days, "2026-01-05").holdingsCents).toBe(400_000); // the stored figure
    expect(dayOf(result.days, "2026-01-05").holdings[0].basis).toBe("carried-stored-value");
    expect(dayOf(result.days, "2026-01-07").holdingsCents).toBe(380_000); // priced
  });
});

describe("hand-valued assets", () => {
  it("carries the stored value from its creation day and discloses it", () => {
    const result = reconstructNetWorthSeries({
      accounts: ACCOUNTS,
      transactions: [],
      categories: CATEGORIES,
      assets: [
        {
          id: 3,
          category: "Properties",
          currentValueCents: 25_000_000,
          notes: "Flat",
          createdAt: secondsFor("2026-01-02"),
        },
      ],
      seriesBySymbol: new Map(),
      fromKey: "2026-01-01",
      toKey: "2026-01-03",
    });
    if (!result.ok) throw new Error("reconstruction failed");

    expect(dayOf(result.days, "2026-01-01").holdingsCents).toBe(0);
    expect(dayOf(result.days, "2026-01-03").holdingsCents).toBe(25_000_000);
    expect(dayOf(result.days, "2026-01-03").sourceNote).toMatch(/hand-valued/);
    expect(result.warnings.some((w) => w.code === "carried_stored_value")).toBe(true);
  });
});

describe("the shared ledger rules are reused, not re-implemented", () => {
  const assets: HistoryAsset[] = [];

  it("excludes pending rows and the derived Cash asset, and nets transfers to zero", () => {
    const accounts: LedgerAccount[] = [
      { id: 1, kind: "asset", openingBalanceCents: 100_000 },
      { id: 2, kind: "asset", openingBalanceCents: 0 },
      { id: 3, kind: "liability", openingBalanceCents: 50_000 },
    ];
    const result = reconstructNetWorthSeries({
      accounts,
      transactions: [
        { id: 1, dateKey: "2026-01-02", categoryId: 2, amountCents: 10_000, accountId: 1, pending: true },
        { id: 2, dateKey: "2026-01-03", amountCents: 25_000, accountId: 1, transferAccountId: 2 },
        { id: 3, dateKey: "2026-01-04", categoryId: 2, amountCents: 4_000, accountId: 1 },
      ],
      categories: CATEGORIES,
      assets: [
        ...assets,
        { id: 9, category: "Cash", currentValueCents: 999_999, createdAt: secondsFor("2026-01-01") },
      ],
      seriesBySymbol: new Map(),
      fromKey: "2026-01-01",
      toKey: "2026-01-04",
    });
    if (!result.ok) throw new Error("reconstruction failed");

    // Opening 100000 asset − 50000 liability, the derived Cash row never counted.
    expect(dayOf(result.days, "2026-01-01").netWorthCents).toBe(50_000);
    expect(dayOf(result.days, "2026-01-01").totalLiabilitiesCents).toBe(50_000);
    // A pending expense moves nothing.
    expect(dayOf(result.days, "2026-01-02").netWorthCents).toBe(50_000);
    // A transfer is net-neutral.
    expect(dayOf(result.days, "2026-01-03").netWorthCents).toBe(50_000);
    // A real expense does move it.
    expect(dayOf(result.days, "2026-01-04").netWorthCents).toBe(46_000);
    expect(result.holdings).toHaveLength(0);
  });

  it("replays the ledger forward: each day sees only transactions up to it", () => {
    const result = reconstructNetWorthSeries({
      accounts: ACCOUNTS,
      transactions: [
        { id: 1, dateKey: "2026-01-02", categoryId: 1, amountCents: 100_000, accountId: 1 },
        { id: 2, dateKey: "2026-01-04", categoryId: 2, amountCents: 30_000, accountId: 1 },
      ],
      categories: CATEGORIES,
      assets: [],
      seriesBySymbol: new Map(),
      fromKey: "2026-01-01",
      toKey: "2026-01-05",
    });
    if (!result.ok) throw new Error("reconstruction failed");
    expect(result.days.map((d) => d.netWorthCents)).toEqual([0, 100_000, 100_000, 70_000, 70_000]);
  });
});

describe("bad input", () => {
  const base = {
    accounts: ACCOUNTS,
    transactions: [] as HistoryTransaction[],
    categories: CATEGORIES,
    assets: [] as HistoryAsset[],
    seriesBySymbol: new Map<PriceSymbol, PriceSeries>(),
  };

  it("rejects a backwards or malformed range instead of returning nothing quietly", () => {
    expect(reconstructNetWorthSeries({ ...base, fromKey: "2026-01-05", toKey: "2026-01-01" })).toMatchObject({
      ok: false,
      error: { code: "bad_range" },
    });
    expect(reconstructNetWorthSeries({ ...base, fromKey: "not-a-day", toKey: "2026-01-01" })).toMatchObject({
      ok: false,
      error: { code: "bad_range" },
    });
  });
});

describe("measureContinuity", () => {
  it("only checks holdings the ledger actually dates", () => {
    expect(
      measureContinuity(
        [
          {
            assetId: 1,
            label: "Bitcoin (#1)",
            category: "Crypto",
            symbol: "BTC",
            quantity: 1,
            unit: "coins",
            storedValueCents: 100,
            acquiredOn: "2026-01-01",
            acquisitionSource: "asset_created_at",
            acquisitionEvidence: "asset_created_at",
            acquisitionTxId: null,
            acquisitionCostCents: null,
            acquisitionExplanation: "",
            valuation: "priced",
            valuationReason: "",
          },
        ],
        [],
      ),
    ).toEqual([]);
  });
});
