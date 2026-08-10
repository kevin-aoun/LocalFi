"use server";

/**
 * Quote and persist symbol-priced holdings. Price lookup finishes before the DB
 * write; an unavailable or malformed quote leaves the stored value untouched.
 */

import { eq } from "drizzle-orm";

import { readDb, withDb } from "@/lib/db/client";
import { assets } from "@/lib/db/schema";
import {
  ensurePricedInstrument,
  findInstrument,
  findAssetOpeningChain,
  getExactPosition,
  observationDay,
  postAssetOpeningPosition,
  projectPositionHolding,
  recordInstrumentObservation,
} from "@/lib/investments";
import { tryParseAmount, type Cents } from "@/lib/money";
import { revalidate } from "@/lib/revalidate";
import {
  PRICED_HOLDINGS,
  describePriceError,
  fetchHoldingValueCents,
  fetchPriceQuote,
  fetchPriceQuotes,
  holdingValueFromQuotes,
  priceableSymbols,
  pricedHolding,
  quantityInPriceUnits,
  readQuantityField,
  type PriceError,
  type PriceQuote,
  type PriceResult,
  type PriceSymbol,
  type PricedHoldingSpec,
} from "@/lib/prices";

/** A batch of already-fetched prices, so N holdings cost ONE request. */
type PriceBatch = {
  quotes: ReadonlyMap<PriceSymbol, PriceQuote>;
  errors: ReadonlyMap<string, PriceError>;
};

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/**
 * Live price for any symbol the app knows — all of them from CoinGecko.
 *
 * Returns a typed result, never a bare number and never a silent 0, so the caller
 * can tell the user exactly what went wrong: offline, rate-limited (429, its own
 * code, because "wait a minute" is not "check your connection"), or a symbol with
 * no price source at all. It never throws: being offline is an expected state for
 * an offline-first app, not an exception.
 *
 * A successful quote carries its own provenance — `quote.proxy` and
 * `quote.sourceLabel` — so a view cannot render the number without having the
 * disclosure in hand. Gold and silver are proxy prices.
 */
export async function getLivePriceQuote(symbol: string): Promise<PriceResult> {
  return fetchPriceQuote(symbol);
}

// ---------------------------------------------------------------------------
// Writing a live-priced holding
// ---------------------------------------------------------------------------

type HoldingFields = {
  spec: PricedHoldingSpec;
  quantity: number;
  unit: string;
  currency: string;
  notes: string | null;
};

type ActionResult<T> = { success: true; data: T } | { error: string };

function fieldText(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw : null;
}

/** Validate before network or database work; zero is a present quantity. */
function readHoldingFields(formData: FormData): HoldingFields | { error: string } {
  const rawSymbol = fieldText(formData, "priceSymbol");
  const spec = pricedHolding(rawSymbol);
  if (!spec) {
    return {
      error:
        `There is no live price feed for "${rawSymbol ?? ""}". ` +
        `Pick ${priceableSymbols.map((s) => PRICED_HOLDINGS[s].label).join(", ")}.`,
    };
  }

  // Unpriceable holdings retain their stored observation rather than becoming zero.
  if (spec.coinGeckoId === null) {
    return {
      error: describePriceError({
        code: "no_price_source",
        symbol: spec.symbol,
        provider: null,
        message: spec.noSourceReason ?? "no price source.",
      }),
    };
  }

  const rawQuantity = fieldText(formData, "quantity");
  const quantity = readQuantityField(rawQuantity);
  if (!quantity.present) {
    return { error: "Enter a quantity before enabling live pricing." };
  }
  if (!Number.isFinite(quantity.value)) {
    return { error: `"${(rawQuantity ?? "").trim()}" is not a valid quantity.` };
  }
  if (quantity.value < 0) {
    return { error: "A quantity cannot be negative." };
  }

  // The price registry remains the authority for incompatible units.
  const rawUnit = (fieldText(formData, "unit") ?? "").trim().toLowerCase();
  const unit = (spec.units as readonly string[]).includes(rawUnit) ? rawUnit : spec.defaultUnit;

  // DECISION: DEC-004 — every provider result in lib/prices is quoted in USD.
  // Never accept a caller-supplied denomination for that number.
  const currency = "USD";
  const notes = fieldText(formData, "notes");

  return {
    spec,
    quantity: quantity.value,
    unit,
    currency,
    notes: notes && notes.trim() !== "" ? notes : null,
  };
}

