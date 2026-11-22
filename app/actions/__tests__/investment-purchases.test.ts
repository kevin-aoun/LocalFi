import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransaction, deleteTransaction, getTransactions, updateTransaction } from "@/app/actions/transactions";
import { getAssets, getInvestmentHistory, createAsset } from "@/app/actions/assets";
import { refreshLivePricedAssets } from "@/app/actions/crypto";
import { withDb } from "@/lib/db/client";
import { buildProjectedTransactionMovements, buildTransactionProjection, correctLedgerEventInput, postLedgerEventRaw, verifyLedger } from "@/lib/ledger";
import { getAccountBalances } from "@/app/actions/accounts";
import { createDomainDb, form, seedAccount, seedCategory, type DomainDb } from "./support/domain-fixture";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let withDbCalls = 0;
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, withDb: (fn: Parameters<typeof actual.withDb>[0]) => {
    withDbCalls += 1;
    return actual.withDb(fn);
  } };
});
let temp: DomainDb;
beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 12, name: "Investments", type: "Investment" });
  seedCategory(temp, { id: 13, name: "Food", type: "Expense" });
  seedAccount(temp, { id: 9, name: "Purchase account", kind: "asset", type: "Checking", openingBalanceCents: 200_000, openingBalanceDate: "2026-01-01" });
});
afterEach(async () => { vi.unstubAllGlobals(); await temp.cleanup(); });
const purchase = (symbol = "STOCK:AAPL", extra = {}) => form({
  accountId: "9", categoryId: "12", amount: "1000", fees: "2.50", date: "2026-06-01",
  instrumentSymbol: symbol, instrumentUnit: symbol === "BTC" ? "coins" : "shares",
  quantity: "1.250000000000000001", unitPrice: "800", pending: "false", ...extra,
});

