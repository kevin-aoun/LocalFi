/**
 * Live prices for priced holdings — one registry, ONE provider.
 *
 * WHY THIS MODULE EXISTS
 *
 * The app used to know how to price exactly four things: Gold, Silver, Platinum
 * and Palladium, by mapping a `commodity_type` string to a SwissQuote forex
 * symbol inside a server action. Bitcoin and Ethereum are not commodities and
 * are not on a forex feed, so "add BTC to commodityTypes" would have been a lie
 * in the schema AND a broken request. Instead a holding declares WHICH SYMBOL
 * prices it (`assets.price_symbol`), and this registry decides what to ask for.
 *
 * WHY ONLY COINGECKO NOW
 *
 * This app is offline except for pulling live prices. Two providers meant two
 * failure modes, two rate-limit behaviours, two response shapes and two sets of
 * parsing bugs — for one number. CoinGecko already served the crypto prices AND
 * the whole historical series in lib/history/prices.ts, so consolidating leaves
 * exactly one external dependency, one keyless endpoint, one thing to mock.
 *
 * SwissQuote is gone. With it went `SPREAD_PROFILES` and the `spreadProfile`
 * plumbing, whose `"prime"` vs `"Prime"` case mismatch is why gold pricing never
 * worked at all. Nothing in this module compares a provider string by case any
 * more; a CoinGecko id is an exact key lookup.
 *
 * WHAT ONE UNIT MEANS, PER SYMBOL — see PRICED_HOLDINGS and PRICE_PROXIES below.
 * Two of the six symbols are priced through a PROXY TOKEN and two cannot be
 * priced at all. Both facts are carried in the data, surfaced on every quote,
 * and rendered in the UI. A proxy the owner knows about is fine; a proxy the
 * owner does not know about is not.
 *
 * DESIGN RULES, ALL OF WHICH ARE TESTED
 *
 *  1. FAIL LOUDLY. Every failure — unknown symbol, a symbol with no source, a
 *     rate limit, an HTTP error, an unparseable body, a missing coin, a
 *     non-positive price, a socket error because the machine is offline — is
 *     returned as a TYPED error. Never `null` swallowed by a caller, never 0. A
 *     previous bug persisted a live-priced asset at $0 when the fetch failed,
 *     and the user's gold silently vanished from their net worth.
 *  2. NEVER THROW. `fetchPriceQuote` resolves to a value in every case, so a
 *     caller cannot accidentally turn an outage into a 500 or into a $0 write.
 *  3. ONE REQUEST. Every priceable symbol rides in a single `simple/price` call.
 *     The keyless tier allows roughly 5–15 requests a minute; asking per symbol
 *     is how you get a 429 while pricing four things.
 *  4. `quantity` IS NOT MONEY. It is a troy-ounce weight or a coin count, so it
 *     stays a float and is never rounded. Only the PRODUCT quantity x price
 *     becomes money, and it is rounded to the cent exactly once, here, via
 *     `parseAmount`.
 *  5. A QUANTITY OF 0 IS A QUANTITY. Every check is an explicit
 *     null/undefined/finite test; `if (!quantity)` is a bug (it is the bug that
 *     was at app/actions/assets.ts:38).
 *  6. NO NETWORK IN TESTS. `fetchImpl` is injectable, and the response parser is
 *     a pure function over already-decoded JSON.
 *  7. NOTHING IDENTIFYING LEAVES. See `priceRequestInit`.
 *
 * This module is dependency-free apart from lib/money, so it is safe to import
 * from a server action, a server component, a client component or a script.
 */
import { parseAmount, type Cents } from "@/lib/money";

// ---------------------------------------------------------------------------
// Symbols, units and providers
// ---------------------------------------------------------------------------

/**
 * Every symbol the app can STORE. Kept in sync with the `price_symbol` enum in
 * lib/db/schema/assets.ts by lib/__tests__/prices.test.ts.
 *
 * Note "store", not "price": XPT and XPD are still valid column values (see
 * `PRICED_HOLDINGS`) precisely so that existing rows stay valid and no database
 * migration is needed. They simply have no price source, which is a typed,
 * visible state rather than a removal.
 */
export const PRICE_SYMBOLS = ["XAU", "XAG", "XPT", "XPD", "BTC", "ETH"] as const;
export type PriceSymbol = (typeof PRICE_SYMBOLS)[number];

/** One provider. That is the entire point of this module's last revision. */
export const PRICE_PROVIDERS = ["coingecko"] as const;
export type PriceProviderId = (typeof PRICE_PROVIDERS)[number];

