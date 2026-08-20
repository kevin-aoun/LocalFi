
import { describe, expect, it, vi } from "vitest";

import {
  COINGECKO_URL,
  DEFAULT_REVALIDATE_SECONDS,
  DEFAULT_TIMEOUT_MS,
  GRAMS_PER_TROY_OUNCE,
  PRICED_HOLDINGS,
  PRICE_PROVIDERS,
  PRICE_PROXIES,
  PRICE_SYMBOLS,
  canBePriced,
  cryptoPriceSymbols,
  describePriceError,
  describePriceSource,
  fetchHoldingValueCents,
  fetchPriceQuote,
  fetchPriceQuotes,
  holdingValueCents,
  holdingValueFromQuotes,
  isPriceSymbol,
  parseCoinGeckoPrice,
  priceRequestInit,
  priceSourceLabel,
  priceSymbolForCommodityType,
  priceableSymbols,
  quantityInPriceUnits,
  unpriceableSymbols,
  type PriceFetchLike,
  type PriceQuote,
  type PriceSymbol,
} from "@/lib/prices";

const COINGECKO_OK = {
  "pax-gold": { usd: 4257.87 },
  "kinesis-silver": { usd: 60.5 },
  bitcoin: { usd: 118_432 },
  ethereum: { usd: 3781.22 },
};

type StubResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  json: () => Promise<unknown>;
};

function stubFetch(response: StubResponse | ((url: string) => StubResponse | Promise<never>)): {
  fetchImpl: PriceFetchLike;
  calls: string[];
  inits: unknown[];
} {
  const calls: string[] = [];
  const inits: unknown[] = [];
  const fetchImpl = (async (url: string, init?: unknown) => {
    calls.push(url);
    inits.push(init);
    return typeof response === "function" ? response(url) : response;
  }) as unknown as PriceFetchLike;
  return { fetchImpl, calls, inits };
}

const ok = (payload: unknown): StubResponse => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => payload,
});

const quoteFor = (symbol: "XAU" | "XAG" | "BTC", price: number): PriceQuote => ({
  symbol,
  label: PRICED_HOLDINGS[symbol].label,
  provider: "coingecko",
  priceUnit: PRICED_HOLDINGS[symbol].priceUnit,
  proxy: PRICED_HOLDINGS[symbol].proxy,
  sourceLabel: priceSourceLabel(symbol),
  pricePerUnitUsd: price,
  fetchedAt: 1_785_000_000_000,
});

describe("there is exactly one provider", () => {
  it("lists CoinGecko and nothing else", () => {
    expect([...PRICE_PROVIDERS]).toEqual(["coingecko"]);
  });

  it("routes every priceable symbol through CoinGecko", () => {
    for (const symbol of priceableSymbols) {
      expect(PRICED_HOLDINGS[symbol].provider).toBe("coingecko");
      expect(PRICED_HOLDINGS[symbol].coinGeckoId).toBeTruthy();
    }
  });

  it("hits one host, with no API key and no second feed", () => {
    expect(COINGECKO_URL.startsWith("https://api.coingecko.com/api/v3/simple/price?")).toBe(true);
    expect(COINGECKO_URL).not.toMatch(/swissquote|forex-data-feed/i);
    expect(COINGECKO_URL).not.toMatch(/key|token|secret|auth/i);
  });

  it("keeps no SwissQuote spread-profile machinery: nothing selects a spread", async () => {
    const priceModule: Record<string, unknown> = await import("@/lib/prices");
    for (const name of Object.keys(priceModule)) {
      expect(name).not.toMatch(/swissquote|spreadprofile/i);
    }

    expect(priceModule.SPREAD_PROFILES).toBeUndefined();
    expect(priceModule.parseSwissQuotePrice).toBeUndefined();
    expect(priceModule.SWISSQUOTE_BASE_URL).toBeUndefined();
  });
});

