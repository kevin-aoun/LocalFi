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
});