/** What one unit of a quoted price buys: a troy ounce of metal, or one coin. */
export type PriceUnit = "oz" | "coin";

/**
 * The units a user may enter a quantity in.
 *
 * `oz` / `grams` are physical weights for metals. `coins` is what `unit` means
 * for crypto: a COUNT of coins (or tokens), not a weight — 0.0345 means 0.0345
 * BTC. There is no smaller named unit on purpose: satoshis/wei would force the
 * user to convert, and `quantity` is a `real`, which represents a fractional
 * coin count exactly as well as it represents a fractional ounce.
 */
export const HOLDING_UNITS = ["oz", "grams", "coins"] as const;
export type HoldingUnit = (typeof HOLDING_UNITS)[number];

/** Precious-metal quotes are per troy ounce, not an avoirdupois ounce. */
export const GRAMS_PER_TROY_OUNCE = 31.1034768;

/** How long a quote may be reused. The metals path has always cached for 60s. */
export const DEFAULT_REVALIDATE_SECONDS = 60;

/** Give up on a request rather than hanging a form submit forever. */
export const DEFAULT_TIMEOUT_MS = 8_000;

/** The one host this app talks to. Shared with lib/history/prices.ts. */
export const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";

// ---------------------------------------------------------------------------
// Proxies — the two prices that are NOT the thing they price
// ---------------------------------------------------------------------------

/**
 * A token whose market price merely TRACKS the symbol it is standing in for.
 *
 * Every field exists so the disclosure can be rendered without the UI knowing
 * anything about metals: what it is, what one unit of it is, HOW that was
 * verified, and how far it sat from the real spot ask when it was measured.
 */
export type PriceProxy = {
  /** CoinGecko's own id. */
  coinGeckoId: string;
  /** What to call it to a human: "PAX Gold (PAXG)". */
  tokenName: string;
  /** What ONE token is. This is the number that misprices a holding 31x if wrong. */
  unitClaim: string;
  /** The evidence for `unitClaim`. An assertion nobody checked is not a unit. */
  unitEvidence: string;
  /** Measured distance from the real spot ask, with the day it was measured. */
  tracking: string;
  /** One sentence, safe to store verbatim in `net_worth_snapshots.source_note`. */
  note: string;
  /** Two or three words, for a badge next to a price. */
  badge: string;
};

/**
 * THE PROXIES, MEASURED 2026-08-06.
 *
 * Both were checked the same way, against the SwissQuote XAU/USD and XAG/USD
 * "prime" asks taken in the same minute as the CoinGecko quote — that feed was
 * still wired up at the time of the change, and measuring against it on the way
 * out is the last useful thing it did.
 *
 *   XAU  pax-gold        $4,257.87   vs XAU/USD ask $4,268.60   ->  0.25% low
 *   XAG  kinesis-silver     $60.50   vs XAG/USD ask     $61.86  ->  2.19% low
 *
 * The silver proxy tracks an order of magnitude worse than the gold one, because
 * KAG is thinly traded. That is disclosed rather than hidden, and it is a
 * TRACKING error, not a UNIT error: 2% is a bad price, 31x is a catastrophe, and
 * only the second kind can happen by accident.
 */
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

/**
 * Why platinum and palladium have no price.
 *
 * No keyless per-troy-ounce source exists for either. The only CoinGecko hit was
 * `abrdn-physical-platinum-shares-xstock`, which is a tokenized ETF SHARE price
 * — a share is not an ounce, and the two differ by an arbitrary, changing factor
 * set by the fund. Mapping XPT onto it would have produced a number that looked
 * completely plausible and was completely wrong, and it would have become the
 * owner's net worth without a word. A missing price shows as an error; a wrong
 * one does not. So these stay unpriceable until a real per-ounce source exists.
 */
const NO_KEYLESS_OUNCE_SOURCE =
  "no keyless per-troy-ounce price source exists for this metal. The only tokens available " +
  "track an ETF SHARE, not an ounce, so they would misprice a holding by an arbitrary factor. " +
  "Enter this holding's value by hand instead — its stored value is kept exactly as it is.";

