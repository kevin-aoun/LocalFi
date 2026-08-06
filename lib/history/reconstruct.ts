/**
 * Historical net-worth RECONSTRUCTION — what net worth WAS, day by day.
 *
 * ## This is not a snapshot, and the difference matters
 *
 * `snapshotNetWorth()` records TODAY's derived figures and refuses to file them
 * under a past date, which is correct: doing so would assert a net worth that was
 * never true. This module does the other thing — it COMPUTES the past:
 *
 *     net worth(D) = accounts at D          (exact: replay the ledger to D)
 *                  + Σ quantity × price(symbol, D) over holdings held at D
 *                  + hand-valued assets     (no price history: stored value, disclosed)
 *
 * The cash half is exact. The holdings half is an ESTIMATE (proxy prices, prices
 * carried across weekends, acquisition dates inferred where the ledger is silent),
 * so every row this produces is written with `source = 'reconstructed'` and a
 * `source_note` naming the estimate. A measured snapshot and an inferred one must
 * never be indistinguishable.
 *
 * ## Buying is a CONVERSION, not a gain
 *
 * An Investment-category transaction takes money out of the cash side while the
 * asset appears on the other side, so net worth is UNCHANGED on the purchase day
 * and only later price movement changes it. Concretely: if $3,800.00 leaves the
 * account and 2.0 oz appear at $1,900.00/oz, that day's net worth is identical to
 * the day before. `purchaseContinuity` measures exactly this and the test suite
 * asserts it is 0 cents — it is the whole point of the model.
 *
 * A non-zero residual is reported rather than smoothed away.
 *
 * ## What is reused, deliberately
 *
 * Nothing here re-implements the ledger rules. Pending rows, transfers, category
 * direction, opening balances, liabilities and the exclusion of the derived
 * "Cash" asset all come from `deriveNetWorth` in lib/cash-balance.ts. The
 * quantity → money boundary (one rounding, at the end) comes from
 * `holdingValueCents` in lib/prices.ts. This module only decides WHICH rows exist
 * on a given day and WHICH price to use.
 */
import {
  acquisitionSourceOf,
  resolveAcquisitions,
  type AcquisitionEvidence,
  type AcquisitionSource,
} from "@/lib/assets/acquisition";
import {
  deriveNetWorth,
  type CashLedgerCategory,
  type CashLedgerTransaction,
  type LedgerAccount,
} from "@/lib/cash-balance";
import { fromDateKey, isDateKey, toDateKey, type DateKey } from "@/lib/dates";
import { formatMoney, negateCents, sumCents, type Cents } from "@/lib/money";
import {
  holdingValueCents,
  priceSourceLabel,
  pricedHolding,
  type PriceQuote,
  type PriceSymbol,
} from "@/lib/prices";
import { HISTORICAL_PRICE_SOURCES, priceOn, type PriceSeries } from "./prices";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A ledger row already reduced to a calendar day (via lib/reports `toReportTransactions`). */
export type HistoryTransaction = CashLedgerTransaction & {
  id?: number;
  dateKey: DateKey;
  comment?: string | null;
};

export type HistoryCategory = CashLedgerCategory & { name: string };

/** The subset of an `assets` row this needs. `createdAt` is the fallback acquisition date. */
export type HistoryAsset = {
  id: number;
  category: string;
  currentValueCents: Cents;
  quantity?: number | null;
  unit?: string | null;
  priceSymbol?: string | null;
  notes?: string | null;
  linkedTransactionIds?: string | null;
  /** Unix seconds or a Date, as drizzle hands it back. */
  createdAt: Date | number;
};

// ---------------------------------------------------------------------------
// Holdings: what was held, and from when
// ---------------------------------------------------------------------------

/**
 * Re-exported, not redefined: the acquisition rule and its vocabulary live in
 * lib/assets/acquisition.ts, which is the single place that decides when an
 * asset was bought. This module only decides how to VALUE it once it exists.
 */