describe("one purchase creates the cash transaction and holding", () => {
  it.each(["STOCK:AAPL", "BTC"])("records %s units × four-decimal unit price plus fees in the visible Transactions ledger", async (symbol) => {
    const fields = purchase(symbol, { quantity: "2.5", unitPrice: "12.3456", fees: "1.25", comment: "Synthetic purchase" });
    fields.delete("amount");
    const result = await createTransaction(fields);
    if ("error" in result) throw new Error(result.error);
    expect(await getTransactions()).toMatchObject([{
      id: result.data.id, categoryId: 12, accountId: 9, direction: "outflow", pending: false,
      amountCents: 3211, quantityDelta: "2.5", investmentUnitPrice: "12.3456", currentEventId: expect.any(String),
    }]);
    expect((await getAssets()).find((asset) => asset.priceSymbol === symbol)).toMatchObject({ currentValueCents: 3086, costBasisCents: 3211 });
    expect(await getInvestmentHistory()).toMatchObject([{ valueCents: 3086, costBasisCents: 3211 }]);
    expect((await getAccountBalances()).find((account) => account.id === 9)?.balanceCents).toBe(196789);
    expect(await updateTransaction(result.data.id, form({ date: "2026-06-01", comment: "Changed note" }))).toMatchObject({ success: true });
    expect((await getTransactions())[0].investmentUnitPrice).toBe("12.3456");
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it.each(["STOCK:AAPL", "BTC"])("records fractional %s quantities from .25 down to a millionth", async (symbol) => {
    const first = await createTransaction(purchase(symbol, { quantity: ".25", unitPrice: "50000", fees: "0" }));
    if ("error" in first) throw new Error(first.error);
    expect(first.data.quantityDelta).toBe("0.25");
    expect(await updateTransaction(first.data.id, purchase(symbol, { quantity: "0.000001", unitPrice: "50000", fees: "0" }))).toMatchObject({ success: true, data: { quantityDelta: "0.000001", amountCents: 5 } });
    expect((await getAssets()).find((row) => row.priceSymbol === symbol)).toMatchObject({ quantityExact: "0.000001", currentValueCents: 5 });
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("keeps sub-cent unit prices through purchase, live refresh, and Reports", async () => {
    const result = await createTransaction(purchase("STOCK:AAPL", { quantity: "10000", unitPrice: "0.0001", fees: "0" }));
    if ("error" in result) throw new Error(result.error);
    expect((await getAssets()).find((asset) => asset.priceSymbol === "STOCK:AAPL")).toMatchObject({ currentValueCents: 100, costBasisCents: 100 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ chart: { error: null, result: [{ meta: { symbol: "AAPL", currency: "USD", instrumentType: "EQUITY", regularMarketPrice: 0.0002 } }] } }) }));
    expect(await refreshLivePricedAssets()).toMatchObject({ refreshed: 1, failed: [] });
    expect((await getAssets()).find((asset) => asset.priceSymbol === "STOCK:AAPL")).toMatchObject({ currentValueCents: 200, costBasisCents: 100 });
    expect((await getInvestmentHistory()).at(-1)).toMatchObject({ valueCents: 200, costBasisCents: 100 });
    expect((await getTransactions())[0]).toMatchObject({ amountCents: 100, investmentUnitPrice: "0.0001", currentEventId: result.data.currentEventId });
  });

  it.each(["STOCK:AAPL", "BTC"])("includes fees in %s cash basis, keeps exact quantities across refresh, and follows corrections/deletion", async (symbol) => {
    const result = await createTransaction(purchase(symbol));
    if ("error" in result) throw new Error(result.error);
    expect(result.data.amountCents).toBe(100_250);
    const [holding] = (await getAssets()).filter((row) => row.category !== "Cash");
    expect(holding).toMatchObject({ quantityExact: "1.250000000000000001", costBasisCents: 100_250, currentValueCents: 100_000, profitLossCents: -250, priceSymbol: symbol });
    const event = temp.query("SELECT metadata_json FROM ledger_events ORDER BY sequence DESC LIMIT 1")[0];
    expect(JSON.parse(String(event.metadata_json))).toMatchObject({ investmentCost: { paidAmountCents: 100_000, feeAmountCents: 250 } });
    expect((await getAccountBalances()).find((account) => account.id === 9)?.balanceCents).toBe(99_750);
    expect((await getInvestmentHistory()).find((row) => row.assetId === holding.id)).toMatchObject({ dateKey: "2026-06-01", costBasisCents: 100_250 });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => symbol === "BTC"
      ? { bitcoin: { usd: 900 } }
      : { chart: { error: null, result: [{ meta: { symbol: "AAPL", currency: "USD", instrumentType: "EQUITY", regularMarketPrice: 900 } }] } } }));
    expect(await refreshLivePricedAssets()).toMatchObject({ refreshed: 1, failed: [] });
    expect((await getTransactions()).find((row) => row.id === result.data.id)).toMatchObject({ amountCents: 100_250, quantityDelta: "1.250000000000000001", currentEventId: result.data.currentEventId });
    expect((await getAssets()).find((row) => row.id === holding.id)).toMatchObject({ quantityExact: "1.250000000000000001", costBasisCents: 100_250, currentValueCents: 112_500, profitLossCents: 12_250 });
    expect(await updateTransaction(result.data.id, purchase(symbol, { amount: "500", quantity: "0.5", unitPrice: "1000" }))).toMatchObject({ success: true });
    expect((await getAssets()).find((row) => row.id === holding.id)).toMatchObject({ quantityExact: "0.5", costBasisCents: 50_250 });
    expect((await getInvestmentHistory()).find((row) => row.assetId === holding.id)).toMatchObject({ costBasisCents: 50_250 });
    expect((await verifyLedger()).failures).toEqual([]);
    expect(await deleteTransaction(result.data.id)).toMatchObject({ success: true });
    expect((await getAssets()).filter((row) => row.category !== "Cash")).toEqual([]);
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("recomputes edited purchase cash and retains its fees and fixed acquisition price", async () => {
    const result = await createTransaction(purchase("BTC", { quantity: "2", unitPrice: "50", fees: "1" }));
    if ("error" in result) throw new Error(result.error);
    expect(await updateTransaction(result.data.id, purchase("BTC", { amount: "101", quantity: "2", unitPrice: "60", fees: "1" }))).toMatchObject({ success: true });
    expect((await getTransactions())[0]).toMatchObject({ amountCents: 12100, investmentUnitPrice: "60", investmentFeeAmountCents: 100 });
    expect(await updateTransaction(result.data.id, form({ comment: "Note only" }))).toMatchObject({ success: true });
    expect((await getTransactions())[0]).toMatchObject({ date: new Date(2026, 5, 1), comment: "Note only", amountCents: 12100, investmentFeeAmountCents: 100 });
    expect(await updateTransaction(result.data.id, form({ amount: "200" }))).toHaveProperty("error");
    expect((await getTransactions())[0]).toMatchObject({ comment: "Note only", amountCents: 12100 });
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("recovers fees from cash and acquisition facts when an older correction omitted the fee split", async () => {
    const result = await createTransaction(purchase("BTC", { quantity: "2", unitPrice: "50", fees: "1" }));
    if ("error" in result) throw new Error(result.error);
    await withDb((_db, raw) => {
      const movements = buildProjectedTransactionMovements(raw, result.data);
      const event = postLedgerEventRaw(raw, correctLedgerEventInput(result.data.currentEventId!, movements, movements, {
        effectiveDate: "2026-06-01", description: "Synthetic older correction",
        metadata: { projectionKey: result.data.id, transaction: buildTransactionProjection(result.data), investmentUnitPrice: "50" },
      }));
      raw.run("UPDATE transactions SET current_event_id = ? WHERE id = ?", [event.eventId, result.data.id]);
    });
    expect((await getTransactions())[0]).toMatchObject({ amountCents: 10100, investmentFeeAmountCents: 100 });
    const edit = purchase("BTC", { quantity: "2", unitPrice: "50", comment: "Keep original cash" });
    edit.delete("fees");
    expect(await updateTransaction(result.data.id, edit)).toMatchObject({ success: true, data: { amountCents: 10100 } });
    expect((await getTransactions())[0]).toMatchObject({ investmentFeeAmountCents: 100 });
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("persists a multi-holding price refresh once and retains partial provider failures", async () => {
    await createTransaction(purchase("BTC"));
    await createTransaction(purchase("STOCK:AAPL"));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => ({
      ok: true, status: 200, json: async () => url.includes("coingecko")
        ? { bitcoin: { usd: 900 } }
        : { chart: { error: null, result: [{ meta: { symbol: "AAPL", currency: "USD", instrumentType: "EQUITY", regularMarketPrice: 900 } }] } },
    })));
    withDbCalls = 0;
    expect(await refreshLivePricedAssets()).toMatchObject({ refreshed: 2, failed: [] });
    expect(withDbCalls).toBe(1);
    expect((await getAssets()).filter((row) => row.category !== "Cash").map((row) => row.quantityExact)).toEqual(["1.250000000000000001", "1.250000000000000001"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ bitcoin: { usd: 950 } }) }));
    withDbCalls = 0;
    expect(await refreshLivePricedAssets()).toMatchObject({ refreshed: 1, failed: [{ id: expect.any(Number) }] });
    expect(withDbCalls).toBe(1);
  });

  it("accumulates later buys into one instrument and carries the cash baseline across dates", async () => {
    expect(await createTransaction(purchase())).toMatchObject({ success: true });
    expect(await createTransaction(purchase("STOCK:AAPL", { date: "2026-06-15", amount: "400", fees: "1", quantity: "0.5" }))).toMatchObject({ success: true });
    const holdings = (await getAssets()).filter((row) => row.category === "Investments");
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({ costBasisCents: 140_350, quantityExact: "1.750000000000000001" });
    expect((await getInvestmentHistory()).map((row) => [row.dateKey, row.costBasisCents])).toEqual([["2026-06-01", 100_250], ["2026-06-15", 140_350]]);
  });

  it("does not invent a cash baseline from a manual valuation", async () => {
    expect(await createAsset(form({ category: "Investments", currentValue: "1000", currency: "USD", notes: "Legacy manual holding" }))).toMatchObject({ success: true });
    expect((await getInvestmentHistory())[0].costBasisCents).toBeNull();
  });

  it.each(["STOCK:AAPL", "BTC"])("records %s purchase facts independently of provider availability", async (symbol) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createTransaction(purchase(symbol, { refreshPrice: "true" }));
    if ("error" in result) throw new Error(result.error);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.data.amountCents).toBe(100_250);
    expect(await refreshLivePricedAssets()).toMatchObject({ refreshed: 0, failed: [{ id: expect.any(Number) }] });
    expect((await getAssets()).find((row) => row.priceSymbol === symbol)).toMatchObject({ currentValueCents: 100_000, costBasisCents: 100_250, quantityExact: "1.250000000000000001" });
    expect((await getTransactions()).find((row) => row.id === result.data.id)).toMatchObject({ amountCents: 100_250, currentEventId: result.data.currentEventId });
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("refreshes CSPX through CSPX.L without creating a second instrument or changing its purchase", async () => {
    const result = await createTransaction(purchase("STOCK:CSPX"));
    if ("error" in result) throw new Error(result.error);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ chart: { error: null, result: [{ meta: { symbol: "CSPX.L", currency: "USD", instrumentType: "ETF", regularMarketPrice: 900 } }] } }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await refreshLivePricedAssets()).toMatchObject({ refreshed: 1, failed: [] });
    expect(fetchMock.mock.calls[0][0]).toContain("/chart/CSPX.L?");
    expect((await getAssets()).filter((row) => row.category === "Investments")).toMatchObject([{ priceSymbol: "STOCK:CSPX", instrumentId: result.data.instrumentId, currentValueCents: 112_500, costBasisCents: 100_250 }]);
    expect(temp.query("SELECT id FROM instruments WHERE kind = 'security'")).toHaveLength(1);
    expect((await getTransactions()).find((row) => row.id === result.data.id)).toMatchObject({ amountCents: 100_250, currentEventId: result.data.currentEventId });
  });

  it.each([{ fees: "-1" }, { fees: "bad" }, { categoryId: "13" }, { quantity: "0" }, { instrumentUnit: "coins" }])("rolls back invalid purchase fields %j", async (extra) => {
    expect(await createTransaction(purchase("STOCK:AAPL", extra))).toHaveProperty("error");
    expect(temp.query("SELECT id FROM transactions")).toEqual([]);
    expect(temp.query("SELECT id FROM instruments WHERE id LIKE 'instrument:security:%'")).toEqual([]);
  });
});