export type PricedHoldingSpec = {
  symbol: PriceSymbol;
  /** Human name, used in UI and in every error message. */
  label: string;
  /** The provider, or null when nothing can price this symbol. */
  provider: PriceProviderId | null;
  /**
   * The CoinGecko id whose USD price values one `priceUnit` of this holding, or
   * null when no keyless source represents one unit of it.
   */
  coinGeckoId: string | null;
  /**
   * Non-null when `coinGeckoId` prices something that merely TRACKS this symbol
   * rather than being it. Disclosed on the quote and in the UI, always.
   */
  proxy: PriceProxy | null;
  /** Why there is no source. Non-null exactly when `coinGeckoId` is null. */
  noSourceReason: string | null;
  /** Which `assets.category` a holding of this symbol belongs in. */
  assetCategory: "Commodities" | "Crypto";
  priceUnit: PriceUnit;
  /** Units the user may enter a quantity in for this holding. */
  units: readonly HoldingUnit[];
  defaultUnit: HoldingUnit;
  /**
   * The legacy `assets.commodity_type` value, or null for anything that is not a
   * commodity. Crypto MUST stay null: `commodity_type` is a commodity name.
   */
  commodityType: "Gold" | "Silver" | "Platinum" | "Palladium" | null;
};

const METAL_UNITS = ["oz", "grams"] as const;
const COIN_UNITS = ["coins"] as const;

/** A metal priced through a proxy token that represents one troy ounce. */
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

/** A metal nothing keyless can price per ounce. Storable, refreshable: no. */
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

/** A coin CoinGecko prices directly. No proxy, no unit ambiguity. */
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

/** The registry. Adding a holding is one entry here and nothing else. */
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

/** Symbols a live price can actually be fetched for. */
export const priceableSymbols = PRICE_SYMBOLS.filter(
  (symbol) => PRICED_HOLDINGS[symbol].coinGeckoId !== null,
);

/**
 * Symbols that are still valid `price_symbol` values but cannot be priced.
 *
 * They stay in the enum ON PURPOSE: an existing `assets` row saying "XPT" keeps
 * its stored value and its column stays valid, so no database migration is
 * needed and nothing is silently zeroed. See `canBePriced`.
 */
export const unpriceableSymbols = PRICE_SYMBOLS.filter(
  (symbol) => PRICED_HOLDINGS[symbol].coinGeckoId === null,
);

export function isPriceSymbol(value: unknown): value is PriceSymbol {
  return typeof value === "string" && (PRICE_SYMBOLS as readonly string[]).includes(value);
}

/** The spec for a symbol, or null. Case-insensitive: "btc" is a BTC. */
export function pricedHolding(symbol: unknown): PricedHoldingSpec | null {
  if (typeof symbol !== "string") return null;
  const upper = symbol.trim().toUpperCase();
  return isPriceSymbol(upper) ? PRICED_HOLDINGS[upper] : null;
}

/** True when a live price can be fetched for this symbol at all. */
export function canBePriced(symbol: unknown): boolean {
  const spec = pricedHolding(symbol);
  return spec !== null && spec.coinGeckoId !== null;
}

/**
 * Legacy `commodity_type` -> symbol. This is what migration 0004 backfills with,
 * and what keeps every existing metals row working unchanged.
 */
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

/** Symbol -> legacy `commodity_type` ("Gold"), or null for crypto. */
export function commodityTypeForPriceSymbol(
  symbol: unknown,
): PricedHoldingSpec["commodityType"] {
  return pricedHolding(symbol)?.commodityType ?? null;
}

// ---------------------------------------------------------------------------
// Disclosure — what the user is told about where a number came from
// ---------------------------------------------------------------------------

export type PriceSourceKind = "direct" | "proxy" | "none";

/**
 * How a symbol's price should be described wherever it, or its `priced_at`, is
 * shown. Pure data: the same three fields drive the dialog, the sidebar and any
 * future surface, so no view can accidentally print a proxy price bare.
 */