/** Fetch before taking the database lock; failures produce no writes. */
async function priceHolding(fields: HoldingFields, batch?: PriceBatch) {
  const valued = batch
    ? holdingValueFromQuotes(
        fields.spec.symbol,
        fields.quantity,
        fields.unit,
        batch.quotes,
        batch.errors,
      )
    : await fetchHoldingValueCents(fields.spec.symbol, fields.quantity, fields.unit);

  if (!valued.ok) {
    return { error: describePriceError(valued.error) };
  }
  return valued;
}

function recordQuoteObservation(
  raw: Parameters<typeof recordInstrumentObservation>[0],
  instrumentId: string,
  quote: PriceQuote,
): { amountMinor: Cents; observedAt: number } {
  const amountMinor = tryParseAmount(String(quote.pricePerUnitUsd));
  if (amountMinor === null || amountMinor <= 0) {
    throw new Error("Provider quote could not be stored as integer minor units");
  }
  const observedAt = Math.floor(quote.fetchedAt / 1000);
  recordInstrumentObservation(raw, {
    instrumentId,
    observationKind: "price",
    observedDay: observationDay(observedAt),
    observedAt,
    amountMinor,
    currency: "USD",
    source: quote.provider,
  });
  return { amountMinor, observedAt };
}

/** Create a live-priced holding (BTC, ETH, or any metal), valued at the live price. */
export async function createLivePricedAsset(
  formData: FormData,
): Promise<ActionResult<typeof assets.$inferSelect>> {
  try {
    const fields = readHoldingFields(formData);
    if ("error" in fields) return fields;

    const priced = await priceHolding(fields);
    if ("error" in priced) return priced;

    const asset = await withDb(async (db, raw) => {
      // DECISION: DEC-013 — new holdings discover the symbol's canonical exact ID.
      // Imported per-asset identities remain separate and are handled by updates.
      const instrument = ensurePricedInstrument(raw, fields.spec.symbol);
      recordQuoteObservation(raw, instrument.id, priced.quote);
      const exactPosition = getExactPosition(raw, instrument.id, fields.currency);
      if (exactPosition) {
        const projection = projectPositionHolding(raw, instrument.id, fields.currency);
        const [projected] = await db.select().from(assets).where(eq(assets.id, projection.assetId));
        if (!projected) throw new Error("Projected holding could not be read back");
        return projected;
      }
      const [row] = await db
        .insert(assets)
        .values({
          // The category comes from the registry, not the form: a BTC holding
          // filed under "Commodities" would be a lie that the next refresh would
          // have to guess its way out of.
          category: fields.spec.assetCategory,
          currentValueCents: priced.valueCents,
          currency: fields.currency,
          instrumentId: instrument.id,
          notes: fields.notes,
          // Kept in sync for every consumer that still reads "Gold"; null for crypto.
          commodityType: fields.spec.commodityType,
          priceSymbol: fields.spec.symbol,
          quantity: fields.quantity,
          unit: fields.unit as (typeof assets.$inferInsert)["unit"],
          pricedAt: new Date(priced.quote.fetchedAt),
          useLivePrice: true,
        })
        .returning();
      const quantity = quantityInPriceUnits(fields.quantity, fields.unit, fields.spec);
      if (!quantity.ok) throw new Error(quantity.message);
      postAssetOpeningPosition(raw, {
        assetId: row.id,
        instrumentId: instrument.id,
        currency: fields.currency,
        quantity: String(quantity.quantity),
        bookAmountMinor: priced.valueCents,
        effectiveDate: observationDay(Math.floor(priced.quote.fetchedAt / 1000)),
        description: `Opening position for ${fields.spec.label}`,
        recordedAt: Math.floor(priced.quote.fetchedAt / 1000),
        source: "manual-live-holding",
      });
      const projection = projectPositionHolding(raw, instrument.id, fields.currency);
      const [projected] = await db.select().from(assets).where(eq(assets.id, projection.assetId));
      if (!projected) throw new Error("Opening-position projection could not be read back");
      return projected;
    });

    revalidate("/");
    return { success: true, data: asset };
  } catch (error) {
    console.error("Failed to create live-priced asset:", error);
    return { error: "Failed to save this holding." };
  }
}

