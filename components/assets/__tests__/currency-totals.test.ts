
import { describe, expect, it } from "vitest";
import {
  allocationRows,
  barWidth,
  formatAssetTotals,
  formatCurrencyTotals,
  formatShare,
  isMixedCurrency,
  normalizeCurrency,
  shareOfCurrency,
  totalsByCurrency,
} from "../currency-totals";

const asset = (category: string, currentValueCents: number, currency = "USD") => ({
  category,
  currentValueCents,
  currency,
});

describe("totals are never summed across currencies", () => {
  it("keeps a single-currency portfolio rendering exactly as before", () => {
    const assets = [asset("Savings", 120000), asset("Crypto", 30000)];
    expect(isMixedCurrency(assets)).toBe(false);
    expect(formatAssetTotals(assets)).toBe("$1,500.00");
  });

  it("refuses to collapse USD + EUR into one number", () => {
    const assets = [asset("Savings", 120000, "USD"), asset("Savings", 30000, "EUR")];
    expect(isMixedCurrency(assets)).toBe(true);

    expect(formatAssetTotals(assets)).toBe("$1,200.00 + €300.00");
  });

  it("subtotals each currency and leads with the dominant one", () => {
    const totals = totalsByCurrency([
      asset("Savings", 1000, "EUR"),
      asset("Savings", 500000, "LBP"),
      asset("Crypto", 200000, "USD"),
      asset("Crypto", 100000, "USD"),
    ]);
    expect(totals).toEqual([
      { currency: "LBP", totalCents: 500000, count: 1 },
      { currency: "USD", totalCents: 300000, count: 2 },
      { currency: "EUR", totalCents: 1000, count: 1 },
    ]);
  });

  it("normalizes the currency code the way the column defaults do", () => {
    expect(normalizeCurrency(" usd ")).toBe("USD");
    expect(normalizeCurrency("")).toBe("USD");
    expect(normalizeCurrency(null)).toBe("USD");
    expect(normalizeCurrency("lbp")).toBe("LBP");

    expect(totalsByCurrency([asset("A", 100, ""), asset("B", 100, "USD")])).toHaveLength(1);
  });

  it("renders an empty portfolio as zero, not as an empty string", () => {
    expect(formatCurrencyTotals([])).toBe("$0.00");
  });

  it("uses the ISO code for currencies with no symbol", () => {
    expect(formatAssetTotals([asset("Savings", 123456, "LBP")])).toBe("LBP 1,234.56");
  });
});

describe("percentages are shares WITHIN a currency", () => {
  it("computes 100% for the only row in its currency", () => {
    const rows = allocationRows([asset("Savings", 120000, "USD"), asset("Crypto", 30000, "EUR")]);
    expect(rows).toEqual([
      { type: "Savings", currency: "USD", totalCents: 120000, count: 1, percentage: 100 },
      { type: "Crypto", currency: "EUR", totalCents: 30000, count: 1, percentage: 100 },
    ]);
  });

  it("does NOT dilute a EUR row by the USD total", () => {
    const rows = allocationRows([
      asset("Savings", 75000, "USD"),
      asset("Crypto", 25000, "USD"),
      asset("Properties", 10000, "EUR"),
    ]);
    const byKey = new Map(rows.map((r) => [`${r.type}/${r.currency}`, r]));
    expect(byKey.get("Savings/USD")!.percentage).toBeCloseTo(75, 10);
    expect(byKey.get("Crypto/USD")!.percentage).toBeCloseTo(25, 10);
    // THE BUG: this used to come out as 10000/110000 = 9.09%.
    expect(byKey.get("Properties/EUR")!.percentage).toBe(100);
  });

  it("groups several assets of the same category and currency", () => {
    const rows = allocationRows([
      asset("Savings", 10000, "USD"),
      asset("Savings", 30000, "USD"),
      asset("Savings", 5000, "EUR"),
    ]);
    expect(rows).toEqual([
      { type: "Savings", currency: "USD", totalCents: 40000, count: 2, percentage: 100 },
      { type: "Savings", currency: "EUR", totalCents: 5000, count: 1, percentage: 100 },
    ]);
  });

  it("returns null rather than NaN or 0% when the denominator is zero", () => {
    expect(shareOfCurrency(0, 0)).toBeNull();
    expect(formatShare(null)).toBe("—");
    expect(barWidth(null)).toBe(0);
    const rows = allocationRows([asset("Savings", 0, "USD")]);
    expect(rows[0].percentage).toBeNull();
  });

  it("clamps bar widths so a negative asset cannot render off-screen", () => {
    expect(barWidth(-50)).toBe(0);
    expect(barWidth(140)).toBe(100);
    expect(barWidth(Number.NaN)).toBe(0);
    expect(barWidth(33.5)).toBe(33.5);
  });

  it("formats a share to two decimals", () => {
    expect(formatShare(33.333333)).toBe("33.33%");
    expect(formatShare(100)).toBe("100.00%");
  });

  it("handles a negative balance in a currency without producing a bad total", () => {
    const rows = allocationRows([asset("Savings", 20000, "USD"), asset("Other", -5000, "USD")]);
    const total = 15000;
    expect(rows.map((r) => r.totalCents)).toEqual([20000, -5000]);
    expect(rows[0].percentage).toBeCloseTo((20000 / total) * 100, 10);
  });
});
