import { describe, expect, it } from "vitest";
import { parsePurchaseQuantity, parsePurchaseUnitPrice, purchaseAmountCents, quantityValueMinor, unitPriceFromAmountCents } from "@/lib/investments/cost";
import { observedHoldingValue } from "@/lib/investments/positions";

describe("exact prices per share or coin", () => {
  it("multiplies exact units by a four-decimal price and rounds the cash total once", () => {
    expect(purchaseAmountCents("2.5", "12.3456")).toBe(3_086);
    expect(purchaseAmountCents("10000", "0.0001")).toBe(100);
    expect(purchaseAmountCents("1.250000000000000001", "800")).toBe(100_000);
    expect(purchaseAmountCents("0.5", "0.01")).toBe(1);
    expect(parsePurchaseUnitPrice("12.345600")).toBe("12.3456");
  });
  it("accepts positive fractional quantities without a whole-unit minimum", () => {
    expect(parsePurchaseQuantity(".25")).toBe("0.25");
    expect(parsePurchaseQuantity(" +.250000000000000001 ")).toBe("0.250000000000000001");
    expect(parsePurchaseQuantity("1e-8")).toBe("0.00000001");
    expect(purchaseAmountCents(".25", "12.3456")).toBe(309);
    expect(purchaseAmountCents("0.000001", "50000")).toBe(5);
    for (const invalid of ["0", "-0.25", "-.25", ".", "NaN", "Infinity"]) {
      expect(() => parsePurchaseQuantity(invalid)).toThrow();
    }
  });
  it("preserves legacy cent prices and signed positions", () => {
    expect(quantityValueMinor("2.5", 1235)).toBe(3088);
    expect(quantityValueMinor("-2.5", 1235, "12.3456")).toBe(-3086);
    expect(unitPriceFromAmountCents(3086, "2.5")).toBe("12.344");
  });
  it("accepts an exact zero price as a gift", () => {
    expect(purchaseAmountCents("2.5", "0")).toBe(0);
    expect(purchaseAmountCents("2.5", "0.0000")).toBe(0);
  });
  it("rejects invalid prices, quantities, precision, sub-cent totals, and overflow", () => {
    for (const price of ["-1", "", "NaN", "12.34567"]) expect(() => purchaseAmountCents("2.5", price)).toThrow();
    for (const quantity of ["0", "-1", "", "abc"]) expect(() => purchaseAmountCents(quantity, "12.3456")).toThrow();
    expect(() => purchaseAmountCents("0.1", "0.0001")).toThrow();
    expect(() => purchaseAmountCents("100000000000000", "10000.0001")).toThrow();
  });
});

describe("observed holding value", () => {
  it("values price observations by units and manual valuations as a whole", () => {
    expect(observedHoldingValue("2.5", { observationKind: "price", amountMinor: 1235, unitPrice: "12.3456" })).toBe(3086);
    expect(observedHoldingValue("1", { observationKind: "valuation", amountMinor: 25_000_000 })).toBe(25_000_000);
    expect(observedHoldingValue("1", null)).toBe(0);
  });
  it("is zero once every unit is sold, whatever the last manual valuation", () => {
    expect(observedHoldingValue("0", { observationKind: "valuation", amountMinor: 25_000_000 })).toBe(0);
    expect(observedHoldingValue("0.000", { observationKind: "price", amountMinor: 1235 })).toBe(0);
  });
});