/**
 * Re-price an existing holding (and/or change its quantity or symbol).
 *
 * If the price cannot be fetched, NOTHING is written: the stored value and the
 * `priced_at` stamp stay exactly as they were, so the UI can keep showing the
 * last known value and say that it is stale.
 */
export async function updateLivePricedAsset(
  id: number,
  formData: FormData,
): Promise<ActionResult<typeof assets.$inferSelect>> {
  return updateLivePricedAssetWith(id, formData);
}

/** Internal batch-aware implementation; quote maps are not server-action inputs. */
async function updateLivePricedAssetWith(
  id: number,
  formData: FormData,
  batch?: PriceBatch,
): Promise<ActionResult<typeof assets.$inferSelect>> {
  try {
    const existing = await readDb(async (db) => {
      const [row] = await db.select().from(assets).where(eq(assets.id, id));
      return row;
    });

    if (!existing) return { error: "That asset no longer exists." };
    if (existing.category === "Cash") {
      return { error: "Cash is calculated from your transactions and cannot be edited." };
    }

    const fields = readHoldingFields(formData);
    if ("error" in fields) return fields;

    const priced = await priceHolding(fields, batch);
    if ("error" in priced) return priced;

    const asset = await withDb(async (db, raw) => {
      const importedInstrument = existing.instrumentId
        ? findInstrument(raw, existing.instrumentId)
        : null;
      const instrument = importedInstrument?.symbol === fields.spec.symbol
        ? importedInstrument
        : ensurePricedInstrument(raw, fields.spec.symbol);
      recordQuoteObservation(raw, instrument.id, priced.quote);
      const opening = findAssetOpeningChain(raw, id);
      if (opening && (opening.instrumentId !== instrument.id || opening.currency !== fields.currency)) {
        throw new Error("A posted holding cannot change instrument or currency; create a new holding instead");
      }
      const exactPosition = getExactPosition(raw, instrument.id, fields.currency);
      // A scheduled refresh records a market observation only. Quantity and
      // opening book value are historical facts and must not be rewritten just
      // because a new quote arrived.
      if (batch && exactPosition) {
        const projection = projectPositionHolding(raw, instrument.id, fields.currency);
        const [projected] = await db.select().from(assets).where(eq(assets.id, projection.assetId));
        if (!projected) throw new Error("Projected holding could not be read back");
        return projected;
      }
      if (exactPosition && !opening) {
        const projection = projectPositionHolding(raw, instrument.id, fields.currency);
        const [projected] = await db.select().from(assets).where(eq(assets.id, projection.assetId));
        if (!projected) throw new Error("Projected holding could not be read back");
        return projected;
      }
      const [row] = await db
        .update(assets)
        .set({
          category: fields.spec.assetCategory,
          currentValueCents: priced.valueCents,
          currency: fields.currency,
          instrumentId: instrument.id,
          notes: fields.notes,
          commodityType: fields.spec.commodityType,
          priceSymbol: fields.spec.symbol,
          quantity: fields.quantity,
          unit: fields.unit as (typeof assets.$inferInsert)["unit"],
          pricedAt: new Date(priced.quote.fetchedAt),
          useLivePrice: true,
          updatedAt: new Date(),
        })
        .where(eq(assets.id, id))
        .returning();
      const quantity = quantityInPriceUnits(fields.quantity, fields.unit, fields.spec);
      if (!quantity.ok) throw new Error(quantity.message);
      postAssetOpeningPosition(raw, {
        assetId: row.id,
        instrumentId: instrument.id,
        currency: fields.currency,
        quantity: String(quantity.quantity),
        bookAmountMinor: priced.valueCents,
        effectiveDate: observationDay(Math.floor(priced.quote.fetchedAt / 1000)),
        description: `Opening position for ${fields.spec.label}`,
        recordedAt: Math.floor(priced.quote.fetchedAt / 1000),
        source: "manual-live-holding",
      });
      const projection = projectPositionHolding(raw, instrument.id, fields.currency);
      const [projected] = await db.select().from(assets).where(eq(assets.id, projection.assetId));
      if (!projected) throw new Error("Opening-position projection could not be read back");
      return projected;
    });

    revalidate("/");
    return { success: true, data: asset };
  } catch (error) {
    console.error("Failed to update live-priced asset:", error);
    return { error: "Failed to save this holding." };
  }
}

