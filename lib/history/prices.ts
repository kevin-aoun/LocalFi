
import { isDateKey, type DateKey } from "@/lib/dates";
import {
  COINGECKO_API_BASE,
  PRICED_HOLDINGS,
  PRICE_PROXIES,
  isPriceSymbol,
  type PriceErrorCode,
  type PriceFetchLike,
  type PriceFetchResponse,
  type PriceSymbol,
} from "@/lib/prices";

export type HistoricalPriceSource = {
  symbol: PriceSymbol;

  coinGeckoId: string;

  proxy: boolean;

  note: string;
};

export const HISTORICAL_PRICE_SOURCES: Record<PriceSymbol, HistoricalPriceSource | null> = {
  XAU: {
    symbol: "XAU",
    coinGeckoId: PRICE_PROXIES.XAU.coinGeckoId,
    proxy: true,
    note:
      `XAU priced via the ${PRICE_PROXIES.XAU.tokenName} token, redeemable 1:1 for one troy ounce; ` +
      "measured 0.21% from the XAU/USD spot ask on 2026-08-06",
  },
  XAG: null,
  XPT: null,
  XPD: null,
  BTC: { symbol: "BTC", coinGeckoId: "bitcoin", proxy: false, note: "BTC priced from CoinGecko daily closes" },
  ETH: { symbol: "ETH", coinGeckoId: "ethereum", proxy: false, note: "ETH priced from CoinGecko daily closes" },
};


export const MAX_HISTORY_DAYS = 365;

export const COINGECKO_MARKET_CHART_BASE = `${COINGECKO_API_BASE}/coins`;


export const DEFAULT_HISTORY_TIMEOUT_MS = 20_000;

export function historySourceFor(symbol: unknown): HistoricalPriceSource | null {
  if (typeof symbol !== "string") return null;
  const upper = symbol.trim().toUpperCase();
  return isPriceSymbol(upper) ? HISTORICAL_PRICE_SOURCES[upper] : null;
}

export function marketChartUrl(coinGeckoId: string, days: number = MAX_HISTORY_DAYS): string {
  if (!Number.isInteger(days) || days < 1 || days > MAX_HISTORY_DAYS) {
    throw new Error(
      `days must be an integer in 1..${MAX_HISTORY_DAYS} (the keyless tier's ceiling), received ${String(days)}`,
    );
  }
  return (
    `${COINGECKO_MARKET_CHART_BASE}/${encodeURIComponent(coinGeckoId)}` +
    `/market_chart?vs_currency=usd&days=${days}&interval=daily`
  );
}





export type HistoryErrorCode = PriceErrorCode | "no_history_source";

export type HistoryError = {
  code: HistoryErrorCode;
  symbol: string;
  message: string;
  status?: number;
};


export type PricePoint = { dateKey: DateKey; priceUsd: number };

export type PriceSeries = {
  symbol: PriceSymbol;
  source: HistoricalPriceSource;

  points: readonly PricePoint[];
  firstKey: DateKey;
  lastKey: DateKey;
};

export type PriceLookup = {
  priceUsd: number;

  asOfKey: DateKey;

  carriedForward: boolean;
};

export type ParsedSeries =
  | { ok: true; points: PricePoint[] }
  | { ok: false; code: HistoryErrorCode; message: string };

export type FetchSeriesResult =
  | { ok: true; series: Map<PriceSymbol, PriceSeries> }
  | { ok: false; errors: HistoryError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usablePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}






export function utcDayKey(epochMs: number): DateKey {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) {
    throw new Error(`Invalid epoch ms: ${String(epochMs)}`);
  }
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid epoch ms: ${String(epochMs)}`);
  const key =
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")}`;
  if (!isDateKey(key)) throw new Error(`Epoch ms ${epochMs} did not yield a valid date key (${key})`);
  return key;
}






export function parseMarketChart(payload: unknown): ParsedSeries {
  if (!isRecord(payload)) {
    return { ok: false, code: "malformed_response", message: "expected a JSON object" };
  }
  const prices = payload.prices;
  if (!Array.isArray(prices)) {
    return {
      ok: false,
      code: "malformed_response",
      message: `no "prices" array in the response (got keys: ${Object.keys(payload).join(", ") || "none"})`,
    };
  }
  if (prices.length === 0) {
    return { ok: false, code: "malformed_response", message: `"prices" is empty` };
  }


  const byDay = new Map<DateKey, number>();
  for (const [index, entry] of prices.entries()) {
    if (!Array.isArray(entry) || entry.length < 2) {
      return {
        ok: false,
        code: "malformed_response",
        message: `prices[${index}] is not a [timestamp, price] pair`,
      };
    }
    const [ms, price] = entry as [unknown, unknown];
    if (typeof ms !== "number" || !Number.isFinite(ms)) {
      return {
        ok: false,
        code: "malformed_response",
        message: `prices[${index}] has an unusable timestamp (${String(ms)})`,
      };
    }
    if (!usablePrice(price)) {
      return {
        ok: false,
        code: "malformed_response",
        message: `prices[${index}] has an unusable price (${String(price)})`,
      };
    }
    byDay.set(utcDayKey(ms), price);
  }

  const points = [...byDay.entries()]
    .map(([dateKey, priceUsd]) => ({ dateKey, priceUsd }))

    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));

  return { ok: true, points };
}