describe("what one unit of each price actually is", () => {
  it("prices gold and silver through proxy TOKENS, per troy ounce", () => {
    expect(PRICED_HOLDINGS.XAU.coinGeckoId).toBe("pax-gold");
    expect(PRICED_HOLDINGS.XAG.coinGeckoId).toBe("kinesis-silver");
    for (const symbol of ["XAU", "XAG"] as const) {
      expect(PRICED_HOLDINGS[symbol].priceUnit).toBe("oz");
      expect(PRICED_HOLDINGS[symbol].assetCategory).toBe("Commodities");
      const proxy = PRICED_HOLDINGS[symbol].proxy;
      expect(proxy).not.toBeNull();

      expect(proxy!.unitClaim).toMatch(/troy ounce/);
      expect(proxy!.unitEvidence.length).toBeGreaterThan(40);
      expect(proxy!.tracking).toMatch(/2026-08-06/);
    }
  });

  it("shares the gold proxy id with the historical series — one mapping, not two", async () => {
    const { HISTORICAL_PRICE_SOURCES } = await import("@/lib/history/prices");
    expect(HISTORICAL_PRICE_SOURCES.XAU!.coinGeckoId).toBe(PRICE_PROXIES.XAU.coinGeckoId);
    expect(PRICED_HOLDINGS.XAU.coinGeckoId).toBe(PRICE_PROXIES.XAU.coinGeckoId);
  });

  it("puts Bitcoin and Ethereum on CoinGecko directly, priced per coin, no proxy", () => {
    for (const symbol of ["BTC", "ETH"] as const) {
      expect(PRICED_HOLDINGS[symbol].priceUnit).toBe("coin");
      expect(PRICED_HOLDINGS[symbol].assetCategory).toBe("Crypto");
      expect(PRICED_HOLDINGS[symbol].proxy).toBeNull();

      expect(PRICED_HOLDINGS[symbol].commodityType).toBeNull();
    }
    expect(cryptoPriceSymbols).toEqual(["BTC", "ETH"]);
  });

  it("refuses to price platinum or palladium at all, and says why", () => {
    expect([...unpriceableSymbols]).toEqual(["XPT", "XPD"]);
    for (const symbol of ["XPT", "XPD"] as const) {
      expect(PRICED_HOLDINGS[symbol].coinGeckoId).toBeNull();
      expect(PRICED_HOLDINGS[symbol].provider).toBeNull();
      expect(PRICED_HOLDINGS[symbol].proxy).toBeNull();
      expect(canBePriced(symbol)).toBe(false);

      expect(PRICED_HOLDINGS[symbol].noSourceReason).toMatch(/ETF SHARE|share/i);
    }
    expect([...priceableSymbols]).toEqual(["XAU", "XAG", "BTC", "ETH"]);
  });

  it("keeps XPT and XPD as valid stored symbols, so no migration is needed", () => {

    expect(PRICE_SYMBOLS).toEqual(["XAU", "XAG", "XPT", "XPD", "BTC", "ETH"]);
    expect(isPriceSymbol("XPT")).toBe(true);
    expect(priceSymbolForCommodityType("Platinum")).toBe("XPT");
  });

  it("recognises its own symbols and nothing else", () => {
    expect(isPriceSymbol("BTC")).toBe(true);
    expect(isPriceSymbol("DOGE")).toBe(false);
    expect(isPriceSymbol(null)).toBe(false);
    expect(canBePriced("DOGE")).toBe(false);
    expect(canBePriced("btc")).toBe(true);
  });

  it("maps the legacy commodity_type values onto symbols", () => {
    expect(priceSymbolForCommodityType("Gold")).toBe("XAU");
    expect(priceSymbolForCommodityType("Silver")).toBe("XAG");
    expect(priceSymbolForCommodityType("Platinum")).toBe("XPT");
    expect(priceSymbolForCommodityType("Palladium")).toBe("XPD");
    expect(priceSymbolForCommodityType("Bitcoin")).toBeNull();
    expect(priceSymbolForCommodityType(null)).toBeNull();
  });
});

describe("the registry and the database schema agree", () => {
  it("declares the same price symbols and units as lib/db/schema/assets.ts", async () => {

    const { priceSymbols, quantityUnits, commodityTypes } = await import("@/lib/db/schema/assets");
    expect([...priceSymbols]).toEqual([...PRICE_SYMBOLS]);

    expect([...quantityUnits]).toEqual(["oz", "grams", "coins"]);

    expect([...commodityTypes]).toEqual(["Gold", "Silver", "Platinum", "Palladium"]);
    for (const symbol of cryptoPriceSymbols) {
      expect(commodityTypes).not.toContain(PRICED_HOLDINGS[symbol].label);
    }
  });
});