// ---------------------------------------------------------------------------
// Refresh every live-priced holding
// ---------------------------------------------------------------------------

/** Batch one quote request, then record observations sequentially without changing positions. */
export async function refreshLivePricedAssets(): Promise<{
  refreshed: number;
  skipped: number;
  /** Holdings whose symbol has no price source at all. Stored values KEPT. */
  unpriceable: Array<{ id: number; label: string; symbol: string; reason: string }>;
  failed: Array<{ id: number; label: string; error: string }>;
}> {
  const rows = await readDb((db) => db.select().from(assets));
  const live = rows.filter(
    (asset) =>
      asset.archived !== true &&
      (asset.useLivePrice === true || (asset.priceSymbol ?? "") !== ""),
  );

  let refreshed = 0;
  let skipped = 0;
  const unpriceable: Array<{ id: number; label: string; symbol: string; reason: string }> = [];
  const failed: Array<{ id: number; label: string; error: string }> = [];

  const labelOf = (asset: (typeof live)[number]) =>
    asset.notes?.trim() || asset.priceSymbol || asset.category;

  /** Which rows can be repriced at all — decided before any network call. */
  const candidates = live.filter((asset) => {
    const symbol = (asset.priceSymbol ?? "").trim();

    // A holding with no symbol or no quantity cannot be priced. That is not a
    // failure — it is a hand-valued holding, and its stored value stands.
    // `quantity` of exactly 0 IS priceable; only null/undefined is "absent".
    if (symbol === "" || asset.quantity === null || asset.quantity === undefined) {
      skipped += 1;
      return false;
    }

    // A real holding of a metal nothing can price. Never an error, never zeroed,
    // never silent: it is reported every run so the owner knows the figure is
    // whatever they last entered by hand.
    const spec = pricedHolding(symbol);
    if (spec !== null && spec.coinGeckoId === null) {
      unpriceable.push({
        id: asset.id,
        label: labelOf(asset),
        symbol: spec.symbol,
        reason: spec.noSourceReason ?? "no price source.",
      });
      return false;
    }
    return true;
  });

  if (candidates.length === 0) return { refreshed, skipped, unpriceable, failed };

  // THE ONLY OUTBOUND REQUEST THIS FUNCTION MAKES, for every symbol at once.
  const batch = await fetchPriceQuotes([
    ...new Set(candidates.map((asset) => (asset.priceSymbol ?? "").trim())),
  ]);

  for (const asset of candidates) {
    const label = labelOf(asset);
    const symbol = (asset.priceSymbol ?? "").trim();

    const formData = new FormData();
    formData.set("priceSymbol", symbol);
    formData.set("quantity", String(asset.quantity));
    if (asset.unit) formData.set("unit", asset.unit);
    formData.set("currency", "USD");
    if (asset.notes !== null && asset.notes !== undefined) formData.set("notes", asset.notes);
    const result = await updateLivePricedAssetWith(asset.id, formData, batch);
    if ("error" in result) {
      failed.push({ id: asset.id, label, error: result.error });
      continue;
    }
    refreshed += 1;
  }

  return { refreshed, skipped, unpriceable, failed };
}
