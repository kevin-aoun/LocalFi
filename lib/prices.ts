
import { parseAmount, type Cents } from "@/lib/money";

export const PRICE_SYMBOLS = ["XAU", "XAG", "XPT", "XPD", "BTC", "ETH"] as const;
export type PriceSymbol = (typeof PRICE_SYMBOLS)[number];

export const PRICE_PROVIDERS = ["coingecko"] as const;
export type PriceProviderId = (typeof PRICE_PROVIDERS)[number];

export type PriceUnit = "oz" | "coin";

export const HOLDING_UNITS = ["oz", "grams", "coins"] as const;
export type HoldingUnit = (typeof HOLDING_UNITS)[number];

export const GRAMS_PER_TROY_OUNCE = 31.1034768;

export const DEFAULT_REVALIDATE_SECONDS = 60;

export const DEFAULT_TIMEOUT_MS = 8_000;

export const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";

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

  assetCategory: "Commodities" | "Crypto";
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

export const unpriceableSymbols = PRICE_SYMBOLS.filter(
  (symbol) => PRICED_HOLDINGS[symbol].coinGeckoId === null,
);

export function isPriceSymbol(value: unknown): value is PriceSymbol {
  return typeof value === "string" && (PRICE_SYMBOLS as readonly string[]).includes(value);
}

export function pricedHolding(symbol: unknown): PricedHoldingSpec | null {
  if (typeof symbol !== "string") return null;
  const upper = symbol.trim().toUpperCase();
  return isPriceSymbol(upper) ? PRICED_HOLDINGS[upper] : null;
}

export function canBePriced(symbol: unknown): boolean {
  const spec = pricedHolding(symbol);
  return spec !== null && spec.coinGeckoId !== null;
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

export function commodityTypeForPriceSymbol(
  symbol: unknown,
): PricedHoldingSpec["commodityType"] {
  return pricedHolding(symbol)?.commodityType ?? null;
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
  if (spec.coinGeckoId === null) {
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
    badge: "CoinGecko",
    detail: `${spec.label} priced directly from CoinGecko.`,
  };
}


export function priceSourceLabel(symbol: unknown): string {
  const disclosure = describePriceSource(symbol);
  if (disclosure.kind === "proxy") return `CoinGecko · ${disclosure.badge}`;
  if (disclosure.kind === "none") return disclosure.badge;
  return "CoinGecko";
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
};


export function describePriceError(error: PriceError): string {
  const spec = pricedHolding(error.symbol);
  const what = spec ? `a live ${spec.label} price` : `a live price for "${error.symbol}"`;
  const who = error.provider ? PROVIDER_LABELS[error.provider] : "the price provider";

  const tail = "nothing was saved. Try again, or turn off Live Price and enter the value manually.";

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
      return `Could not fetch ${what}: ${who} answered ${error.status ?? "an error"}, so ${tail}`;
    case "malformed_response":
      return (
        `Could not fetch ${what}: ${who} sent a response this app could not read, so ${tail}`
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


export async function fetchPriceQuotes(
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


export function holdingValueFromQuotes(
  symbol: string,
  quantity: number | null | undefined,
  unit: string | null | undefined,
  quotes: ReadonlyMap<PriceSymbol, PriceQuote>,
  errors?: ReadonlyMap<string, PriceError>,
): HoldingValueResult {
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

  const quote = quotes.get(spec.symbol);
  if (!quote) {
    const known = errors?.get(spec.symbol);
    if (known) return { ok: false, error: known };
    return fail(
      "malformed_response",
      spec.symbol,
      spec.provider,
      `no quote for ${spec.symbol} was returned by the batch request`,
    );
  }

  const valued = holdingValueCents(quote, quantity, unit);
  if (!valued.ok) return valued;
  return { ok: true, valueCents: valued.valueCents, quote };
}


export function readQuantityField(raw: unknown): { present: false } | { present: true; value: number } {
  if (raw === null || raw === undefined) return { present: false };
  const text = String(raw).trim();
  if (text === "") return { present: false };
  return { present: true, value: Number(text) };
}