describe("disclosure: a proxy price never travels alone", () => {
  it("describes gold and silver as proxies, naming the token and the tracking error", () => {
    const gold = describePriceSource("XAU");
    expect(gold.kind).toBe("proxy");
    expect(gold.badge).toBe("PAXG proxy");
    expect(gold.detail).toMatch(/PAX Gold/);
    expect(gold.detail).toMatch(/troy ounce/);
    expect(gold.detail).toMatch(/0\.25%/);
    expect(gold.detail).toMatch(/not a gold quote/i);

    const silver = describePriceSource("XAG");
    expect(silver.kind).toBe("proxy");
    expect(silver.badge).toBe("KAG proxy");
    expect(silver.detail).toMatch(/Kinesis Silver/);

    expect(silver.detail).toMatch(/2\.19%/);
  });

  it("describes BTC/ETH as direct, with nothing to qualify", () => {
    for (const symbol of ["BTC", "ETH"] as const) {
      expect(describePriceSource(symbol).kind).toBe("direct");
      expect(priceSourceLabel(symbol)).toBe("CoinGecko");
    }
  });

  it("describes platinum and palladium as having no source", () => {
    for (const symbol of ["XPT", "XPD"] as const) {
      const source = describePriceSource(symbol);
      expect(source.kind).toBe("none");
      expect(source.badge).toBe("No price source");
      expect(source.detail).toMatch(/cannot be priced live/);
    }
    expect(describePriceSource("DOGE").kind).toBe("none");
  });

  it("labels a proxy price wherever it is printed", () => {
    expect(priceSourceLabel("XAU")).toBe("CoinGecko · PAXG proxy");
    expect(priceSourceLabel("XAG")).toBe("CoinGecko · KAG proxy");
  });

  it("carries the disclosure ON the quote, so no view can render the price bare", async () => {
    const { fetchImpl } = stubFetch(ok(COINGECKO_OK));
    const gold = await fetchPriceQuote("XAU", { fetchImpl, now: () => 1 });
    if (!gold.ok) throw new Error("expected a quote");

    expect(gold.quote.proxy).not.toBeNull();
    expect(gold.quote.proxy!.tokenName).toBe("PAX Gold (PAXG)");
    expect(gold.quote.sourceLabel).toBe("CoinGecko · PAXG proxy");
    expect(gold.quote.pricePerUnitUsd).toBe(4257.87);
    expect(gold.quote.priceUnit).toBe("oz");

    const btc = await fetchPriceQuote("BTC", { fetchImpl, now: () => 1 });
    if (!btc.ok) throw new Error("expected a quote");
    expect(btc.quote.proxy).toBeNull();
    expect(btc.quote.sourceLabel).toBe("CoinGecko");
  });
});

describe("parsing a CoinGecko payload", () => {
  it("reads the USD price for the requested id", () => {
    expect(parseCoinGeckoPrice(COINGECKO_OK, "bitcoin")).toEqual({
      ok: true,
      pricePerUnitUsd: 118_432,
    });
    expect(parseCoinGeckoPrice(COINGECKO_OK, "pax-gold")).toEqual({
      ok: true,
      pricePerUnitUsd: 4257.87,
    });
  });

  it("treats an empty payload as malformed, NOT as a price of 0", () => {
    for (const payload of [{}, { bitcoin: {} }, { bitcoin: { eur: 1 } }, null, [], "nope"]) {
      const result = parseCoinGeckoPrice(payload, "bitcoin");
      expect(result).toMatchObject({ ok: false, code: "malformed_response" });
      expect(result).not.toHaveProperty("pricePerUnitUsd");
    }
  });

  it("rejects a price that is not a finite positive number", () => {
    for (const usd of [0, -1, "118432", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseCoinGeckoPrice({ bitcoin: { usd } }, "bitcoin")).toMatchObject({
        ok: false,
        code: "malformed_response",
      });
    }
  });
});

