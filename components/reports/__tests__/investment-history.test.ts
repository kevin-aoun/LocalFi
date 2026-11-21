import { describe, expect, it } from "vitest";

import { buildInvestmentHistory } from "../investment-history";

describe("buildInvestmentHistory", () => {
  const rows = [
    { assetId: 2, dateKey: "2026-01-02", valueCents: 210_000, category: "Crypto", currency: "usd", label: "BTC" },
    { assetId: 1, dateKey: "2026-01-01", valueCents: 100_000, category: "Commodities", currency: "USD", label: "Gold" },
    { assetId: 1, dateKey: "2026-01-02", valueCents: 110_000, category: "Commodities", currency: "USD", label: "Gold" },
  ] as const;

  it("pivots holding rows into one chronologically sorted chart", () => {
    const model = buildInvestmentHistory(rows);
    expect(model.series.map((series) => series.label)).toEqual(["BTC", "Gold"]);
    expect(model.points.map((point) => point.dateKey)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(model.points[0]).toMatchObject({ holding_1: 1000 });
    expect(model.points[1]).toMatchObject({ holding_1: 1100, holding_2: 2100 });
    expect(model.currencies).toEqual(["USD"]);
  });

  it("filters by the reports range without inventing zeroes before acquisition", () => {
    const model = buildInvestmentHistory(rows, {
      startKey: "2026-01-02",
      endKey: "2026-01-02",
    });
    expect(model.points).toHaveLength(1);
    expect(model.points[0]).not.toHaveProperty("holding_2", 0);
    expect(model.points[0]).toMatchObject({ holding_1: 1100, holding_2: 2100 });
  });

  it("keeps duplicate display names individually addressable", () => {
    const model = buildInvestmentHistory([
      rows[0],
      { ...rows[0], assetId: 3 },
    ]);
    expect(model.series.map((series) => series.label)).toEqual(["BTC (#2)", "BTC (#3)"]);
    expect(model.series.map((series) => series.key)).toEqual(["holding_2", "holding_3"]);
  });

  it("reports invalid dates and mixed currencies", () => {
    const model = buildInvestmentHistory([
      ...rows,
      { ...rows[0], assetId: 3, dateKey: "not-a-day", currency: "EUR" },
      { ...rows[0], assetId: 4, currency: "EUR", label: "Fund" },
    ]);
    expect(model.droppedCount).toBe(1);
    expect(model.mixedCurrency).toBe(true);
    expect(model.currencies).toEqual(["EUR", "USD"]);
  });

  it("plots each ledger baseline and carries purchases from before the range without using market values as costs", () => {
    const model = buildInvestmentHistory([
      { ...rows[0], dateKey: "2026-01-01", valueCents: 100_000, costBasisCents: 100_250 },
      { ...rows[0], dateKey: "2026-02-01", valueCents: 130_000, costBasisCents: 120_500 },
      { ...rows[1], dateKey: "2026-02-10", costBasisCents: null },
    ], { startKey: "2026-01-15", endKey: "2026-02-28" });
    expect(model.points[0]).toMatchObject({ dateKey: "2026-01-15", holding_2: 1000, cost_2: 1002.5 });
    expect(model.points[0]).not.toHaveProperty("holding_1");
    expect(model.points.at(-1)).toMatchObject({ holding_2: 1300, cost_2: 1205, holding_1: 1000 });
    expect(model.points.at(-1)).not.toHaveProperty("cost_1");
    expect(model.summaries.find((item) => item.assetId === 2)).toMatchObject({ costBasisCents: 120_500, profitLossCents: 9500 });
    expect(model.summaries.find((item) => item.assetId === 1)).toMatchObject({ costBasisCents: null, profitLossCents: null });
  });

  it("keeps a zero cash baseline and excludes future purchases", () => {
    const model = buildInvestmentHistory([
      { ...rows[0], dateKey: "2026-01-01", costBasisCents: 0 },
      { ...rows[1], dateKey: "2026-03-01", costBasisCents: 1000 },
    ], { startKey: "2026-01-01", endKey: "2026-02-01" });
    expect(model.series).toHaveLength(1);
    expect(model.points.at(-1)).toMatchObject({ cost_2: 0 });
    expect(model.summaries[0].profitLossCents).toBe(210_000);
  });
});