export type PriceSourceDisclosure = {
  kind: PriceSourceKind;
  /** A short badge to sit beside a price: "CoinGecko", "PAXG proxy", "No price source". */
  badge: string;
  /** One sentence the user can act on. Never empty. */
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

/** "CoinGecko" or "CoinGecko · PAXG proxy" — safe to print next to a price. */
export function priceSourceLabel(symbol: unknown): string {
  const disclosure = describePriceSource(symbol);
  if (disclosure.kind === "proxy") return `CoinGecko · ${disclosure.badge}`;
  if (disclosure.kind === "none") return disclosure.badge;
  return "CoinGecko";
}

// ---------------------------------------------------------------------------
// Results and errors
// ---------------------------------------------------------------------------

export type PriceErrorCode =
  /** The symbol is not in the registry (or is not a crypto symbol, for the crypto-only entry point). */
  | "unknown_symbol"
  /**
   * The symbol IS in the registry but nothing keyless can price it (XPT, XPD).
   * Distinct from `unknown_symbol` because the holding is real and its stored
   * value must be kept — the user needs "price it by hand", not "that is not a
   * thing".
   */
  | "no_price_source"
  /** oz/grams asked of a coin, or coins asked of a metal. */
  | "unsupported_unit"
  /** Absent, non-finite or negative quantity. 0 is VALID. */
  | "invalid_quantity"
  /** The request never completed: DNS, socket, timeout — typically "offline". */
  | "network_error"
  /**
   * HTTP 429. Kept apart from `http_error` because the fix is completely
   * different: an offline machine needs a network, a throttled one needs a
   * minute. The keyless tier allows roughly 5–15 requests a minute.
   */
  | "rate_limited"
  /** The provider answered with some other non-2xx status. */
  | "http_error"
  /** The provider answered, but not with a usable price. */
  | "malformed_response";

export type PriceError = {
  code: PriceErrorCode;
  /** The symbol asked for, echoed back even when it is not in the registry. */
  symbol: string;
  provider: PriceProviderId | null;
  /** Technical detail, for logs. Use `describePriceError` for the UI. */
  message: string;
  /** HTTP status, when there was one. */
  status?: number;
};

export type PriceQuote = {
  symbol: PriceSymbol;
  label: string;
  provider: PriceProviderId;
  /** USD per `priceUnit`. Always a finite number > 0. */
  pricePerUnitUsd: number;
  priceUnit: PriceUnit;
  /**
   * Non-null when this price is a proxy token's price rather than the symbol's.
   * Carried ON THE QUOTE so that no consumer can render the number without also
   * having the disclosure in hand.
   */
  proxy: PriceProxy | null;
  /** "CoinGecko" or "CoinGecko · PAXG proxy". Printable as-is. */
  sourceLabel: string;
  /** Epoch ms at which WE observed this quote — used to show staleness. */
  fetchedAt: number;
};

export type PriceResult = { ok: true; quote: PriceQuote } | { ok: false; error: PriceError };

export type HoldingValueResult =
  | { ok: true; valueCents: Cents; quote: PriceQuote }
  | { ok: false; error: PriceError };

/** What the provider parser returns: a price, or why there isn't one. */
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

/**
 * A sentence for the user. Names the holding and the provider, never mentions a
 * dollar amount, and always says that nothing was saved — because nothing was.
 *
 * `rate_limited` and `network_error` deliberately read nothing like each other:
 * one says wait, the other says check your connection, and telling a throttled
 * user they are offline sends them to reboot a router for no reason.
 */
export function describePriceError(error: PriceError): string {
  const spec = pricedHolding(error.symbol);
  const what = spec ? `a live ${spec.label} price` : `a live price for "${error.symbol}"`;
  const who = error.provider ? PROVIDER_LABELS[error.provider] : "the price provider";
  // Lower-case, so it reads as the tail of whatever precedes it.
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

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/** A price must be a finite, strictly positive number. 0 is not a price. */
function usablePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * CoinGecko's keyless simple/price endpoint:
 *
 *   { "pax-gold": { "usd": 4257.87 }, "bitcoin": { "usd": 118432 } }
 *
 * An empty `{}` (which is what CoinGecko returns for an unknown id, and what a
 * rate-limited edge cache sometimes returns with a 200) is MALFORMED, not a
 * price of 0.
 */
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

/**
 * EVERY priceable id, in one query string.
 *
 * One request prices all four things. The keyless tier answers a burst of
 * per-symbol requests with 429 — that was measured, six ids fetched one at a
 * time got throttled — and asking for four ids costs exactly what asking for one
 * does. It also means pricing BTC warms the gold cache.
 */
export const COINGECKO_IDS: readonly string[] = priceableSymbols.map(
  (symbol) => PRICED_HOLDINGS[symbol].coinGeckoId as string,
);

export const COINGECKO_URL =
  `${COINGECKO_API_BASE}/simple/price?ids=${COINGECKO_IDS.join(",")}&vs_currencies=usd`;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** `RequestInit` plus Next's cache hint, which plain `fetch` ignores. */
export type PriceFetchInit = RequestInit & { next?: { revalidate?: number } };

/** The minimum of `Response` this module uses, so tests can pass a plain object. */
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
  /** Injected in tests. Defaults to the ambient `fetch`. */
  fetchImpl?: PriceFetchLike;
  /** Next.js cache window in seconds. */
  revalidateSeconds?: number;
  timeoutMs?: number;
  /** Injected in tests so `fetchedAt` is deterministic. */
  now?: () => number;
};

function abortSignal(timeoutMs: number): AbortSignal | undefined {
  // AbortSignal.timeout exists on Node 18+ and in the browser; never let its
  // absence be the reason a price cannot be fetched.
  try {
    return AbortSignal.timeout(timeoutMs);
  } catch {
    return undefined;
  }
}

/**
 * THE ENTIRE OUTBOUND FOOTPRINT OF THIS APP.
 *
 * This app pulls and never pushes, and this is the request that does the
 * pulling. Everything about it is deliberate:
 *
 *   - GET, with no body. There is nothing to send.
 *   - The URL is a compile-time constant made of coin ids. It carries no asset
 *     id, no quantity, no value, no symbol the user picked, no timestamp — the
 *     same string goes out whether the owner holds 0.01 BTC or 100, so the
 *     request reveals nothing about the ledger, not even which holdings exist.
 *   - `credentials: "omit"` — no cookies, no auth headers, ever.
 *   - `referrerPolicy: "no-referrer"` — otherwise a browser-side call would leak
 *     the local page URL (and any id in it) in a Referer header.
 *   - Exactly one request header, `accept`. Notably NO `user-agent` override:
 *     naming this app or its owner would be an identifier, and the default is
 *     the same generic runtime string every Node/browser client sends.
 *   - No API key, because there is none — which is also why this repo can be
 *     open-sourced with no secret to leak.
 */
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

/**
 * Fetch EVERY requested symbol in ONE request.
 *
 * Resolves — never rejects — with a quote per priceable symbol and an error per
 * symbol that could not be quoted, so a caller can price three holdings and
 * report the fourth as unpriceable without a second round trip.
 *
 * Symbols with no source cost no network at all: they are answered before the
 * request is built.
 */
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

  /** Only the symbols that could possibly need the network. */
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

  // ONE url, ONE request, every id — see COINGECKO_URL.
  const url = COINGECKO_URL;

  /** The same failure applies to every symbol that needed the request. */
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
    // 429 is its own code: "wait a minute" and "you are offline" are different
    // instructions, and a user given the wrong one wastes their time.
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

/**
 * Fetch one quote. Resolves — never rejects — with either a quote or a typed
 * error, so no caller can turn an outage into a $0 write or an unhandled throw.
 *
 * The request it makes is the batch one: the URL is identical whichever symbol
 * is asked for, so Next's fetch cache (and CoinGecko's edge cache) serve the
 * second symbol for free.
 */
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

// ---------------------------------------------------------------------------
// Quantity -> value
// ---------------------------------------------------------------------------

/**
 * Normalise a user-entered quantity into the provider's price unit.
 *
 * Every guard is EXPLICIT about null/undefined: a quantity of 0 is a real
 * quantity (an emptied wallet is worth $0.00), and treating it as "absent" is
 * exactly the falsy-zero bug that silently fell back to a typed value.
 */
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

  // An absent unit means "the natural unit for this holding": a legacy metals row
  // can have `unit` NULL, and a coin count needs no unit at all.
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

/**
 * quantity x price -> integer cents.
 *
 * THE MONEY BOUNDARY. A weight/coin count is fractional and a feed price is a
 * float, so their product is rounded to the nearest cent exactly once — here,
 * via `parseAmount`. Everything downstream is integer cents.
 */
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

/**
 * Fetch a price and value a holding with it, in one call.
 *
 * The quantity is validated BEFORE the network is touched, so a typo cannot
 * cause a request, and a failure never yields a value at all — the caller gets
 * an error it has to handle, which is what keeps a $0 out of the database.
 */
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

/**
 * Value a holding against a quote already in hand — the batch path.
 *
 * Same guards as `fetchHoldingValueCents`, minus the fetch, so a caller that has
 * fetched every price in one request can value N holdings without N requests.
 */
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

/**
 * Parse a form field into a quantity without ever producing NaN or treating "0"
 * as absent. `null` means the field was genuinely empty.
 */
export function readQuantityField(raw: unknown): { present: false } | { present: true; value: number } {
  if (raw === null || raw === undefined) return { present: false };
  const text = String(raw).trim();
  if (text === "") return { present: false };
  return { present: true, value: Number(text) };
}