describe("batching: N symbols cost ONE request", () => {
  it("puts every priceable id in a single query string", () => {
    expect(COINGECKO_URL).toBe(
      "https://api.coingecko.com/api/v3/simple/price" +
        "?ids=pax-gold,kinesis-silver,bitcoin,ethereum&vs_currencies=usd",
    );
  });

  it("fetches four symbols with one call", async () => {
    const { fetchImpl, calls } = stubFetch(ok(COINGECKO_OK));
    const { quotes, errors } = await fetchPriceQuotes(["XAU", "XAG", "BTC", "ETH"], {
      fetchImpl,
      now: () => 7,
    });

    expect(calls).toHaveLength(1);
    expect(errors.size).toBe(0);
    expect([...quotes.keys()]).toEqual(["XAU", "XAG", "BTC", "ETH"]);
    expect(quotes.get("XAU")!.pricePerUnitUsd).toBe(4257.87);
    expect(quotes.get("XAG")!.pricePerUnitUsd).toBe(60.5);
    expect(quotes.get("BTC")!.pricePerUnitUsd).toBe(118_432);

    expect([...quotes.values()].every((q) => q.fetchedAt === 7)).toBe(true);
  });

  it("asks for the same URL whichever single symbol is wanted, so the cache is shared", async () => {
    const { fetchImpl, calls } = stubFetch(ok(COINGECKO_OK));
    await fetchPriceQuote("XAU", { fetchImpl });
    await fetchPriceQuote("ETH", { fetchImpl });
    expect(calls[0]).toBe(calls[1]);
    expect(calls[0]).toBe(COINGECKO_URL);
  });

  it("spends NO request at all on symbols with no source", async () => {
    const { fetchImpl, calls } = stubFetch(ok(COINGECKO_OK));
    const { quotes, errors } = await fetchPriceQuotes(["XPT", "XPD"], { fetchImpl });
    expect(calls).toEqual([]);
    expect(quotes.size).toBe(0);
    expect(errors.get("XPT")).toMatchObject({ code: "no_price_source", symbol: "XPT" });
    expect(errors.get("XPD")).toMatchObject({ code: "no_price_source" });
  });

  it("prices what it can and reports what it cannot, in the same single call", async () => {
    const { fetchImpl, calls } = stubFetch(ok(COINGECKO_OK));
    const { quotes, errors } = await fetchPriceQuotes(["XAU", "XPT", "BTC", "DOGE"], { fetchImpl });

    expect(calls).toHaveLength(1);
    expect([...quotes.keys()]).toEqual(["XAU", "BTC"]);
    expect(errors.get("XPT")!.code).toBe("no_price_source");
    expect(errors.get("DOGE")!.code).toBe("unknown_symbol");
  });

  it("does not ask twice for a symbol listed twice", async () => {
    const { fetchImpl, calls } = stubFetch(ok(COINGECKO_OK));
    const { quotes } = await fetchPriceQuotes(["BTC", "BTC", "btc"], { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(quotes.size).toBe(1);
  });
});

describe("privacy: the request carries nothing but coin ids", () => {
  it("sends no ledger data, no identifier and no credentials", async () => {
    const { fetchImpl, calls, inits } = stubFetch(ok(COINGECKO_OK));
    await fetchHoldingValueCents("BTC", 12.3456789, "coins", { fetchImpl });

    const url = calls[0];

    expect(url).toBe(COINGECKO_URL);
    expect(url).not.toMatch(/12\.34|quantity|value|asset|user|id=\d/);
    expect(url.split("?")[1]).toBe("ids=pax-gold,kinesis-silver,bitcoin,ethereum&vs_currencies=usd");

    const init = inits[0] as Record<string, unknown>;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");

    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(["accept"]);
    for (const key of Object.keys(headers)) {
      expect(key.toLowerCase()).not.toMatch(/user-agent|cookie|authorization|x-/);
    }
    expect(JSON.stringify(headers)).not.toMatch(/localfi|owner-name|host-name/i);
  });

  it("builds the same init regardless of who is asking", () => {
    const init = priceRequestInit(DEFAULT_REVALIDATE_SECONDS, DEFAULT_TIMEOUT_MS);
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      next: { revalidate: 60 },
    });
    expect(init.body).toBeUndefined();
  });
});

