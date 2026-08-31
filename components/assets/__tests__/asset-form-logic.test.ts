import { describe, expect, it } from "vitest";

import { cryptoPurchaseForm, emptyAssetForm } from "../asset-form-logic";

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
