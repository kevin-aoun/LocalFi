
import { parseAmount, type Cents } from "@/lib/money";

export const PRICE_SYMBOLS = ["XAU", "XAG", "XPT", "XPD", "BTC", "ETH"] as const;
export type PriceSymbol = (typeof PRICE_SYMBOLS)[number] | `STOCK:${string}`;

export const PRICE_PROVIDERS = ["coingecko", "yahoo"] as const;
export type PriceProviderId = (typeof PRICE_PROVIDERS)[number];

export type PriceUnit = "oz" | "coin" | "share";

export const HOLDING_UNITS = ["oz", "grams", "coins", "shares"] as const;
export type HoldingUnit = (typeof HOLDING_UNITS)[number];

export const GRAMS_PER_TROY_OUNCE = 31.1034768;

export const DEFAULT_REVALIDATE_SECONDS = 60;

export const DEFAULT_TIMEOUT_MS = 8_000;

export const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";

// CSPX's USD London listing needs an exchange suffix at Yahoo; ledger symbols stay unchanged.
const STOCK_QUOTE_TICKERS: Readonly<Record<string, string>> = { CSPX: "CSPX.L" };

export type PriceProxy = {

  coinGeckoId: string;

  tokenName: string;

  unitClaim: string;

  unitEvidence: string;

  tracking: string;

  note: string;

  badge: string;
};

export const PRICE_PROXIES = {
  XAU: {
    coinGeckoId: "pax-gold",
    tokenName: "PAX Gold (PAXG)",
    unitClaim: "1 PAXG = 1 troy ounce of allocated gold",
    unitEvidence:
      "Paxos redeems 1 PAXG for one troy ounce of LBMA-accredited gold, and the quote sat " +
      "0.25% from the spot XAU/USD ask when measured — a per-gram token would have been 31x lower",
    tracking: "measured 0.25% below the spot XAU/USD ask on 2026-08-06",
    note:
      "XAU priced via the PAX Gold (PAXG) token, redeemable 1:1 for one troy ounce; " +
      "measured 0.25% from the spot XAU/USD ask on 2026-08-06",
    badge: "PAXG proxy",
  },
  XAG: {
    coinGeckoId: "kinesis-silver",
    tokenName: "Kinesis Silver (KAG)",
    unitClaim: "1 KAG = 1 troy ounce of allocated silver",
    unitEvidence:
      "Kinesis states \"1 silver (KAG) = 1 ounce of silver\"; its sibling token KAU quoted " +
      "$137.23 against gold's $137.24 per GRAM in the same minute, confirming Kinesis's " +
      "denominations to 0.007%; and $60.50 can only be an ounce — a gram would be $1.99",
    tracking:
      "measured 2.19% below the spot XAG/USD ask on 2026-08-06; KAG is thinly traded and " +
      "tracks an order of magnitude worse than PAXG",
    note:
      "XAG priced via the Kinesis Silver (KAG) token, one troy ounce of allocated silver; " +
      "measured 2.19% from the spot XAG/USD ask on 2026-08-06",
    badge: "KAG proxy",
  },
} as const satisfies Record<"XAU" | "XAG", PriceProxy>;

const NO_KEYLESS_OUNCE_SOURCE =
  "no keyless per-troy-ounce price source exists for this metal. The only tokens available " +
  "track an ETF SHARE, not an ounce, so they would misprice a holding by an arbitrary factor. " +
  "Enter this holding's value by hand instead — its stored value is kept exactly as it is.";

export type PricedHoldingSpec = {
  symbol: PriceSymbol;

  label: string;

  provider: PriceProviderId | null;

  coinGeckoId: string | null;

  proxy: PriceProxy | null;

  noSourceReason: string | null;

  assetCategory: "Commodities" | "Crypto" | "Investments";
  priceUnit: PriceUnit;

  units: readonly HoldingUnit[];
  defaultUnit: HoldingUnit;

  commodityType: "Gold" | "Silver" | "Platinum" | "Palladium" | null;
};

const METAL_UNITS = ["oz", "grams"] as const;
const COIN_UNITS = ["coins"] as const;