describe("fetchPriceQuote", () => {
  it("quotes a coin from the keyless endpoint", async () => {
    const { fetchImpl } = stubFetch(ok(COINGECKO_OK));
    const result = await fetchPriceQuote("BTC", { fetchImpl, now: () => 111 });

    expect(result).toEqual({
      ok: true,
      quote: {
        symbol: "BTC",
        label: "Bitcoin",
        provider: "coingecko",
        priceUnit: "coin",
        proxy: null,
        sourceLabel: "CoinGecko",
        pricePerUnitUsd: 118_432,
        fetchedAt: 111,
      },
    });
  });

  it("caches for 60 seconds, like the metals path always did", async () => {
    const { fetchImpl, inits } = stubFetch(ok(COINGECKO_OK));
    await fetchPriceQuote("ETH", { fetchImpl });
    expect(DEFAULT_REVALIDATE_SECONDS).toBe(60);
    expect(inits[0]).toMatchObject({ next: { revalidate: 60 } });
  });

  it("returns a typed error for an unknown symbol without fetching anything", async () => {
    const { fetchImpl, calls } = stubFetch(ok(COINGECKO_OK));
    const result = await fetchPriceQuote("DOGE", { fetchImpl });

    expect(result).toMatchObject({ ok: false, error: { code: "unknown_symbol", symbol: "DOGE" } });
    expect(calls).toEqual([]);
  });

  it("returns no_price_source — not a price, not a 0 — for platinum", async () => {
    const { fetchImpl, calls } = stubFetch(ok(COINGECKO_OK));
    const result = await fetchPriceQuote("XPT", { fetchImpl });

    expect(result).toMatchObject({ ok: false, error: { code: "no_price_source", symbol: "XPT" } });
    expect(result).not.toHaveProperty("quote");
    expect(calls).toEqual([]);
  });

  it("turns an HTTP error into a typed error, not a price", async () => {
    const { fetchImpl } = stubFetch({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({}),
    });
    const result = await fetchPriceQuote("BTC", { fetchImpl });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "http_error", status: 503, provider: "coingecko", symbol: "BTC" },
    });
    expect(result).not.toHaveProperty("quote");
  });

  it("turns a malformed body into a typed error", async () => {
    const { fetchImpl } = stubFetch({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    });
    expect(await fetchPriceQuote("BTC", { fetchImpl })).toMatchObject({
      ok: false,
      error: { code: "malformed_response" },
    });
  });

  it("survives being offline: a socket error is a typed error, nothing else", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as PriceFetchLike;

    const result = await fetchPriceQuote("BTC", { fetchImpl });
    expect(result).toMatchObject({ ok: false, error: { code: "network_error", symbol: "BTC" } });
    if (result.ok) throw new Error("expected a failure");
    expect(describePriceError(result.error)).toMatch(/offline|unreachable/i);
  });

  it("never throws — every provider failure comes back as a value", async () => {
    const fetchImpl = (() => {
      throw new Error("synchronous explosion");
    }) as unknown as PriceFetchLike;
    await expect(fetchPriceQuote("ETH", { fetchImpl })).resolves.toMatchObject({ ok: false });
  });

  it("uses the ambient fetch only when no fetchImpl is injected", async () => {
    const spy = vi.fn(async () => ok(COINGECKO_OK) as unknown as Response);
    vi.stubGlobal("fetch", spy);
    try {
      const result = await fetchHoldingValueCents("BTC", 1, "coins");
      expect(result).toMatchObject({ ok: true, valueCents: 11_843_200 });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a rate limit is not an outage", () => {
  it("gives 429 its own error code", async () => {
    const { fetchImpl } = stubFetch({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({}),
    });
    const result = await fetchPriceQuote("XAU", { fetchImpl });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "rate_limited", status: 429, provider: "coingecko", symbol: "XAU" },
    });

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).not.toBe("http_error");
    expect(result.error.code).not.toBe("network_error");
  });

  it("tells a throttled user to wait, and does NOT tell them they are offline", () => {
    const throttled = describePriceError({
      code: "rate_limited",
      symbol: "XAU",
      provider: "coingecko",
      status: 429,
      message: "429 Too Many Requests",
    });
    expect(throttled).toMatch(/rate-limit/i);
    expect(throttled).toMatch(/wait about a minute/i);
    expect(throttled).toMatch(/NOT offline/);
    expect(throttled).toMatch(/nothing was saved/i);

    const offline = describePriceError({
      code: "network_error",
      symbol: "XAU",
      provider: "coingecko",
      message: "fetch failed",
    });
    expect(offline).toMatch(/offline/);
    expect(offline).not.toMatch(/wait about a minute/i);

    expect(throttled).not.toBe(offline);
  });

  it("marks every symbol in a rate-limited batch, not just the first", async () => {
    const { fetchImpl } = stubFetch({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({}),
    });
    const { quotes, errors } = await fetchPriceQuotes(["XAU", "BTC", "ETH"], { fetchImpl });
    expect(quotes.size).toBe(0);
    for (const symbol of ["XAU", "BTC", "ETH"] as PriceSymbol[]) {
      expect(errors.get(symbol)).toMatchObject({ code: "rate_limited", status: 429 });
    }
  });
});