export type { AcquisitionSource, AcquisitionEvidence };

export type HoldingValuation =
  /** quantity × a historical price for the day. */
  | "priced"
  /** No price history: today's stored value, carried back. Always disclosed. */
  | "carried-stored-value";

export type HoldingPlan = {
  assetId: number;
  label: string;
  category: string;
  symbol: PriceSymbol | null;
  quantity: number | null;
  unit: string | null;
  storedValueCents: Cents;
  /** The first day this holding contributes anything. Before it: exactly 0. */
  acquiredOn: DateKey;
  /** Did the LEDGER date this, or only `assets.created_at`? */
  acquisitionSource: AcquisitionSource;
  /** WHICH rule dated it: an explicit link, an inference, or the fallback. */
  acquisitionEvidence: AcquisitionEvidence;
  /** The transaction that dated the acquisition, when there was one. */
  acquisitionTxId: number | null;
  /** What the ledger says was paid, when there was a purchase transaction. */
  acquisitionCostCents: Cents | null;
  /** The one-sentence explanation from lib/assets/acquisition.ts. */
  acquisitionExplanation: string;
  valuation: HoldingValuation;
  /** Why the valuation is what it is — surfaced in the report and the note. */
  valuationReason: string;
};

function labelFor(asset: HistoryAsset, symbol: PriceSymbol | null): string {
  const spec = symbol ? pricedHolding(symbol) : null;
  const name = spec?.label ?? asset.notes?.trim() ?? asset.category;
  return `${name} (#${asset.id})`;
}

/**
 * When each holding started existing, and how it can be valued.
 *
 * ### Dating an acquisition
 *
 * NOT decided here. `resolveAcquisitions` in lib/assets/acquisition.ts owns the
 * precedence (explicit link → inferred ledger match, refused when ambiguous →
 * `assets.created_at` as a labelled fallback) and the live net-worth path reads
 * the same function. This module used to carry its own copy of that logic; two
 * definitions of "when was this bought" is exactly the drift that makes a chart
 * and a headline figure disagree about the past.
 *
 * What IS decided here is how a holding can be VALUED once it exists: priced
 * from a daily series, or carried at its stored value and disclosed.
 */