function proxiedMetal(
  symbol: "XAU" | "XAG",
  label: "Gold" | "Silver",
  proxy: PriceProxy,
): PricedHoldingSpec {
  return {
    symbol,
    label,
    provider: "coingecko",
    coinGeckoId: proxy.coinGeckoId,
    proxy,
    noSourceReason: null,
    assetCategory: "Commodities",
    priceUnit: "oz",
    units: METAL_UNITS,
    defaultUnit: "oz",
    commodityType: label,
  };
}

function unpricedMetal(
  symbol: "XPT" | "XPD",
  label: "Platinum" | "Palladium",
): PricedHoldingSpec {
  return {
    symbol,
    label,
    provider: null,
    coinGeckoId: null,
    proxy: null,
    noSourceReason: NO_KEYLESS_OUNCE_SOURCE,
    assetCategory: "Commodities",
    priceUnit: "oz",
    units: METAL_UNITS,
    defaultUnit: "oz",
    commodityType: label,
  };
}

function coin(
  symbol: "BTC" | "ETH",
  label: string,
  coinGeckoId: string,
): PricedHoldingSpec {
  return {
    symbol,
    label,
    provider: "coingecko",
    coinGeckoId,
    proxy: null,
    noSourceReason: null,
    assetCategory: "Crypto",
    priceUnit: "coin",
    units: COIN_UNITS,
    defaultUnit: "coins",
    commodityType: null,
  };
}

export const PRICED_HOLDINGS: Record<PriceSymbol, PricedHoldingSpec> = {
  XAU: proxiedMetal("XAU", "Gold", PRICE_PROXIES.XAU),
  XAG: proxiedMetal("XAG", "Silver", PRICE_PROXIES.XAG),
  XPT: unpricedMetal("XPT", "Platinum"),
  XPD: unpricedMetal("XPD", "Palladium"),
  BTC: coin("BTC", "Bitcoin", "bitcoin"),
  ETH: coin("ETH", "Ethereum", "ethereum"),
};

export const commodityPriceSymbols = PRICE_SYMBOLS.filter(
  (symbol) => PRICED_HOLDINGS[symbol].assetCategory === "Commodities",
);
export const cryptoPriceSymbols = PRICE_SYMBOLS.filter(
  (symbol) => PRICED_HOLDINGS[symbol].assetCategory === "Crypto",
);

export const priceableSymbols = PRICE_SYMBOLS.filter(
  (symbol) => PRICED_HOLDINGS[symbol].coinGeckoId !== null,
);

export function isPriceSymbol(value: unknown): value is PriceSymbol {
  return typeof value === "string" && (
    (PRICE_SYMBOLS as readonly string[]).includes(value) || /^STOCK:[A-Z][A-Z0-9.-]{0,19}$/.test(value)
  );
}

export function stockPriceSymbol(ticker: string): PriceSymbol | null {
  const symbol = `STOCK:${ticker.trim().toUpperCase()}`;
  return isPriceSymbol(symbol) ? symbol : null;
}

export function pricedHolding(symbol: unknown): PricedHoldingSpec | null {
  if (typeof symbol !== "string") return null;
  const upper = symbol.trim().toUpperCase();
  if (upper.startsWith("STOCK:") && isPriceSymbol(upper)) {
    return {
      symbol: upper, label: upper.slice(6), provider: "yahoo", coinGeckoId: null,
      proxy: null, noSourceReason: null, assetCategory: "Investments", priceUnit: "share",
      units: ["shares"], defaultUnit: "shares", commodityType: null,
    };
  }
  return isPriceSymbol(upper) ? PRICED_HOLDINGS[upper] : null;
}

export function priceSymbolForCommodityType(
  commodityType: string | null | undefined,
): PriceSymbol | null {
  if (commodityType === null || commodityType === undefined) return null;
  const wanted = commodityType.trim().toLowerCase();
  for (const symbol of PRICE_SYMBOLS) {
    const legacy = PRICED_HOLDINGS[symbol].commodityType;
    if (legacy !== null && legacy.toLowerCase() === wanted) return symbol;
  }
  return null;
}

export type PriceSourceKind = "direct" | "proxy" | "none";

export type PriceSourceDisclosure = {
  kind: PriceSourceKind;

  badge: string;

  detail: string;
};

