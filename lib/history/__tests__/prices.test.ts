
import { describe, expect, it, vi } from "vitest";

import {
  HISTORICAL_PRICE_SOURCES,
  MAX_HISTORY_DAYS,
  buildSeries,
  describeHistoryError,
  fetchPriceSeries,
  marketChartUrl,
  parseMarketChart,
  priceOn,
  utcDayKey,
  type PriceSeries,
} from "../prices";
import type { PriceFetchLike, PriceFetchResponse } from "@/lib/prices";

const PAXG_BODY = {
  prices: [
    [1754524800000, 3370.8895362829107],
    [1754611200000, 3393.5621804374223],
    [1754697600000, 3385.8568448801175],
    [1754784000000, 3390.1234567890123],
    [1785974400000, 4266.99464546129],
    [1786008850000, 4269.554635667261],
  ],
  market_caps: [[1754524800000, 1017885526.0]],
  total_volumes: [[1754524800000, 39528165.5]],
};

const BTC_BODY = {
  prices: [
    [1754524800000, 115013.39140866172],
    [1754611200000, 114800.5],
  ],
  market_caps: [],
  total_volumes: [],
};

function ok(body: unknown): PriceFetchResponse {
  return { ok: true, status: 200, json: async () => body };
}

function series(points: Array<[string, number]>): PriceSeries {
  return buildSeries(
    "XAU",
    HISTORICAL_PRICE_SOURCES.XAU!,
    points.map(([dateKey, priceUsd]) => ({ dateKey, priceUsd })),
  );
}

describe("utcDayKey", () => {
  it("reads the provider's stamp as the provider's UTC day, in any timezone", () => {

    expect(utcDayKey(1754524800000)).toBe("2025-08-07");
    expect(utcDayKey(1786008850000)).toBe("2026-08-06");
  });

  it("rejects a non-finite timestamp instead of inventing a day", () => {
    expect(() => utcDayKey(Number.NaN)).toThrow(/Invalid epoch ms/);
    expect(() => utcDayKey(Number.POSITIVE_INFINITY)).toThrow(/Invalid epoch ms/);
  });
});