export function resolveHoldings(
  assets: readonly HistoryAsset[],
  transactions: readonly HistoryTransaction[],
  categories: readonly HistoryCategory[],
  seriesBySymbol: ReadonlyMap<PriceSymbol, PriceSeries>,
): { holdings: HoldingPlan[]; excluded: HistoryAsset[] } {
  const excluded: HistoryAsset[] = [];
  // The derived "Cash" row is computed from the same ledger the accounts are, so
  // counting it here would double the user's cash. deriveNetWorth drops it too.
  const counted = assets.filter((asset) => {
    if (asset.category === "Cash") {
      excluded.push(asset);
      return false;
    }
    return true;
  });

  const acquisitions = resolveAcquisitions(counted, transactions, categories);

  const holdings = counted.map((asset): HoldingPlan => {
    const rawSymbol = asset.priceSymbol ?? null;
    const spec = pricedHolding(rawSymbol);
    const symbol = spec?.symbol ?? null;

    // --- when did it start existing? One answer, resolved in one place.
    const acquisition = acquisitions.get(asset.id);
    if (!acquisition) {
      // resolveAcquisitions returns an entry for every non-Cash asset, and Cash
      // rows were filtered out above. Reaching this means the two disagree about
      // what "counted" means, which must fail loudly rather than default a date.
      throw new Error(`No acquisition resolved for asset ${asset.id} (${asset.category})`);
    }
    const acquiredOn = acquisition.acquiredOn;
    const acquisitionSource = acquisitionSourceOf(acquisition.evidence);
    const acquisitionTxId = acquisition.transactionId;
    const acquisitionCostCents = acquisition.costCents;

    // --- how can it be valued?
    const hasQuantity =
      asset.quantity !== null && asset.quantity !== undefined && Number.isFinite(asset.quantity);
    let valuation: HoldingValuation = "carried-stored-value";
    let valuationReason: string;

    if (symbol === null) {
      valuationReason = `hand-valued: no price symbol, so ${formatMoney(asset.currentValueCents)} is carried unchanged`;
    } else if (!hasQuantity) {
      valuationReason = `${symbol} has no quantity on the asset row, so its stored value is carried unchanged`;
    } else if (!seriesBySymbol.has(symbol)) {
      valuationReason =
        HISTORICAL_PRICE_SOURCES[symbol] === null
          ? `${symbol} has no keyless daily price history, so its stored value is carried unchanged`
          : `${symbol} price history was not loaded, so its stored value is carried unchanged`;
    } else {
      valuation = "priced";
      const source = seriesBySymbol.get(symbol)!.source;
      valuationReason = source.proxy
        ? `${symbol} priced via the ${source.coinGeckoId} proxy series`
        : `${symbol} priced from the ${source.coinGeckoId} daily series`;
    }

    return {
      assetId: asset.id,
      label: labelFor(asset, symbol),
      category: asset.category,
      symbol,
      quantity: hasQuantity ? (asset.quantity as number) : null,
      unit: asset.unit ?? null,
      storedValueCents: asset.currentValueCents,
      acquiredOn,
      acquisitionSource,
      acquisitionEvidence: acquisition.evidence,
      acquisitionTxId,
      acquisitionCostCents,
      acquisitionExplanation: acquisition.explanation,
      valuation,
      valuationReason,
    };
  });

  return { holdings, excluded };
}

// ---------------------------------------------------------------------------
// The series
// ---------------------------------------------------------------------------

export type HoldingDayValue = {
  assetId: number;
  label: string;
  symbol: PriceSymbol | null;
  /** False before the acquisition day: the holding contributes exactly 0, not its value. */
  held: boolean;
  valueCents: Cents;
  priceUsd: number | null;
  /** The day the price came from; differs from the row's day when carried forward. */
  priceAsOfKey: DateKey | null;
  priceCarriedForward: boolean;
  basis: HoldingValuation | "not-held";
};

export type ReconstructedDay = {
  dateKey: DateKey;
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
  /** The exact half: accounts + unassigned ledger − liabilities. */
  accountsCents: Cents;
  /** The estimated half: everything the holdings were worth that day. */
  holdingsCents: Cents;
  holdings: HoldingDayValue[];
  /** Why this day is an estimate. Stored verbatim in `source_note`. */
  sourceNote: string;
};

export type ReconstructionWarning = { code: string; message: string };

/** The purchase-day continuity check — the property the model exists to have. */
export type PurchaseContinuity = {
  assetId: number;
  label: string;
  dateKey: DateKey;
  /** What the ledger says left the account. */
  paidCents: Cents;
  /** What the reconstruction says appeared on the other side. */
  valuedCents: Cents;
  /** valued − paid. 0 means the purchase day shows no jump at all. */
  residualCents: Cents;
};

export type ReconstructionErrorCode =
  | "bad_range"
  | "no_price_for_day"
  | "no_history_source";

export type ReconstructionError = {
  code: ReconstructionErrorCode;
  message: string;
};

export type ReconstructionResult =
  | {
      ok: true;
      days: ReconstructedDay[];
      holdings: HoldingPlan[];
      continuity: PurchaseContinuity[];
      warnings: ReconstructionWarning[];
    }
  | { ok: false; error: ReconstructionError };

