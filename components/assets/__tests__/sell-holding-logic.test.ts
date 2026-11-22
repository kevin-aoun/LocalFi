import { describe, expect, it } from "vitest";

import {
  buildSaleRequest,
  initialSaleForm,
  pricedSaleTarget,
  saleAccounts,
  saleCategories,
  saleProceeds,
  saleTargetFor,
  type SaleTarget,
} from "../sell-holding-logic";

const categories = [
  { id: 1, name: "Food", type: "Expense" },
  { id: 2, name: "Stock", type: "Investment", investmentKind: "stock" as const },
  { id: 3, name: "Crypto", type: "Investment", investmentKind: "crypto" as const },
  { id: 4, name: "Asset sales", type: "Investment", investmentKind: null },
];
const accounts = [
  { id: 7, name: "Card", currency: "USD", kind: "liability" },
  { id: 8, name: "Old", currency: "USD", kind: "asset", archived: true },
  { id: 9, name: "Checking", currency: "USD", kind: "asset" },
  { id: 10, name: "Euro", currency: "EUR", kind: "asset" },
];
const day = new Date(2026, 10, 22);
const flat: SaleTarget = { kind: "manual", assetId: 5, label: "Demo flat", currency: "USD" };
const shares = pricedSaleTarget("STOCK:AAPL", "1.5", "USD", "AAPL")!;

describe("which holdings can be sold", () => {
  it("sells priced holdings by units and manual holdings in full", () => {
    expect(saleTargetFor({ id: 1, category: "Investments", currency: "USD", priceSymbol: "STOCK:AAPL", quantityExact: "1.5", instrumentId: "instrument:security:STOCK:AAPL" }, "AAPL"))
      .toEqual({ kind: "priced", label: "AAPL", symbol: "STOCK:AAPL", unit: "shares", quantity: "1.5", currency: "USD", investmentKind: "stock" });
    expect(saleTargetFor({ id: 5, category: "Properties", currency: "USD", quantityExact: "1", instrumentId: "instrument:manual:x" }, "Demo flat")).toEqual(flat);
  });

  it("offers nothing for cash, legacy rows without an instrument, or empty positions", () => {
    expect(saleTargetFor({ id: 1, category: "Cash", currency: "USD", quantityExact: "1", instrumentId: "x" }, "Cash")).toBeNull();
    expect(saleTargetFor({ id: 2, category: "Other", currency: "USD", quantityExact: "1", instrumentId: null }, "Legacy")).toBeNull();
    expect(saleTargetFor({ id: 3, category: "Crypto", currency: "USD", priceSymbol: "BTC", quantityExact: "0", instrumentId: "x" }, "BTC")).toBeNull();
    expect(pricedSaleTarget("NOT-A-SYMBOL", "1", "USD", "?")).toBeNull();
  });

  it("matches categories to the asset type and receives only into active asset accounts in its currency", () => {
    expect(saleCategories(categories, shares).map((category) => category.id)).toEqual([2]);
    expect(saleCategories(categories, flat).map((category) => category.id)).toEqual([4]);
    expect(saleAccounts(accounts, flat).map((account) => account.id)).toEqual([9]);
    expect(saleAccounts(accounts, { ...flat, currency: "EUR" }).map((account) => account.id)).toEqual([10]);
  });
});

describe("sale requests", () => {
  it("defaults to the whole position, the first eligible account and category", () => {
    expect(initialSaleForm(shares, categories, accounts, day)).toMatchObject({ accountId: "9", categoryId: "2", quantity: "1.5", fees: "0" });
    expect(initialSaleForm(flat, [], [], day)).toMatchObject({ accountId: "", categoryId: "", quantity: "" });
  });

  it("builds a sell trade for priced holdings with net proceeds after fees", () => {
    const form = { ...initialSaleForm(shares, categories, accounts, day), quantity: "1", unitPrice: "120.1234", fees: "0.25" };
    expect(saleProceeds(shares, form)).toBe("119.87");
    const request = buildSaleRequest(shares, form);
    expect(request.action).toBe("trade");
    expect(Object.fromEntries(request.formData)).toMatchObject({
      investmentSide: "sell", instrumentSymbol: "STOCK:AAPL", instrumentUnit: "shares", quantity: "1",
      unitPrice: "120.1234", fees: "0.25", amount: "119.87", accountId: "9", categoryId: "2", pending: "false", date: "2026-11-22T00:00:00",
    });
  });

  it("builds a full sale for manual holdings, including zero proceeds", () => {
    const request = buildSaleRequest(flat, { ...initialSaleForm(flat, categories, accounts, day), amount: "0" });
    expect(request).toMatchObject({ action: "manual", assetId: 5 });
    expect(Object.fromEntries(request.formData)).toEqual({ accountId: "9", categoryId: "4", amount: "0", date: "2026-11-22", comment: "Sold Demo flat" });
  });

  it.each([
    [flat, { accountId: "" }, /USD account/],
    [flat, { categoryId: "" }, /Investment category/],
    [flat, { amount: "" }, /sale proceeds/],
    [flat, { amount: "-1" }, /cannot be negative/],
    [shares, { unitPrice: "" }, /unit price/],
    [shares, { quantity: "0" }, /quantity/],
  ] as const)("rejects incomplete input %#", (target, patch, message) => {
    expect(() => buildSaleRequest(target, { ...initialSaleForm(target, categories, accounts, day), amount: "10", unitPrice: "5", ...patch })).toThrow(message);
  });
});