export function describePriceSource(symbol: unknown): PriceSourceDisclosure {
  const spec = pricedHolding(symbol);
  if (!spec) {
    return {
      kind: "none",
      badge: "No price source",
      detail: `There is no live price feed for "${String(symbol)}".`,
    };
  }
  if (spec.provider === null) {
    return {
      kind: "none",
      badge: "No price source",
      detail: `${spec.label} cannot be priced live: ${spec.noSourceReason ?? "no source."}`,
    };
  }
  if (spec.proxy !== null) {
    const { tokenName, unitClaim, tracking } = spec.proxy;
    return {
      kind: "proxy",
      badge: spec.proxy.badge,
      detail:
        `This is not a ${spec.label.toLowerCase()} quote: it is the CoinGecko price of ` +
        `${tokenName}, a proxy. ${unitClaim}, ${tracking}.`,
    };
  }
  return {
    kind: "direct",
    badge: spec.provider === "yahoo" ? "Yahoo Finance" : "CoinGecko",
    detail: spec.provider === "yahoo"
      ? `${spec.label} priced in USD from Yahoo Finance. Quotes may be delayed; outside market hours the last market quote is used.`
      : `${spec.label} priced directly from CoinGecko.`,
  };
}


export function priceSourceLabel(symbol: unknown): string {
  const disclosure = describePriceSource(symbol);
  if (disclosure.kind === "proxy") return `CoinGecko · ${disclosure.badge}`;
  if (disclosure.kind === "none") return disclosure.badge;
  return disclosure.badge;
}





export type PriceErrorCode =

  | "unknown_symbol"

  | "no_price_source"

  | "unsupported_unit"

  | "invalid_quantity"

  | "network_error"

  | "rate_limited"

  | "http_error"

  | "malformed_response";

export type PriceError = {
  code: PriceErrorCode;

  symbol: string;
  provider: PriceProviderId | null;

  message: string;

  status?: number;
};

export type PriceQuote = {
  symbol: PriceSymbol;
  label: string;
  provider: PriceProviderId;

  pricePerUnitUsd: number;
  priceUnit: PriceUnit;

  proxy: PriceProxy | null;

  sourceLabel: string;

  fetchedAt: number;
  quotedAt?: number;
};

export type PriceResult = { ok: true; quote: PriceQuote } | { ok: false; error: PriceError };

export type HoldingValueResult =
  | { ok: true; valueCents: Cents; quote: PriceQuote }
  | { ok: false; error: PriceError };


export type ParsedPrice =
  | { ok: true; pricePerUnitUsd: number }
  | { ok: false; code: PriceErrorCode; message: string };

function fail(
  code: PriceErrorCode,
  symbol: string,
  provider: PriceProviderId | null,
  message: string,
  status?: number,
): { ok: false; error: PriceError } {
  const error: PriceError = { code, symbol, provider, message };
  if (status !== undefined) error.status = status;
  return { ok: false, error };
}

const PROVIDER_LABELS: Record<PriceProviderId, string> = {
  coingecko: "CoinGecko",
  yahoo: "Yahoo Finance",
};


export function describePriceError(error: PriceError): string {
  const spec = pricedHolding(error.symbol);
  const what = spec ? `a live ${spec.label} price` : `a live price for "${error.symbol}"`;
  const who = error.provider ? PROVIDER_LABELS[error.provider] : "the price provider";

  const tail = "the last stored value is kept. Try again shortly.";

  switch (error.code) {
    case "unknown_symbol":
      return `There is no live price feed for "${error.symbol}", so ${tail}`;
    case "no_price_source":
      return (
        `${spec?.label ?? error.symbol} has no live price source, so ${tail} ` +
        `Its stored value has been kept exactly as it was.`
      );
    case "unsupported_unit":
      return `${error.message}, so ${tail}`;
    case "invalid_quantity":
      return error.message;
    case "network_error":
      return (
        `Could not reach ${who} for ${what}: ${who} is unreachable, so you may be offline, ` +
        `and ${tail}`
      );
    case "rate_limited":
      return (
        `${who} is rate-limiting this app, so ${tail} You are NOT offline — the keyless ` +
        `${who} tier allows only a handful of requests a minute. Wait about a minute and try again.`
      );
    case "http_error":
      if (error.provider === "yahoo" && error.status === 404) return `${error.message} The last stored value is kept.`;
      return `Could not fetch ${what}: ${who} answered ${error.status ?? "an error"}, so ${tail}`;
    case "malformed_response":
      return (
        `Could not fetch ${what}: ${error.message} ${who} sent a response this app could not read, so ${tail}`
      );
  }
}






function usablePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


export function parseCoinGeckoPrice(payload: unknown, coinGeckoId: string): ParsedPrice {
  if (!isRecord(payload)) {
    return { ok: false, code: "malformed_response", message: "expected a JSON object" };
  }
  const entry = payload[coinGeckoId];
  if (!isRecord(entry)) {
    return {
      ok: false,
      code: "malformed_response",
      message: `no "${coinGeckoId}" in the response (got keys: ${Object.keys(payload).join(", ") || "none"})`,
    };
  }
  if (!usablePrice(entry.usd)) {
    return {
      ok: false,
      code: "malformed_response",
      message: `"${coinGeckoId}.usd" is not a usable price (${String(entry.usd)})`,
    };
  }
  return { ok: true, pricePerUnitUsd: entry.usd };
}


export const COINGECKO_IDS: readonly string[] = priceableSymbols.map(
  (symbol) => PRICED_HOLDINGS[symbol].coinGeckoId as string,
);

export const COINGECKO_URL =
  `${COINGECKO_API_BASE}/simple/price?ids=${COINGECKO_IDS.join(",")}&vs_currencies=usd`;






export type PriceFetchInit = RequestInit & { next?: { revalidate?: number } };


export type PriceFetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  json: () => Promise<unknown>;
};

export type PriceFetchLike = (
  url: string,
  init?: PriceFetchInit,
) => Promise<PriceFetchResponse>;

export type FetchPriceOptions = {

  fetchImpl?: PriceFetchLike;

  revalidateSeconds?: number;
  timeoutMs?: number;

  now?: () => number;
};

function abortSignal(timeoutMs: number): AbortSignal | undefined {


  try {
    return AbortSignal.timeout(timeoutMs);
  } catch {
    return undefined;
  }
}


export function priceRequestInit(
  revalidateSeconds: number,
  timeoutMs: number,
): PriceFetchInit {
  return {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: abortSignal(timeoutMs),
    next: { revalidate: revalidateSeconds },
  };
}


