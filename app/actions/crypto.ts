"use server";

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

type PriceBatch = {
  quotes: ReadonlyMap<PriceSymbol, PriceQuote>;
  errors: ReadonlyMap<string, PriceError>;
};

export async function getLivePriceQuote(symbol: string): Promise<PriceResult> {
  return fetchPriceQuote(symbol);
}

type HoldingFields = {
  spec: PricedHoldingSpec;
  quantity: number;
  unit: string;
  currency: string;
  notes: string | null;
  paidAmountCents: Cents | null;
};

type ActionResult<T> = { success: true; data: T } | { error: string };

function fieldText(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw : null;
}

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


  const rawUnit = (fieldText(formData, "unit") ?? "").trim().toLowerCase();
  const unit = (spec.units as readonly string[]).includes(rawUnit) ? rawUnit : spec.defaultUnit;



  const currency = "USD";
  const notes = fieldText(formData, "notes");
  const rawPaidAmount = fieldText(formData, "paidAmount");
  const paidAmountCents = rawPaidAmount === null || rawPaidAmount.trim() === ""
    ? null
    : tryParseAmount(rawPaidAmount);
  if (rawPaidAmount !== null && rawPaidAmount.trim() !== "" && paidAmountCents === null) {
    return { error: `"${rawPaidAmount.trim()}" is not a valid paid amount.` };
  }
  if (paidAmountCents !== null && paidAmountCents < 0) {
    return { error: "The paid amount cannot be negative." };
  }

  return {
    spec,
    quantity: quantity.value,
    unit,
    currency,
    notes: notes && notes.trim() !== "" ? notes : null,
    paidAmountCents,
  };
}


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


export async function createLivePricedAsset(
  formData: FormData,
): Promise<ActionResult<typeof assets.$inferSelect>> {
  try {
    const fields = readHoldingFields(formData);
    if ("error" in fields) return fields;
    if (fields.spec.assetCategory === "Crypto" && fields.paidAmountCents === null) {
      return { error: "Enter what you paid for this coin." };
    }

    const priced = await priceHolding(fields);
    if ("error" in priced) return priced;

    const asset = await withDb(async (db, raw) => {


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
        })
        .returning();
      const quantity = quantityInPriceUnits(fields.quantity, fields.unit, fields.spec);
      if (!quantity.ok) throw new Error(quantity.message);
      postAssetOpeningPosition(raw, {
        assetId: row.id,
        instrumentId: instrument.id,
        currency: fields.currency,
        quantity: String(quantity.quantity),
        bookAmountMinor: fields.paidAmountCents ?? priced.valueCents,
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


export async function updateLivePricedAsset(
  id: number,
  formData: FormData,
): Promise<ActionResult<typeof assets.$inferSelect>> {
  return updateLivePricedAssetWith(id, formData);
}


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
        bookAmountMinor: fields.paidAmountCents ?? exactPosition?.bookAmountMinor ?? priced.valueCents,
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






export async function refreshLivePricedAssets(): Promise<{
  refreshed: number;
  skipped: number;

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


  const candidates = live.filter((asset) => {
    const symbol = (asset.priceSymbol ?? "").trim();




    if (symbol === "" || asset.quantity === null || asset.quantity === undefined) {
      skipped += 1;
      return false;
    }




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
