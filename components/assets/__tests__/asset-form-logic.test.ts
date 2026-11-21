import { describe, expect, it } from "vitest";

import { commodityQuantityFields, cryptoPurchaseForm, emptyAssetForm, formFromAsset, livePricingFor, purchaseCategoryIdFor, purchaseTotalFor } from "../asset-form-logic";

describe("cryptoPurchaseForm", () => {
  it("opens the same asset form directly in its ledger-backed crypto mode", () => {
    expect(cryptoPurchaseForm()).toMatchObject({
      category: "Crypto",
      currency: "USD",
      useLivePrice: true,
      cryptoSymbol: "BTC",
    });
    expect(cryptoPurchaseForm()).not.toBe(emptyAssetForm());
  });
});

describe("automatic purchase categories", () => {
  const categories = [
    { id: 1, name: "Crypto", type: "Expense" },
    { id: 2, name: "Crypto", type: "Investment" },
    { id: 3, name: "Investments", type: "Investment" },
    { id: 4, name: "Retirement", type: "Investment" },
  ];

  it("uses the asset category when a matching investment category exists", () => {
    expect(purchaseCategoryIdFor(categories, "Crypto")).toBe(2);
    expect(purchaseCategoryIdFor(categories, "Investments")).toBe(3);
    expect(purchaseCategoryIdFor([{ id: 5, name: " cRyPtO ", type: "Investment" }], "Crypto")).toBe(5);
  });

  it("keeps the category already chosen when entering from Transactions", () => {
    expect(purchaseCategoryIdFor(categories, "Crypto", 4)).toBe(4);
    expect(purchaseCategoryIdFor(categories, "Crypto", 1)).toBe(2);
    expect(purchaseCategoryIdFor(categories, "Crypto", 99)).toBe(2);
  });

  it("falls back to a general investment category, then the first investment category", () => {
    expect(purchaseCategoryIdFor(categories.filter((category) => category.id !== 2), "Crypto")).toBe(3);
    expect(purchaseCategoryIdFor(categories.filter((category) => category.id === 4), "Crypto")).toBe(4);
    expect(purchaseCategoryIdFor(categories.filter((category) => category.type === "Expense"), "Crypto")).toBeNull();
    expect(purchaseCategoryIdFor([], "Investments")).toBeNull();
  });
});

describe("shared stock purchase fields", () => {
  it("previews shares or coins times the unit price plus fees", () => {
    for (const category of ["Investments", "Crypto"]) {
      expect(purchaseTotalFor({ ...emptyAssetForm(), category, quantityCoins: "2.5", unitPrice: "12.3456", fees: "1.25" })).toBe(3211);
    }
    expect(purchaseTotalFor(emptyAssetForm())).toBeNull();
    expect(purchaseTotalFor({ ...emptyAssetForm(), quantityCoins: "2.5", unitPrice: "12.3456", fees: "-1" })).toBeNull();
  });
  it("uses shares and a structured ticker and keeps the value read-only while the ticker is blank", () => {
    const form = { ...emptyAssetForm(), category: "Investments", useLivePrice: true, ticker: " aapl ", quantityCoins: "0.125" };
    expect(livePricingFor(form)).toMatchObject({ isInvestment: true, isStock: true, liveSymbol: "STOCK:AAPL", liveUnit: "shares", liveQuantityText: "0.125", usesLivePricing: true });
    expect(livePricingFor({ ...form, ticker: "" })).toMatchObject({ liveSymbol: null, usesLivePricing: true });
  });
  it("always tracks stocks and crypto without requiring the Live Price toggle", () => {
    expect(livePricingFor({ ...emptyAssetForm(), category: "Investments", ticker: "CSPX", useLivePrice: false })).toMatchObject({ usesLivePricing: true, liveSymbol: "STOCK:CSPX", liveUnit: "shares" });
    expect(livePricingFor({ ...emptyAssetForm(), category: "Crypto", useLivePrice: false })).toMatchObject({ usesLivePricing: true, liveSymbol: "BTC", liveUnit: "coins" });
    expect(livePricingFor({ ...emptyAssetForm(), category: "Commodities", useLivePrice: false })).toMatchObject({ usesLivePricing: false });
  });
  it("hydrates exact quantities without converting them through a float", () => {
    const form = formFromAsset({ category: "Investments", currency: "USD", priceSymbol: "STOCK:AAPL", currentValueCents: 100_000, quantity: 1.25, quantityExact: "1.250000000000000001", costBasisCents: 100_250, useLivePrice: true }, (cents) => cents / 100);
    expect(form).toMatchObject({ ticker: "AAPL", quantityCoins: "1.250000000000000001", unitPrice: "802" });
  });
});


describe("fractional commodity quantities", () => {
  it("keeps small entered weights and their conversions above zero", () => {
    const grams = commodityQuantityFields("0.000001", "grams");
    expect(grams.quantityGrams).toBe("0.000001");
    expect(Number(grams.quantityOz)).toBeGreaterThan(0);
    const ounces = commodityQuantityFields("0.000001", "oz");
    expect(ounces.quantityOz).toBe("0.000001");
    expect(Number(ounces.quantityGrams)).toBeGreaterThan(0);
    expect(commodityQuantityFields(grams.quantityOz, "oz").quantityGrams).toBe("0.000001");
  });

  it("preserves zero, clears empty conversions, and never displays NaN", () => {
    expect(commodityQuantityFields("0", "oz")).toEqual({ quantityOz: "0", quantityGrams: "0" });
    expect(commodityQuantityFields("", "grams")).toEqual({ quantityOz: "", quantityGrams: "" });
    expect(commodityQuantityFields("bad", "grams")).toEqual({ quantityOz: "", quantityGrams: "bad" });
  });

  it("retains small gram holdings when reopening their form", () => {
    const hydrated = formFromAsset({ category: "Commodities", commodityType: "Gold", unit: "grams", quantity: 0.000001, currentValueCents: 1, currency: "USD" }, (cents) => cents / 100);
    expect(hydrated.quantityGrams).toBe("0.000001");
    expect(Number(hydrated.quantityOz)).toBeGreaterThan(0);
  });
});