async function fetchCoinGeckoQuotes(
  symbols: readonly string[],
  options: FetchPriceOptions = {},
): Promise<{ quotes: Map<PriceSymbol, PriceQuote>; errors: Map<string, PriceError> }> {
  const {
    fetchImpl,
    revalidateSeconds = DEFAULT_REVALIDATE_SECONDS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => Date.now(),
  } = options;

  const quotes = new Map<PriceSymbol, PriceQuote>();
  const errors = new Map<string, PriceError>();


  const wanted: PricedHoldingSpec[] = [];
  for (const raw of symbols) {
    const spec = pricedHolding(raw);
    if (!spec) {
      errors.set(String(raw), {
        code: "unknown_symbol",
        symbol: String(raw),
        provider: null,
        message: `no price provider is registered for "${String(raw)}"`,
      });
      continue;
    }
    if (spec.coinGeckoId === null) {
      errors.set(spec.symbol, {
        code: "no_price_source",
        symbol: spec.symbol,
        provider: null,
        message: `${spec.label} (${spec.symbol}): ${spec.noSourceReason ?? "no price source."}`,
      });
      continue;
    }
    if (!wanted.some((s) => s.symbol === spec.symbol)) wanted.push(spec);
  }

  if (wanted.length === 0) return { quotes, errors };

  const doFetch: PriceFetchLike =
    fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<PriceFetchResponse>);


  const url = COINGECKO_URL;


  const failAll = (
    code: PriceErrorCode,
    message: string,
    status?: number,
  ): { quotes: Map<PriceSymbol, PriceQuote>; errors: Map<string, PriceError> } => {
    for (const spec of wanted) {
      const error: PriceError = { code, symbol: spec.symbol, provider: "coingecko", message };
      if (status !== undefined) error.status = status;
      errors.set(spec.symbol, error);
    }
    return { quotes, errors };
  };

  let response: PriceFetchResponse;
  try {
    response = await doFetch(url, priceRequestInit(revalidateSeconds, timeoutMs));
  } catch (error) {
    return failAll(
      "network_error",
      `request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response || typeof response.ok !== "boolean") {
    return failAll("malformed_response", `${url} returned no response`);
  }

  if (!response.ok) {


    const code: PriceErrorCode = response.status === 429 ? "rate_limited" : "http_error";
    return failAll(
      code,
      `${url} answered ${response.status} ${response.statusText ?? ""}`.trim(),
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return failAll(
      "malformed_response",
      `could not decode the body from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const fetchedAt = now();
  for (const spec of wanted) {
    const parsed = parseCoinGeckoPrice(payload, spec.coinGeckoId as string);
    if (!parsed.ok) {
      errors.set(spec.symbol, {
        code: parsed.code,
        symbol: spec.symbol,
        provider: "coingecko",
        message: parsed.message,
      });
      continue;
    }
    quotes.set(spec.symbol, {
      symbol: spec.symbol,
      label: spec.label,
      provider: "coingecko",
      pricePerUnitUsd: parsed.pricePerUnitUsd,
      priceUnit: spec.priceUnit,
      proxy: spec.proxy,
      sourceLabel: priceSourceLabel(spec.symbol),
      fetchedAt,
    });
  }

  return { quotes, errors };
}

export function parseStockPrice(payload: unknown, ticker: string): ParsedPrice {
  const chart = isRecord(payload) && isRecord(payload.chart) ? payload.chart : null;
  const result = chart && Array.isArray(chart.result) ? chart.result[0] : null;
  const meta = isRecord(result) && isRecord(result.meta) ? result.meta : null;
  if (!meta || chart?.error || meta.symbol !== ticker || meta.currency !== "USD" ||
      !["EQUITY", "ETF"].includes(String(meta.instrumentType)) || !usablePrice(meta.regularMarketPrice)) {
    return { ok: false, code: "malformed_response", message: "Choose a valid stock or ETF quoted in USD. No currency conversion is applied." };
  }
  return { ok: true, pricePerUnitUsd: meta.regularMarketPrice };
}

async function fetchStockQuote(spec: PricedHoldingSpec, options: FetchPriceOptions): Promise<PriceResult> {
  const ticker = STOCK_QUOTE_TICKERS[spec.label] ?? spec.label;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  const doFetch = options.fetchImpl ?? fetch;
  let response: PriceFetchResponse;
  try {
    const init = priceRequestInit(options.revalidateSeconds ?? DEFAULT_REVALIDATE_SECONDS, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    response = await doFetch(url, { ...init, headers: { ...init.headers, "User-Agent": "Mozilla/5.0 LocalFi" } });
  } catch {
    return fail("network_error", spec.symbol, "yahoo", "Could not reach Yahoo Finance.");
  }
  if (!response || typeof response.ok !== "boolean") return fail("malformed_response", spec.symbol, "yahoo", "No response from Yahoo Finance.");
  if (!response.ok) return fail(response.status === 429 ? "rate_limited" : "http_error", spec.symbol, "yahoo",
    response.status === 404 ? `Yahoo Finance could not find ${ticker}. Include the exchange suffix when needed, for example CSPX.L.` : "Stock quote unavailable.", response.status);
  try {
    const payload = await response.json();
    const parsed = parseStockPrice(payload, ticker);
    if (!parsed.ok) return fail(parsed.code, spec.symbol, "yahoo", parsed.message);
    const meta = (payload as { chart: { result: { meta: { regularMarketTime?: number } }[] } }).chart.result[0].meta;
    return { ok: true, quote: {
      symbol: spec.symbol, label: spec.label, provider: "yahoo", pricePerUnitUsd: parsed.pricePerUnitUsd,
      priceUnit: "share", proxy: null, sourceLabel: ticker === spec.label ? "Yahoo Finance" : `Yahoo Finance · ${ticker}`, fetchedAt: (options.now ?? Date.now)(),
      ...(Number.isSafeInteger(meta.regularMarketTime) && meta.regularMarketTime! > 0 ? { quotedAt: meta.regularMarketTime! * 1000 } : {}),
    } };
  } catch {
    return fail("malformed_response", spec.symbol, "yahoo", "Could not read the stock quote.");
  }
}

// Yahoo tickers with keyless daily history. Gold follows its PAXG live proxy; other metals have none.
const HISTORY_TICKERS: Readonly<Record<string, string>> = { XAU: "PAXG-USD", BTC: "BTC-USD", ETH: "ETH-USD" };

export function historyTicker(symbol: string): string | null {
  const spec = pricedHolding(symbol);
  if (!spec) return null;
  if (spec.symbol.startsWith("STOCK:")) return STOCK_QUOTE_TICKERS[spec.label] ?? spec.label;
  return HISTORY_TICKERS[spec.symbol] ?? null;
}

export type DailyClose = { day: string; observedAt: number; unitPrice: string };

/** Daily USD closes from a Yahoo chart payload, each dated in the exchange's own calendar. */
export function parseDailyCloses(payload: unknown, ticker: string): DailyClose[] | null {
  const chart = isRecord(payload) && isRecord(payload.chart) ? payload.chart : null;
  const result = chart && Array.isArray(chart.result) && isRecord(chart.result[0]) ? chart.result[0] : null;
  const meta = result && isRecord(result.meta) ? result.meta : null;
  if (!result || !meta || chart?.error || meta.symbol !== ticker || meta.currency !== "USD") return null;
  const offset = Number.isSafeInteger(meta.gmtoffset) ? Number(meta.gmtoffset) : 0;
  const quote = isRecord(result.indicators) && Array.isArray(result.indicators.quote) ? result.indicators.quote[0] : null;
  const closes = isRecord(quote) && Array.isArray(quote.close) ? quote.close : [];
  const times = Array.isArray(result.timestamp) ? result.timestamp : [];
  return times.flatMap((time, index) => {
    const close = closes[index];
    if (!Number.isSafeInteger(time) || !usablePrice(close)) return [];
    const local = new Date((Number(time) + offset) * 1000);
    const day = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
    return [{ day, observedAt: Number(time), unitPrice: String(Number(close.toFixed(4))) }];
  });
}

/** Daily closes since `fromEpochSeconds`; an empty list when the source has none or fails. */
export async function fetchDailyCloses(symbol: string, fromEpochSeconds: number, options: FetchPriceOptions = {}): Promise<DailyClose[]> {
  const ticker = historyTicker(symbol);
  if (!ticker) return [];
  const now = Math.floor((options.now ?? Date.now)() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${fromEpochSeconds}&period2=${now}`;
  try {
    const init = priceRequestInit(options.revalidateSeconds ?? DEFAULT_REVALIDATE_SECONDS, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const response = await (options.fetchImpl ?? fetch)(url, { ...init, headers: { ...init.headers, "User-Agent": "Mozilla/5.0 LocalFi" } });
    return response?.ok ? parseDailyCloses(await response.json(), ticker) ?? [] : [];
  } catch {
    return [];
  }
}

export async function fetchPriceQuotes(symbols: readonly string[], options: FetchPriceOptions = {}) {
  const stocks = [...new Set(symbols.map((symbol) => pricedHolding(symbol)?.symbol))]
    .filter((symbol): symbol is PriceSymbol => symbol !== undefined && symbol.startsWith("STOCK:"));
  const [batch, stockResults] = await Promise.all([
    fetchCoinGeckoQuotes(symbols.filter((symbol) => !pricedHolding(symbol)?.symbol.startsWith("STOCK:")), options),
    Promise.all(stocks.map((symbol) => fetchStockQuote(pricedHolding(symbol)!, options))),
  ]);
  for (const result of stockResults) {
    if (result.ok) batch.quotes.set(result.quote.symbol, result.quote);
    else batch.errors.set(result.error.symbol, result.error);
  }
  return batch;
}


export async function fetchPriceQuote(
  symbol: string,
  options: FetchPriceOptions = {},
): Promise<PriceResult> {
  const { quotes, errors } = await fetchPriceQuotes([symbol], options);
  const spec = pricedHolding(symbol);
  const quote = spec ? quotes.get(spec.symbol) : undefined;
  if (quote) return { ok: true, quote };

  const error = errors.get(spec?.symbol ?? String(symbol)) ?? {
    code: "malformed_response" as const,
    symbol: String(symbol),
    provider: null,
    message: `no quote and no error was produced for "${String(symbol)}"`,
  };
  return { ok: false, error };
}






export function quantityInPriceUnits(
  quantity: number | null | undefined,
  unit: string | null | undefined,
  spec: PricedHoldingSpec,
): { ok: true; quantity: number } | { ok: false; code: PriceErrorCode; message: string } {
  if (quantity === null || quantity === undefined) {
    return {
      ok: false,
      code: "invalid_quantity",
      message: "Enter a quantity before enabling live pricing.",
    };
  }
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    return {
      ok: false,
      code: "invalid_quantity",
      message: `"${String(quantity)}" is not a valid quantity.`,
    };
  }
  if (quantity < 0) {
    return {
      ok: false,
      code: "invalid_quantity",
      message: `A quantity cannot be negative (got ${quantity}).`,
    };
  }



  const requested: string =
    unit === null || unit === undefined || unit.trim() === ""
      ? spec.defaultUnit
      : unit.trim().toLowerCase();

  const UNIT_ALIASES: Record<string, HoldingUnit> = {
    share: "shares",
    shares: "shares",
    coin: "coins",
    coins: "coins",
    g: "grams",
    gram: "grams",
    grams: "grams",
    oz: "oz",
    ounce: "oz",
    ounces: "oz",
  };
  const normalised: HoldingUnit | null = UNIT_ALIASES[requested] ?? null;

  if (normalised === null || !spec.units.includes(normalised)) {
    return {
      ok: false,
      code: "unsupported_unit",
      message:
        `${spec.label} is priced per ${spec.priceUnit === "coin" ? "coin" : "troy ounce"}, ` +
        `so a quantity in "${String(unit)}" cannot be valued (expected ${spec.units.join(" or ")}).`,
    };
  }

  return {
    ok: true,
    quantity: normalised === "grams" ? quantity / GRAMS_PER_TROY_OUNCE : quantity,
  };
}


export function holdingValueCents(
  quote: PriceQuote,
  quantity: number | null | undefined,
  unit: string | null | undefined,
): { ok: true; valueCents: Cents } | { ok: false; error: PriceError } {
  const spec = pricedHolding(quote.symbol);
  if (!spec) {
    return fail("unknown_symbol", String(quote.symbol), null, "quote carries an unknown symbol");
  }

  const converted = quantityInPriceUnits(quantity, unit, spec);
  if (!converted.ok) {
    return fail(converted.code, spec.symbol, spec.provider, converted.message);
  }
  if (!usablePrice(quote.pricePerUnitUsd)) {
    return fail(
      "malformed_response",
      spec.symbol,
      spec.provider,
      `quote carries an unusable price (${String(quote.pricePerUnitUsd)})`,
    );
  }

  return { ok: true, valueCents: parseAmount(converted.quantity * quote.pricePerUnitUsd) };
}


export async function fetchHoldingValueCents(
  symbol: string,
  quantity: number | null | undefined,
  unit: string | null | undefined,
  options: FetchPriceOptions = {},
): Promise<HoldingValueResult> {
  const spec = pricedHolding(symbol);
  if (!spec) {
    return fail(
      "unknown_symbol",
      String(symbol),
      null,
      `no price provider is registered for "${String(symbol)}"`,
    );
  }

  const converted = quantityInPriceUnits(quantity, unit, spec);
  if (!converted.ok) {
    return fail(converted.code, spec.symbol, spec.provider, converted.message);
  }

  const quoted = await fetchPriceQuote(spec.symbol, options);
  if (!quoted.ok) return quoted;

  const valued = holdingValueCents(quoted.quote, quantity, unit);
  if (!valued.ok) return valued;

  return { ok: true, valueCents: valued.valueCents, quote: quoted.quote };
}


export function readQuantityField(raw: unknown): { present: false } | { present: true; value: number } {
  if (raw === null || raw === undefined) return { present: false };
  const text = String(raw).trim();
  if (text === "") return { present: false };
  return { present: true, value: Number(text) };
}
