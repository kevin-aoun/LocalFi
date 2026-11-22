import { describe, expect, it, vi } from "vitest";
import { describePriceError, describePriceSource, fetchPriceQuote, fetchPriceQuotes, holdingValueCents, parseStockPrice, pricedHolding, stockPriceSymbol } from "@/lib/prices";

const payload = (meta = {}) => ({ chart: { error: null, result: [{ meta: {
  symbol: "AAPL", currency: "USD", instrumentType: "EQUITY", regularMarketPrice: 200,
  regularMarketTime: 1_800_000_000, ...meta,
} }] } });

describe("stock quotes share the holding price interface", () => {
  it("normalizes tickers without confusing them with coins or allowing URLs", () => {
    expect(stockPriceSymbol(" aapl ")).toBe("STOCK:AAPL");
    expect(stockPriceSymbol("BRK-B")).toBe("STOCK:BRK-B");
    for (const ticker of ["", "../AAPL", "AAPL?foo=bar", "https://example.com", "a".repeat(21)]) expect(stockPriceSymbol(ticker)).toBeNull();
    expect(pricedHolding("STOCK:AAPL")).toMatchObject({ assetCategory: "Investments", defaultUnit: "shares", provider: "yahoo" });
    expect(describePriceSource("STOCK:AAPL")).toMatchObject({ kind: "direct", badge: "Yahoo Finance" });
  });

  it("accepts USD stocks and ETFs and rejects wrong symbols, currencies, types and unusable prices", () => {
    expect(parseStockPrice(payload(), "AAPL")).toEqual({ ok: true, pricePerUnitUsd: 200 });
    expect(parseStockPrice(payload({ instrumentType: "ETF" }), "AAPL").ok).toBe(true);
    for (const meta of [{ currency: "EUR" }, { symbol: "MSFT" }, { instrumentType: "CRYPTOCURRENCY" }, { regularMarketPrice: 0 }, { regularMarketPrice: -1 }, { regularMarketPrice: "200" }]) {
      expect(parseStockPrice(payload(meta), "AAPL").ok).toBe(false);
    }
    for (const malformed of [null, {}, { chart: { result: null } }, { chart: { result: [], error: {} } }]) expect(parseStockPrice(malformed, "AAPL").ok).toBe(false);
  });

  it("fetches each stock once, caches it, and values fractional shares through the common interface", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload() });
    const batch = await fetchPriceQuotes(["STOCK:AAPL", "stock:aapl"], { fetchImpl, now: () => 1_800_000_100_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", next: { revalidate: 60 } });
    const quote = batch.quotes.get("STOCK:AAPL")!;
    expect(quote).toMatchObject({ provider: "yahoo", priceUnit: "share", quotedAt: 1_800_000_000_000 });
    expect(holdingValueCents(quote, 0.125, "shares")).toMatchObject({ ok: true, valueCents: 2500 });
  });

  it("isolates stock failures from successful crypto quotes", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.includes("yahoo")
      ? { ok: false, status: 429, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ bitcoin: { usd: 50_000 } }) });
    const result = await fetchPriceQuotes(["STOCK:AAPL", "BTC"], { fetchImpl });
    expect(result.quotes.get("BTC")?.pricePerUnitUsd).toBe(50_000);
    expect(result.errors.get("STOCK:AAPL")).toMatchObject({ code: "rate_limited", provider: "yahoo" });
    const offline = await fetchPriceQuote("STOCK:AAPL", { fetchImpl: async () => { throw new Error("offline"); } });
    expect(offline).toMatchObject({ ok: false, error: { code: "network_error" } });
  });

  it.each(["STOCK:CSPX", "STOCK:CSPX.L"])("quotes %s through its USD London listing without changing the holding identity", async (symbol) => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload({ symbol: "CSPX.L", instrumentType: "ETF", regularMarketPrice: 800 }) });
    const result = await fetchPriceQuote(symbol, { fetchImpl });
    expect(result).toMatchObject({ ok: true, quote: { symbol, pricePerUnitUsd: 800, provider: "yahoo" } });
    expect(fetchImpl.mock.calls[0][0]).toContain("/chart/CSPX.L?");
  });

  it("explains how to correct another missing exchange-qualified ticker", async () => {
    const result = await fetchPriceQuote("STOCK:MISSING", { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    if (result.ok) throw new Error("Expected a missing ticker");
    expect(describePriceError(result.error)).toMatch(/exchange suffix.*CSPX.L/);
  });
});
