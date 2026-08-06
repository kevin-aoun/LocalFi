/**
 * HISTORICAL prices — one series per symbol, fetched once, looked up per day.
 *
 * WHY THIS IS NOT lib/prices.ts
 *
 * lib/prices.ts answers "what is this worth RIGHT NOW". It is the write path for
 * a live-priced holding and it must never guess. This module answers a different
 * question — "what was this worth on 2025-11-04" — and it can only ever produce
 * an ESTIMATE, because:
 *
 *   - gold has no keyless daily history feed, so XAU is priced through a PROXY
 *     (see below), and
 *   - a day the provider has no point for is filled by CARRYING THE LAST KNOWN
 *     PRICE FORWARD, which is a modelling choice, not an observation.
 *
 * Every consumer therefore gets the provenance back alongside the number
 * (`proxy`, `carriedForward`, `asOfKey`), and the reconstruction writes it into
 * `net_worth_snapshots.source_note` so that a year from now nobody has to guess.
 *
 * THE GOLD PROXY, MEASURED
 *
 * Every keyless daily gold feed tried was dead or blocked (stooq is behind a JS
 * proof-of-work wall, Yahoo rate-limits, frankfurter 301s, freegoldapi and
 * xaus.com return HTML/404). CoinGecko — the SAME keyless API lib/prices.ts
 * already uses for BTC/ETH, so this adds no dependency and no key — lists
 * `pax-gold`, a token redeemable 1:1 for one troy ounce of allocated gold.
 * Measured on 2026-08-06: PAXG $4,272.54/oz against a live XAU/USD spot ask of
 * $4,281.53/oz, i.e. 0.21% apart. That is the accuracy of every reconstructed
 * gold figure, and it is stated in the note rather than buried here.
 *
 * That same measurement is why lib/prices.ts now prices LIVE gold through the
 * same token, and the id itself is imported from there (`PRICE_PROXIES.XAU`) so
 * the two paths can never drift onto different proxies.
 *
 * THE 365-DAY CEILING
 *
 * The free tier serves at most `days=365` (366 points; `days=400` errors). Any
 * day earlier than the first point in the series is NOT priced and NOT guessed —
 * `priceOn` returns null and the caller must refuse to write that day. Carrying a
 * price BACKWARDS would invent a past that never happened.
 *
 * RULES, ALL TESTED
 *   1. One request per symbol for the whole window. Never one request per day.
 *   2. Never throws — every failure is a typed error, exactly like lib/prices.ts.
 *   3. Parsing is a pure function over decoded JSON, so tests need no network.
 *   4. Prices are floats and stay floats. Money is made exactly once, downstream,
 *      by `holdingValueCents`.
 */
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

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type HistoricalPriceSource = {
  symbol: PriceSymbol;
  /** CoinGecko's own id, used in the market_chart path. */
  coinGeckoId: string;
  /**
   * True when the series prices something that merely TRACKS the symbol rather
   * than being it. A proxy is disclosed on every day it values.
   */
  proxy: boolean;
  /** One sentence, stored verbatim in `net_worth_snapshots.source_note`. */
  note: string;
};

/**
 * Which symbols can be reconstructed at all.
 *
 * Silver, platinum and palladium are deliberately `null`, and stay `null`: no
 * keyless daily HISTORY for them was reachable, and this module's job is to
 * refuse rather than invent. (Note that XAG did later gain a LIVE price through
 * a proxy token — see PRICE_PROXIES.XAG — but a live quote is not a series, and
 * turning one on here would silently rewrite already-reconstructed history. That
 * is a separate, deliberate decision, not a side effect of this one.) A null
 * here makes a holding of that metal a LOUD failure (or an explicit
 * carry-the-stored-value opt-in), never a silently invented series.
 *
 * The gold entry takes its coin id from `PRICE_PROXIES.XAU` in lib/prices.ts so
 * that the pax-gold decision lives in exactly ONE place: live pricing and
 * historical reconstruction must never drift onto two different gold proxies.
 * The `note` stays worded for a series rather than for a quote, because it is
 * stored verbatim in `net_worth_snapshots.source_note`.
 */
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

/** The free tier's hard ceiling: `days=365` yields 366 points, `days=400` errors. */
export const MAX_HISTORY_DAYS = 365;

export const COINGECKO_MARKET_CHART_BASE = `${COINGECKO_API_BASE}/coins`;

/** Give up rather than hanging a backfill forever. Longer than a live quote: 366 points. */
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

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type HistoryErrorCode = PriceErrorCode | "no_history_source";