export type ReconstructInput = {
  accounts: readonly LedgerAccount[];
  transactions: readonly HistoryTransaction[];
  categories: readonly HistoryCategory[];
  assets: readonly HistoryAsset[];
  seriesBySymbol: ReadonlyMap<PriceSymbol, PriceSeries>;
  fromKey: DateKey;
  toKey: DateKey;
  /**
   * When a priced holding has no usable price for a day it was held, carry its
   * STORED (present-day) value instead of failing. Off by default, because that
   * is asserting a past value from a present figure — the very thing this module
   * exists to avoid. On, every affected day says so in its note.
   */
  carryUnpriced?: boolean;
};

/** Every calendar day from `fromKey` to `toKey`, inclusive. Local arithmetic only. */
export function eachDay(fromKey: DateKey, toKey: DateKey): DateKey[] {
  if (!isDateKey(fromKey)) throw new Error(`Invalid fromKey: ${String(fromKey)}`);
  if (!isDateKey(toKey)) throw new Error(`Invalid toKey: ${String(toKey)}`);
  const days: DateKey[] = [];
  let cursor = fromDateKey(fromKey);
  const end = fromDateKey(toKey);
  while (cursor.getTime() <= end.getTime()) {
    days.push(toDateKey(cursor));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }
  return days;
}

/** A synthetic quote so the quantity → cents boundary stays in lib/prices.ts. */
function quoteFor(symbol: PriceSymbol, priceUsd: number): PriceQuote {
  const spec = pricedHolding(symbol)!;
  if (spec.provider === null) {
    // A symbol with no provider also has no daily series, so nothing should ever
    // reach this line. If something does, the registry and the history sources
    // have drifted apart — fail loudly rather than invent a provider name.
    throw new Error(`${symbol} has no price provider, so it cannot be valued historically`);
  }
  return {
    symbol: spec.symbol,
    label: spec.label,
    provider: spec.provider,
    pricePerUnitUsd: priceUsd,
    priceUnit: spec.priceUnit,
    proxy: spec.proxy,
    sourceLabel: priceSourceLabel(spec.symbol),
    fetchedAt: 0,
  };
}

/**
 * Reconstruct one day's net worth for one holding.
 * Returns the error rather than a value when the day cannot be priced.
 */
function valueHolding(
  plan: HoldingPlan,
  dateKey: DateKey,
  seriesBySymbol: ReadonlyMap<PriceSymbol, PriceSeries>,
  carryUnpriced: boolean,
): { ok: true; value: HoldingDayValue } | { ok: false; error: ReconstructionError } {
  const base = { assetId: plan.assetId, label: plan.label, symbol: plan.symbol };

  if (dateKey < plan.acquiredOn) {
    return {
      ok: true,
      value: {
        ...base,
        held: false,
        valueCents: 0,
        priceUsd: null,
        priceAsOfKey: null,
        priceCarriedForward: false,
        basis: "not-held",
      },
    };
  }

  if (plan.valuation === "carried-stored-value" || plan.symbol === null) {
    return {
      ok: true,
      value: {
        ...base,
        held: true,
        valueCents: plan.storedValueCents,
        priceUsd: null,
        priceAsOfKey: null,
        priceCarriedForward: false,
        basis: "carried-stored-value",
      },
    };
  }

  const series = seriesBySymbol.get(plan.symbol);
  const lookup = series ? priceOn(series, dateKey) : null;

  if (!lookup) {
    if (!carryUnpriced) {
      const firstPriced = series ? series.firstKey : "(none)";
      return {
        ok: false,
        error: {
          code: "no_price_for_day",
          message:
            `${plan.label} was held on ${dateKey} but the ${plan.symbol} price history starts on ` +
            `${firstPriced}: the keyless CoinGecko tier serves at most 365 days. Nothing was written. ` +
            `Re-run with a later --from, or with --carry-unpriced to carry the stored value and mark it.`,
        },
      };
    }
    return {
      ok: true,
      value: {
        ...base,
        held: true,
        valueCents: plan.storedValueCents,
        priceUsd: null,
        priceAsOfKey: null,
        priceCarriedForward: false,
        basis: "carried-stored-value",
      },
    };
  }

  const valued = holdingValueCents(quoteFor(plan.symbol, lookup.priceUsd), plan.quantity, plan.unit);
  if (!valued.ok) {
    return {
      ok: false,
      error: {
        code: "no_price_for_day",
        message: `${plan.label} could not be valued on ${dateKey}: ${valued.error.message}`,
      },
    };
  }

  return {
    ok: true,
    value: {
      ...base,
      held: true,
      valueCents: valued.valueCents,
      priceUsd: lookup.priceUsd,
      priceAsOfKey: lookup.asOfKey,
      priceCarriedForward: lookup.carriedForward,
      basis: "priced",
    },
  };
}