describe("parseMarketChart", () => {
  it("keeps the LAST point for a day, so the trailing intraday point wins", () => {
    const parsed = parseMarketChart(PAXG_BODY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.points).toHaveLength(5);
    const today = parsed.points.find((p) => p.dateKey === "2026-08-06");
    expect(today?.priceUsd).toBe(4269.554635667261);
  });

  it("returns points in ascending day order", () => {
    const parsed = parseMarketChart({ prices: [...PAXG_BODY.prices].reverse() });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const keys = parsed.points.map((p) => p.dateKey);
    expect(keys).toEqual([...keys].sort());
  });

  it("rejects a body with no prices array, an empty one, or an unusable point", () => {
    for (const bad of [
      null,
      "not json",
      {},
      { prices: [] },
      { prices: [[1754524800000]] },
      { prices: [[1754524800000, null]] },
      { prices: [[1754524800000, 0]] },
      { prices: [["yesterday", 100]] },
    ]) {
      const parsed = parseMarketChart(bad);
      expect(parsed.ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("priceOn", () => {
  const gaps = series([
    ["2026-01-02", 100],
    ["2026-01-03", 110],

    ["2026-01-06", 120],
  ]);

  it("uses the day's own close when there is one", () => {
    expect(priceOn(gaps, "2026-01-03")).toEqual({
      priceUsd: 110,
      asOfKey: "2026-01-03",
      carriedForward: false,
    });
  });

  it("carries the last known close forward across a gap, and says it did", () => {
    expect(priceOn(gaps, "2026-01-05")).toEqual({
      priceUsd: 110,
      asOfKey: "2026-01-03",
      carriedForward: true,
    });
  });

  it("carries forward past the end of the series too", () => {
    expect(priceOn(gaps, "2026-02-01")?.priceUsd).toBe(120);
    expect(priceOn(gaps, "2026-02-01")?.carriedForward).toBe(true);
  });

  it("returns null before the series starts — a price is never carried BACKWARDS", () => {
    expect(priceOn(gaps, "2026-01-01")).toBeNull();
  });
});

describe("marketChartUrl", () => {
  it("asks for daily USD points and refuses to exceed the keyless 365-day ceiling", () => {
    expect(marketChartUrl("pax-gold")).toBe(
      "https://api.coingecko.com/api/v3/coins/pax-gold/market_chart?vs_currency=usd&days=365&interval=daily",
    );
    expect(MAX_HISTORY_DAYS).toBe(365);
    expect(() => marketChartUrl("pax-gold", 400)).toThrow(/365/);
  });
});

describe("fetchPriceSeries", () => {
  it("makes exactly ONE request per symbol for the whole window", async () => {
    const calls: string[] = [];
    const fetchImpl: PriceFetchLike = vi.fn(async (url: string) => {
      calls.push(url);
      return ok(url.includes("pax-gold") ? PAXG_BODY : BTC_BODY);
    });

    const result = await fetchPriceSeries(["XAU", "BTC", "XAU"], { fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    if (!result.ok) return;
    expect([...result.series.keys()].sort()).toEqual(["BTC", "XAU"]);
    expect(result.series.get("XAU")!.source.proxy).toBe(true);
    expect(result.series.get("XAU")!.firstKey).toBe("2025-08-07");
  });

  it("refuses a symbol with no keyless history rather than inventing one", async () => {
    const fetchImpl: PriceFetchLike = vi.fn(async () => ok(PAXG_BODY));
    const result = await fetchPriceSeries(["XAG"], { fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("no_history_source");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns NO series at all when any symbol fails — all or nothing", async () => {
    const fetchImpl: PriceFetchLike = async (url: string) =>
      url.includes("bitcoin")
        ? { ok: false, status: 429, statusText: "Too Many Requests", json: async () => ({}) }
        : ok(PAXG_BODY);

    const result = await fetchPriceSeries(["XAU", "BTC"], { fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: "http_error", symbol: "BTC", status: 429 });
  });

  it("waits and retries a rate-limited real series without duplicating successful symbols", async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    const retries: Array<[string, number]> = [];
    let bitcoinAttempts = 0;
    const fetchImpl: PriceFetchLike = async (url: string) => {
      calls.push(url);
      if (!url.includes("bitcoin")) return ok(PAXG_BODY);
      bitcoinAttempts++;
      return bitcoinAttempts === 1
        ? { ok: false, status: 429, statusText: "Too Many Requests", json: async () => ({}) }
        : ok(BTC_BODY);
    };

    const result = await fetchPriceSeries(["XAU", "BTC"], {
      fetchImpl,
      maxRateLimitRetries: 1,
      rateLimitRetryMs: 1234,
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
      onRateLimitRetry: (symbol, ms) => retries.push([symbol, ms]),
    });

    expect(result.ok).toBe(true);
    expect(calls.filter((url) => url.includes("pax-gold"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes("bitcoin"))).toHaveLength(2);
    expect(waits).toEqual([1234]);
    expect(retries).toEqual([["BTC", 1234]]);
  });

  it("turns being offline into a typed error, never a throw", async () => {
    const fetchImpl: PriceFetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.coingecko.com");
    };
    const result = await fetchPriceSeries(["BTC"], { fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("network_error");
    expect(describeHistoryError(result.errors[0])).toMatch(/offline/i);
  });

  it("treats an unreadable body as malformed, not as a price of 0", async () => {
    const fetchImpl: PriceFetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    });
    const result = await fetchPriceSeries(["BTC"], { fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("malformed_response");
  });
});

describe("the gold proxy is declared, not hidden", () => {
  it("marks XAU as a proxy and names the token in its note", () => {
    const source = HISTORICAL_PRICE_SOURCES.XAU!;
    expect(source.proxy).toBe(true);
    expect(source.coinGeckoId).toBe("pax-gold");
    expect(source.note).toMatch(/PAX Gold/);
  });

  it("has no history source for the metals nobody serves keyless history for", () => {
    expect(HISTORICAL_PRICE_SOURCES.XAG).toBeNull();
    expect(HISTORICAL_PRICE_SOURCES.XPT).toBeNull();
    expect(HISTORICAL_PRICE_SOURCES.XPD).toBeNull();
  });

  it("prices BTC and ETH from their own series, not a proxy", () => {
    expect(HISTORICAL_PRICE_SOURCES.BTC).toMatchObject({ coinGeckoId: "bitcoin", proxy: false });
    expect(HISTORICAL_PRICE_SOURCES.ETH).toMatchObject({ coinGeckoId: "ethereum", proxy: false });
  });
});