export type HistoryError = {
  code: HistoryErrorCode;
  symbol: string;
  message: string;
  status?: number;
};

/** One daily close: the UTC day it belongs to, and USD per price unit. */
export type PricePoint = { dateKey: DateKey; priceUsd: number };

export type PriceSeries = {
  symbol: PriceSymbol;
  source: HistoricalPriceSource;
  /** Ascending by dateKey, one point per day (last wins). Never empty. */
  points: readonly PricePoint[];
  firstKey: DateKey;
  lastKey: DateKey;
};

export type PriceLookup = {
  priceUsd: number;
  /** The day the price actually comes from. Differs from the asked day when carried. */
  asOfKey: DateKey;
  /** True when this day had no point of its own and the previous one was reused. */
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

// ---------------------------------------------------------------------------
// Timestamp -> calendar day
// ---------------------------------------------------------------------------

/**
 * Epoch ms -> 'YYYY-MM-DD' in UTC.
 *
 * WHY UTC AND NOT LOCAL, when lib/dates.ts insists every calendar day in this app
 * is local: because this day is not the USER's day, it is the PROVIDER's. Each
 * point is stamped 00:00:00Z and means "the close of that UTC day". Reading it
 * through the reader's zone would file the same close under 2026-08-05 in Niue
 * and 2026-08-06 in Kiritimati — the price series would shift by a day for half
 * the world. So the provider's day is read as the provider means it, once, here.
 *
 * Not `toISOString()`: that is banned outright in this codebase (it is how local
 * days got shifted in the first place), and the explicit getUTC* form says what
 * it is doing.
 */
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

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * CoinGecko's `market_chart` body:
 *
 *   { "prices": [[1754524800000, 3370.88], ...],
 *     "market_caps": [...], "total_volumes": [...] }
 *
 * With `interval=daily` the points are 00:00:00Z closes, PLUS a final intraday
 * point for the current day — so the same day key can appear twice. The LAST
 * point for a day wins, which is both the freshest figure and what makes the
 * result independent of how far into the day the fetch ran.
 *
 * A single unusable pair (null price, NaN timestamp) is fatal rather than
 * skipped: a hole in a price series would be silently carried forward, and a
 * carried price that nobody asked for is exactly the kind of quiet wrongness this
 * app refuses.
 */
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

  /** dateKey -> price. A later point for the same day replaces an earlier one. */
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
    // DateKeys are fixed-width, so lexicographic order IS chronological order.
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));

  return { ok: true, points };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

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

/**
 * The price to use for `dateKey`: that day's close, or the most recent close
 * BEFORE it (carried forward — weekends, holidays, provider gaps).
 *
 * Returns null when `dateKey` precedes the whole series. Nothing is interpolated
 * and nothing is carried backwards: an unpriced day must stay visibly unpriced.
 */
export function priceOn(series: PriceSeries, dateKey: DateKey): PriceLookup | null {
  if (!isDateKey(dateKey)) throw new Error(`Invalid date key: ${String(dateKey)}`);
  const { points } = series;
  if (dateKey < points[0].dateKey) return null;

  // Binary search for the last point with key <= dateKey.
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

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export type FetchSeriesOptions = {
  /** Injected in tests. Defaults to the ambient `fetch`. */
  fetchImpl?: PriceFetchLike;
  days?: number;
  timeoutMs?: number;
  /**
   * Pause between symbol requests. The keyless tier answers a burst of three
   * with 429 (observed), and a backfill that dies on the third symbol has
   * fetched two series for nothing. 0 in tests.
   */
  spacingMs?: number;
  /** Retry 429 responses this many times. Defaults to one for real requests. */
  maxRateLimitRetries?: number;
  /** Delay before retrying a 429. CoinGecko's public limit resets by the minute. */
  rateLimitRetryMs?: number;
  /** Injectable in tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Lets a CLI explain why it is waiting instead of appearing hung. */
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

/**
 * ONE request per symbol for the whole window, run sequentially.
 *
 * Sequential on purpose: the keyless tier allows roughly 5–15 requests a minute
 * and answers a burst with 429. Two or three requests is the entire cost of a
 * backfill, so there is nothing to parallelise for.
 *
 * All-or-nothing: if any symbol fails, the caller gets every error and no series,
 * so a backfill cannot half-price a day and then write it.
 */
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

/** A sentence for a human. Never mentions money — nothing was written. */
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