describe("describePriceError", () => {
  it("names the holding and the provider, and says nothing was saved", () => {
    const message = describePriceError({
      code: "http_error",
      symbol: "BTC",
      provider: "coingecko",
      status: 503,
      message: "503 Service Unavailable",
    });
    expect(message).toMatch(/Bitcoin/);
    expect(message).toMatch(/CoinGecko/);
    expect(message).toMatch(/nothing was saved/i);
    expect(message).not.toMatch(/\$0/);
  });

  it("tells a platinum holder their stored value was kept", () => {
    const message = describePriceError({
      code: "no_price_source",
      symbol: "XPT",
      provider: null,
      message: "no source",
    });
    expect(message).toMatch(/Platinum/);
    expect(message).toMatch(/no live price source/);
    expect(message).toMatch(/stored value has been kept/i);
    expect(message).not.toMatch(/\$0/);
  });
});

describe("quantity x price -> integer cents, rounded exactly once", () => {
  it("prices a fractional bitcoin holding", () => {

    const result = holdingValueCents(quoteFor("BTC", 118_432), 0.0345, "coins");
    expect(result).toEqual({ ok: true, valueCents: 408_590 });
  });

  it("rounds half away from zero at the cent, not per-operation", () => {

    expect(holdingValueCents(quoteFor("BTC", 3781.22), 0.0345, "coins")).toEqual({
      ok: true,
      valueCents: 13_045,
    });

    expect(holdingValueCents(quoteFor("BTC", 100.05), 0.1, "coins")).toEqual({
      ok: true,
      valueCents: 1001,
    });
  });

  it("prices the live database's gold holding the way it always did", () => {

    expect(holdingValueCents(quoteFor("XAU", 3315.58), 1.1376, "oz")).toEqual({
      ok: true,
      valueCents: 377_180,
    });
  });

  it("prices a silver holding per troy ounce", () => {

    expect(holdingValueCents(quoteFor("XAG", 60.5), 10, "oz")).toEqual({
      ok: true,
      valueCents: 60_500,
    });
  });

  it("converts grams with the same divisor it always used", () => {
    expect(GRAMS_PER_TROY_OUNCE).toBe(31.1034768);
    const grams = holdingValueCents(quoteFor("XAU", 3315.58), 31.1035, "grams");
    const ounces = holdingValueCents(
      quoteFor("XAU", 3315.58),
      31.1035 / GRAMS_PER_TROY_OUNCE,
      "oz",
    );
    expect(grams).toEqual(ounces);
  });

  it("treats a quantity of 0 as a quantity, giving $0.00 — not an error", () => {
    expect(holdingValueCents(quoteFor("BTC", 118_432), 0, "coins")).toEqual({
      ok: true,
      valueCents: 0,
    });
    expect(quantityInPriceUnits(0, "coins", PRICED_HOLDINGS.BTC)).toEqual({
      ok: true,
      quantity: 0,
    });
  });

  it("refuses an absent, non-finite or negative quantity", () => {
    for (const quantity of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(
        holdingValueCents(quoteFor("BTC", 118_432), quantity as number, "coins"),
      ).toMatchObject({ ok: false, error: { code: "invalid_quantity" } });
    }
  });

  it("refuses to weigh a coin or count an ounce of gold", () => {
    expect(holdingValueCents(quoteFor("BTC", 118_432), 1, "grams")).toMatchObject({
      ok: false,
      error: { code: "unsupported_unit" },
    });
    expect(holdingValueCents(quoteFor("XAU", 3315.58), 1, "coins")).toMatchObject({
      ok: false,
      error: { code: "unsupported_unit" },
    });
  });

  it("defaults a missing unit to the holding's own unit", () => {

    expect(holdingValueCents(quoteFor("XAU", 3315.58), 1, null)).toEqual(
      holdingValueCents(quoteFor("XAU", 3315.58), 1, "oz"),
    );
    expect(holdingValueCents(quoteFor("BTC", 118_432), 1, undefined)).toEqual({
      ok: true,
      valueCents: 11_843_200,
    });
  });
});