export function buildSeries(
  symbol: PriceSymbol,
  source: HistoricalPriceSource,
  points: PricePoint[],
): PriceSeries {
  if (points.length === 0) throw new Error(`Refusing to build an empty price series for ${symbol}`);
  return {
    symbol,
    source,
    points,
    firstKey: points[0].dateKey,
    lastKey: points[points.length - 1].dateKey,
  };
}


export function priceOn(series: PriceSeries, dateKey: DateKey): PriceLookup | null {
  if (!isDateKey(dateKey)) throw new Error(`Invalid date key: ${String(dateKey)}`);
  const { points } = series;
  if (dateKey < points[0].dateKey) return null;


  let lo = 0;
  let hi = points.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dateKey <= dateKey) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const point = points[found];
  return {
    priceUsd: point.priceUsd,
    asOfKey: point.dateKey,
    carriedForward: point.dateKey !== dateKey,
  };
}





export type FetchSeriesOptions = {

  fetchImpl?: PriceFetchLike;
  days?: number;
  timeoutMs?: number;

  spacingMs?: number;

  maxRateLimitRetries?: number;

  rateLimitRetryMs?: number;

  sleepImpl?: (ms: number) => Promise<void>;

  onRateLimitRetry?: (symbol: PriceSymbol, delayMs: number) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortSignal(timeoutMs: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(timeoutMs);
  } catch {
    return undefined;
  }
}


export async function fetchPriceSeries(
  symbols: readonly PriceSymbol[],
  options: FetchSeriesOptions = {},
): Promise<FetchSeriesResult> {
  const {
    fetchImpl,
    days = MAX_HISTORY_DAYS,
    timeoutMs = DEFAULT_HISTORY_TIMEOUT_MS,
    spacingMs = 0,
    maxRateLimitRetries = fetchImpl ? 0 : 1,
    rateLimitRetryMs = 60_000,
    sleepImpl = sleep,
    onRateLimitRetry,
  } = options;
  const doFetch: PriceFetchLike =
    fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<PriceFetchResponse>);

  const series = new Map<PriceSymbol, PriceSeries>();
  const errors: HistoryError[] = [];
  let requests = 0;

  for (const symbol of [...new Set(symbols)]) {
    const source = HISTORICAL_PRICE_SOURCES[symbol] ?? null;
    if (!source) {
      errors.push({
        code: "no_history_source",
        symbol,
        message:
          `no keyless daily price history is available for ${PRICED_HOLDINGS[symbol]?.label ?? symbol} ` +
          `(${symbol}). Its past value cannot be reconstructed.`,
      });
      continue;
    }

    const url = marketChartUrl(source.coinGeckoId, days);
    if (spacingMs > 0 && requests > 0) await sleepImpl(spacingMs);
    let response: PriceFetchResponse | undefined;
    let fetchError: unknown;
    let attempt = 0;
    while (true) {
      requests++;
      try {
        response = await doFetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: abortSignal(timeoutMs),
          next: { revalidate: 0 },
        });
      } catch (error) {
        fetchError = error;
        break;
      }

      if (response.status !== 429 || attempt >= maxRateLimitRetries) break;
      attempt++;
      onRateLimitRetry?.(symbol, rateLimitRetryMs);
      await sleepImpl(rateLimitRetryMs);
    }

    if (fetchError !== undefined) {
      errors.push({
        code: "network_error",
        symbol,
        message:
          `request to ${url} failed: ` +
          (fetchError instanceof Error ? fetchError.message : String(fetchError)),
      });
      continue;
    }
    if (response === undefined) {
      errors.push({ code: "malformed_response", symbol, message: `${url} returned no response` });
      continue;
    }

    if (!response || typeof response.ok !== "boolean") {
      errors.push({ code: "malformed_response", symbol, message: `${url} returned no response` });
      continue;
    }
    if (!response.ok) {
      errors.push({
        code: "http_error",
        symbol,
        message: `${url} answered ${response.status} ${response.statusText ?? ""}`.trim(),
        status: response.status,
      });
      continue;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      errors.push({
        code: "malformed_response",
        symbol,
        message: `could not decode the body from ${url}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const parsed = parseMarketChart(payload);
    if (!parsed.ok) {
      errors.push({ code: parsed.code, symbol, message: `${url}: ${parsed.message}` });
      continue;
    }

    series.set(symbol, buildSeries(symbol, source, parsed.points));
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, series };
}


export function describeHistoryError(error: HistoryError): string {
  switch (error.code) {
    case "no_history_source":
      return error.message;
    case "network_error":
      return `Could not reach CoinGecko for ${error.symbol} price history: you may be offline. Nothing was written.`;
    case "http_error":
      return error.status === 429
        ? `CoinGecko rate-limited the ${error.symbol} price history request (429). The keyless tier ` +
            `allows only a handful of requests a minute: wait a minute and re-run. Nothing was written.`
        : `CoinGecko answered ${error.status ?? "an error"} for ${error.symbol} price history. Nothing was written.`;
    default:
      return `Could not read CoinGecko's ${error.symbol} price history: ${error.message}. Nothing was written.`;
  }
}