/** The per-day disclosure. Short, specific, and true for THAT day. */
function noteFor(dayHoldings: readonly HoldingDayValue[], plans: ReadonlyMap<number, HoldingPlan>): string {
  const parts: string[] = ["reconstructed from the ledger"];
  for (const holding of dayHoldings) {
    if (!holding.held) continue;
    const plan = plans.get(holding.assetId);
    if (!plan) continue;
    if (holding.basis === "carried-stored-value") {
      parts.push(`${plan.label}: ${plan.valuationReason}`);
      continue;
    }
    const source = holding.symbol ? HISTORICAL_PRICE_SOURCES[holding.symbol] : null;
    const via = source?.proxy ? `${holding.symbol} via ${source.coinGeckoId} proxy` : `${holding.symbol}`;
    parts.push(
      holding.priceCarriedForward
        ? `${via} price carried forward from ${holding.priceAsOfKey}`
        : `${via} priced on ${holding.priceAsOfKey}`,
    );
    if (plan.acquisitionSource === "asset_created_at") {
      parts.push(`${holding.symbol ?? plan.label} held from assets.created_at (no purchase transaction)`);
    }
  }
  return parts.join("; ");
}

/**
 * The whole series, or a typed error and NOTHING — a reconstruction that cannot
 * price a day it needs must fail before a single row is written.
 */