describe("fetchHoldingValueCents", () => {
  it("returns the value AND the quote it used", async () => {
    const { fetchImpl } = stubFetch(ok(COINGECKO_OK));
    const result = await fetchHoldingValueCents("ETH", 2.5, "coins", { fetchImpl, now: () => 9 });

    expect(result).toEqual({
      ok: true,
      valueCents: 945_305,
      quote: {
        symbol: "ETH",
        label: "Ethereum",
        provider: "coingecko",
        priceUnit: "coin",
        proxy: null,
        sourceLabel: "CoinGecko",
        pricePerUnitUsd: 3781.22,
        fetchedAt: 9,
      },
    });
  });

  it("propagates a failed fetch as an error and NEVER as 0 cents", async () => {
    const { fetchImpl } = stubFetch({ ok: false, status: 503, statusText: "down", json: async () => ({}) });
    const result = await fetchHoldingValueCents("BTC", 0.0345, "coins", { fetchImpl });

    expect(result).toMatchObject({ ok: false, error: { code: "http_error" } });
    expect(result).not.toHaveProperty("valueCents");
  });

  it("refuses a platinum holding without inventing a value", async () => {
    const { fetchImpl, calls } = stubFetch(ok(COINGECKO_OK));
    const result = await fetchHoldingValueCents("XPT", 5, "oz", { fetchImpl });
    expect(result).toMatchObject({ ok: false, error: { code: "no_price_source" } });
    expect(result).not.toHaveProperty("valueCents");
    expect(calls).toEqual([]);
  });

  it("does not call the network when the quantity is invalid", async () => {
    const { fetchImpl, calls } = stubFetch(ok(COINGECKO_OK));
    const result = await fetchHoldingValueCents("BTC", Number.NaN, "coins", { fetchImpl });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_quantity" } });
    expect(calls).toEqual([]);
  });
});

describe("holdingValueFromQuotes — valuing N holdings off one batch", () => {
  it("values a holding against a quote already in hand", async () => {
    const { fetchImpl, calls } = stubFetch(ok(COINGECKO_OK));
    const { quotes, errors } = await fetchPriceQuotes(["XAU", "BTC"], { fetchImpl });
    expect(calls).toHaveLength(1);

    expect(holdingValueFromQuotes("XAU", 1.1376, "oz", quotes, errors)).toMatchObject({
      ok: true,
      valueCents: 484_375,
    });
    expect(holdingValueFromQuotes("BTC", 0.0345, "coins", quotes, errors)).toMatchObject({
      ok: true,
      valueCents: 408_590,
    });
    expect(calls).toHaveLength(1);
  });

  it("passes the batch's own error through rather than inventing one", async () => {
    const { fetchImpl } = stubFetch({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({}),
    });
    const { quotes, errors } = await fetchPriceQuotes(["BTC"], { fetchImpl });
    expect(holdingValueFromQuotes("BTC", 1, "coins", quotes, errors)).toMatchObject({
      ok: false,
      error: { code: "rate_limited" },
    });
  });

  it("still rejects a bad quantity before looking for a quote", () => {
    expect(holdingValueFromQuotes("BTC", -1, "coins", new Map())).toMatchObject({
      ok: false,
      error: { code: "invalid_quantity" },
    });
  });
});