export function reconstructNetWorthSeries(input: ReconstructInput): ReconstructionResult {
  const {
    accounts,
    transactions,
    categories,
    assets,
    seriesBySymbol,
    fromKey,
    toKey,
    carryUnpriced = false,
  } = input;

  if (!isDateKey(fromKey) || !isDateKey(toKey)) {
    return {
      ok: false,
      error: { code: "bad_range", message: `Invalid range: ${String(fromKey)}..${String(toKey)}` },
    };
  }
  if (fromKey > toKey) {
    return {
      ok: false,
      error: { code: "bad_range", message: `Range runs backwards: ${fromKey} is after ${toKey}` },
    };
  }

  const { holdings } = resolveHoldings(assets, transactions, categories, seriesBySymbol);
  const plansById = new Map(holdings.map((h) => [h.assetId, h]));
  const warnings: ReconstructionWarning[] = [];

  for (const plan of holdings) {
    if (plan.valuation === "carried-stored-value") {
      warnings.push({
        code: "carried_stored_value",
        message:
          `${plan.label}: ${plan.valuationReason}. Every day it is held shows today's figure, ` +
          `not a historical one.`,
      });
    }
    if (plan.acquisitionSource === "asset_created_at") {
      warnings.push({
        code: "acquisition_from_created_at",
        message: `${plan.label}: ${plan.acquisitionExplanation}`,
      });
    }
    const source = plan.symbol ? HISTORICAL_PRICE_SOURCES[plan.symbol] : null;
    if (plan.valuation === "priced" && source?.proxy) {
      warnings.push({ code: "proxy_price", message: `${plan.label}: ${source.note}.` });
    }
  }

  // Ledger rows, earliest first, so each day can take a prefix of them.
  const ordered = [...transactions].sort((a, b) =>
    a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0,
  );

  const days: ReconstructedDay[] = [];
  const carriedPriceDays = new Map<PriceSymbol, number>();
  let cursor = 0;

  for (const dateKey of eachDay(fromKey, toKey)) {
    while (cursor < ordered.length && ordered[cursor].dateKey <= dateKey) cursor++;
    const upToToday = ordered.slice(0, cursor);

    const dayHoldings: HoldingDayValue[] = [];
    for (const plan of holdings) {
      const valued = valueHolding(plan, dateKey, seriesBySymbol, carryUnpriced);
      if (!valued.ok) return { ok: false, error: valued.error };
      if (valued.value.priceCarriedForward && valued.value.symbol) {
        carriedPriceDays.set(valued.value.symbol, (carriedPriceDays.get(valued.value.symbol) ?? 0) + 1);
      }
      dayHoldings.push(valued.value);
    }

    // Both halves of the acquisition rule are applied, on purpose. `valueHolding`
    // has already zeroed anything not yet held, and `deriveNetWorth` is ALSO
    // told the acquisition dates and the day. They must agree — a day where they
    // did not would mean the chart and the live figure had drifted apart, which
    // is the exact failure this refactor exists to prevent.
    const worth = deriveNetWorth({
      accounts,
      transactions: upToToday,
      categories,
      asOfKey: dateKey,
      standaloneAssets: dayHoldings.map((h) => {
        const plan = plansById.get(h.assetId);
        return {
          id: h.assetId,
          category: plan?.category ?? "Other",
          // Not-yet-held holdings are already valued at 0 cents by valueHolding.
          currentValueCents: h.valueCents,
          acquiredOn: plan?.acquiredOn ?? null,
          acquisitionEvidence: plan?.acquisitionEvidence ?? null,
        };
      }),
    });

    const holdingsCents = sumCents(dayHoldings.map((h) => h.valueCents));

    days.push({
      dateKey,
      totalAssetsCents: worth.totalAssetsCents,
      totalLiabilitiesCents: worth.totalLiabilitiesCents,
      netWorthCents: worth.netWorthCents,
      accountsCents: sumCents([worth.netWorthCents, negateCents(holdingsCents)]),
      holdingsCents,
      holdings: dayHoldings,
      sourceNote: noteFor(dayHoldings, plansById),
    });
  }

  for (const [symbol, count] of carriedPriceDays) {
    warnings.push({
      code: "price_carried_forward",
      message:
        `${symbol}: ${count} day(s) in this range had no price point of their own (weekends, ` +
        `provider gaps) and reuse the last known close. Nothing is interpolated.`,
    });
  }

  return {
    ok: true,
    days,
    holdings,
    continuity: measureContinuity(holdings, days),
    warnings,
  };
}

/**
 * The property that makes this model correct: on the day a holding is bought,
 * cash falls by the price paid and the holding appears worth the same amount, so
 * NET WORTH DOES NOT MOVE. `residualCents` is the size of the step the purchase
 * day shows; 0 means perfectly continuous.
 */
export function measureContinuity(
  holdings: readonly HoldingPlan[],
  days: readonly ReconstructedDay[],
): PurchaseContinuity[] {
  const byKey = new Map(days.map((d) => [d.dateKey, d]));
  const out: PurchaseContinuity[] = [];

  for (const plan of holdings) {
    if (plan.acquisitionSource !== "ledger" || plan.acquisitionCostCents === null) continue;
    const day = byKey.get(plan.acquiredOn);
    if (!day) continue;
    const valued = day.holdings.find((h) => h.assetId === plan.assetId);
    if (!valued) continue;
    out.push({
      assetId: plan.assetId,
      label: plan.label,
      dateKey: plan.acquiredOn,
      paidCents: plan.acquisitionCostCents,
      valuedCents: valued.valueCents,
      residualCents: sumCents([valued.valueCents, negateCents(plan.acquisitionCostCents)]),
    });
  }

  return out;
}
