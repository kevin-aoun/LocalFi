"use server";

import { readDb, withDb } from "@/lib/db/client";
import { assets } from "@/lib/db/schema";
import { asc, eq } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";
import { calculateCommodityValue } from "./commodities";
import { negateCents, sumCents, tryParseAmount, type Cents } from "@/lib/money";
import { normalizeLedgerCurrency } from "@/lib/cash-balance";
import {
  createManualInstrument,
  deleteAssetOpeningPosition,
  ensurePricedInstrument,
  findAssetOpeningChain,
  findInstrument,
  getExactPosition,
  observationDay,
  postAssetOpeningPosition,
  projectPositionHolding,
  recordInstrumentObservation,
} from "@/lib/investments";
import {
  GRAMS_PER_TROY_OUNCE,
  priceSymbolForCommodityType,
  pricedHolding,
  quantityInPriceUnits,
} from "@/lib/prices";
import { readPositionHistory } from "@/lib/ledger";

export async function getAssets(options?: { includeArchived?: boolean }) {
  const includeArchived = options?.includeArchived === true;
  return readDb(async (db, raw) => {
    const query = db.select().from(assets);
    const rows = await (includeArchived
      ? query.orderBy(asc(assets.id))
      : query.where(eq(assets.archived, false)).orderBy(asc(assets.id)));
    return rows.map((asset) => {
      const position = asset.category === "Crypto" && asset.instrumentId
        ? getExactPosition(raw, asset.instrumentId, asset.currency)
        : null;
      const costBasisCents = position?.bookAmountMinor as Cents | undefined;
      return {
        ...asset,
        quantityExact: position?.quantity ?? null,
        costBasisCents: costBasisCents ?? null,
        profitLossCents: costBasisCents === undefined
          ? null
          : sumCents([asset.currentValueCents, negateCents(costBasisCents)]),
      };
    });
  });
}

const INVESTMENT_CATEGORIES = new Set(["Investments", "Crypto", "Commodities"]);

export type InvestmentHistoryRow = {
  assetId: number;
  dateKey: string;
  valueCents: Cents;
  category: string;
  currency: string;
  label: string;
};

export async function getInvestmentHistory(): Promise<InvestmentHistoryRow[]> {
  const rows = await readDb((_db, raw) => readPositionHistory(raw));

  return rows
    .filter((row) => row.assetId !== null && INVESTMENT_CATEGORIES.has(row.category))
    .map((row) => ({
      assetId: row.assetId!,
      dateKey: row.dateKey,
      valueCents: row.valueMinor as Cents,
      category: row.category,
      currency: row.currency,
      label: row.label,
    }));
}

type AssetCategory =
  | "Cash"
  | "Savings"
  | "Investments"
  | "Crypto"
  | "Properties"
  | "Vehicles"
  | "Commodities"
  | "Other";

type AssetFields = {
  category: AssetCategory;
  currency: string;
  notes: string | null;
  commodityType: "Gold" | "Silver" | "Platinum" | "Palladium" | null;

  quantity: number | null;
  unit: "oz" | "grams" | null;
  useLivePrice: boolean;

  rawCurrentValue: string | null;
};

function observationNow() {
  const observedAt = Math.floor(Date.now() / 1000);
  return { observedAt, observedDay: observationDay(observedAt) };
}

function manualInstrumentLabel(fields: AssetFields): string {
  return fields.notes?.trim() || fields.commodityType || fields.category;
}

function legacyCommodityUnitPrice(fields: AssetFields, valueCents: Cents): Cents | null {
  if (fields.quantity === null || fields.quantity === 0) return null;
  const quantityOz = fields.unit === "grams"
    ? fields.quantity / GRAMS_PER_TROY_OUNCE
    : fields.quantity;
  if (!Number.isFinite(quantityOz) || quantityOz <= 0) return null;
  const unitPrice = Math.round(valueCents / quantityOz);
  return Number.isSafeInteger(unitPrice) && unitPrice > 0 ? (unitPrice as Cents) : null;
}

function openingQuantity(fields: AssetFields, liveSymbol: string | null): string {
  if (liveSymbol === null) return "1";
  const spec = pricedHolding(liveSymbol);
  if (!spec) throw new Error(`Unsupported opening instrument ${liveSymbol}`);
  const converted = quantityInPriceUnits(fields.quantity, fields.unit, spec);
  if (!converted.ok) throw new Error(converted.message);
  return String(converted.quantity);
}

function readFields(formData: FormData): AssetFields {
  const rawQuantity = formData.get("quantity");
  const quantityText = typeof rawQuantity === "string" ? rawQuantity.trim() : "";

  return {
    category: formData.get("category") as AssetCategory,
    currency: normalizeLedgerCurrency(formData.get("currency"), "USD"),
    notes: (formData.get("notes") as string) || null,
    commodityType: formData.get("commodityType")
      ? (formData.get("commodityType") as "Gold" | "Silver" | "Platinum" | "Palladium")
      : null,


    quantity: quantityText === "" ? null : Number(quantityText),
    unit: formData.get("unit") ? (formData.get("unit") as "oz" | "grams") : null,
    useLivePrice: formData.get("useLivePrice") === "true",
    rawCurrentValue: typeof formData.get("currentValue") === "string"
      ? (formData.get("currentValue") as string)
      : null,
  };
}


async function resolveCurrentValue(
  fields: AssetFields,
): Promise<{ valueCents: Cents } | { error: string }> {
  const wantsLivePrice = fields.category === "Commodities" && fields.useLivePrice;

  if (wantsLivePrice) {
    if (!fields.commodityType) {
      return { error: "Choose a commodity type before enabling live pricing." };
    }
    if (fields.quantity === null) {
      return { error: "Enter a quantity before enabling live pricing." };
    }
    if (!Number.isFinite(fields.quantity)) {
      return { error: `"${fields.quantity}" is not a valid quantity.` };
    }

    const liveValueCents = await calculateCommodityValue(
      fields.commodityType,
      fields.quantity,
      fields.unit ?? "oz",
    );
    if (liveValueCents === null) {
      return {
        error:
          `Could not fetch a live ${fields.commodityType} price right now, so nothing was saved. ` +
          `Try again, or turn off Live Price and enter the value manually.`,
      };
    }
    return { valueCents: liveValueCents };
  }

  const parsed = tryParseAmount(fields.rawCurrentValue);
  if (parsed === null) {
    return {
      error:
        fields.rawCurrentValue === null || fields.rawCurrentValue.trim() === ""
          ? "Enter a current value."
          : `"${fields.rawCurrentValue}" is not a valid amount.`,
    };
  }
  return { valueCents: parsed };
}

export async function createAsset(formData: FormData) {
  try {
    const fields = readFields(formData);


    if (fields.category === "Cash") {
      return { error: "Cash is calculated from your transactions and cannot be added by hand." };
    }

    const resolved = await resolveCurrentValue(fields);
    if ("error" in resolved) return resolved;


    const currency =
      fields.category === "Commodities" && fields.useLivePrice ? "USD" : fields.currency;

    const asset = await withDb(async (db, raw) => {


      const liveSymbol =
        fields.category === "Commodities" && fields.useLivePrice
          ? priceSymbolForCommodityType(fields.commodityType)
          : null;
      const instrument = liveSymbol
        ? ensurePricedInstrument(raw, liveSymbol)
        : createManualInstrument(raw, {
            label: manualInstrumentLabel(fields),
            category: fields.category,
            currency,
          });
      const observed = observationNow();
      const liveUnitPrice = liveSymbol ? legacyCommodityUnitPrice(fields, resolved.valueCents) : null;
      if (liveUnitPrice !== null) {
        recordInstrumentObservation(raw, {
          instrumentId: instrument.id,
          observationKind: "price",
          ...observed,
          amountMinor: liveUnitPrice,
          currency,
          source: instrument.priceSource,
        });
      } else if (!liveSymbol) {
        recordInstrumentObservation(raw, {
          instrumentId: instrument.id,
          observationKind: "valuation",
          ...observed,
          amountMinor: resolved.valueCents,
          currency,
          source: "manual",
        });
      }
      const [row] = await db
        .insert(assets)
        .values({
          category: fields.category,
          currentValueCents: resolved.valueCents,
          currency,
          instrumentId: instrument.id,
          notes: fields.notes,
          commodityType: fields.commodityType,
          quantity: fields.quantity,
          unit: fields.unit,
          priceSymbol: liveSymbol,
          pricedAt: liveSymbol ? new Date(observed.observedAt * 1000) : null,
          useLivePrice: fields.useLivePrice,
        })
        .returning();
      postAssetOpeningPosition(raw, {
        assetId: row.id,
        instrumentId: instrument.id,
        currency,
        quantity: openingQuantity(fields, liveSymbol),
        bookAmountMinor: resolved.valueCents,
        effectiveDate: observed.observedDay,
        description: `Opening position for ${manualInstrumentLabel(fields)}`,
        recordedAt: observed.observedAt,
        source: liveSymbol ? "manual-live-holding" : "manual-holding",
      });
      const projection = projectPositionHolding(raw, instrument.id, currency);
      const [projected] = await db.select().from(assets).where(eq(assets.id, projection.assetId));
      if (!projected) throw new Error("Opening-position projection could not be read back");
      return projected;
    });



    revalidate("/", "/accounts");
    return { success: true, data: asset };
  } catch (error) {
    console.error("Failed to create asset:", error);
    return { error: (error as Error).message || "Failed to create asset." };
  }
}

export async function updateAsset(id: number, formData: FormData) {
  try {
    const existing = await readDb(async (db) => {
      const [row] = await db.select().from(assets).where(eq(assets.id, id));
      return row;
    });

    if (!existing) return { error: "That asset no longer exists." };
    if (existing.category === "Cash") {
      return { error: "Cash is calculated from your transactions and cannot be edited." };
    }

    const fields = readFields(formData);
    if (fields.category === "Cash") {
      return { error: "Cash is calculated from your transactions and cannot be set by hand." };
    }

    const resolved = await resolveCurrentValue(fields);
    if ("error" in resolved) return resolved;


    const currency =
      fields.category === "Commodities" && fields.useLivePrice ? "USD" : fields.currency;

    const asset = await withDb(async (db, raw) => {
      const liveSymbol =
        fields.category === "Commodities" && fields.useLivePrice
          ? priceSymbolForCommodityType(fields.commodityType)
          : null;
      const currentInstrument = existing.instrumentId
        ? findInstrument(raw, existing.instrumentId)
        : null;
      const instrument = liveSymbol
        ? ensurePricedInstrument(raw, liveSymbol)
        : currentInstrument?.kind === "manual"
          ? currentInstrument
          : createManualInstrument(raw, {
              label: manualInstrumentLabel(fields),
              category: fields.category,
              currency,
            });
      const opening = findAssetOpeningChain(raw, id);
      const exactPosition = existing.instrumentId
        ? getExactPosition(raw, existing.instrumentId, existing.currency)
        : null;
      if (exactPosition && !opening) {
        throw new Error("This holding is transaction-backed; edit or delete its purchase transaction instead");
      }
      if (opening && (opening.instrumentId !== instrument.id || opening.currency !== currency)) {
        throw new Error("A posted holding cannot change instrument or currency; create a new holding instead");
      }
      const observed = observationNow();
      const liveUnitPrice = liveSymbol ? legacyCommodityUnitPrice(fields, resolved.valueCents) : null;
      if (liveUnitPrice !== null) {
        recordInstrumentObservation(raw, {
          instrumentId: instrument.id,
          observationKind: "price",
          ...observed,
          amountMinor: liveUnitPrice,
          currency,
          source: instrument.priceSource,
        });
      } else if (!liveSymbol) {
        recordInstrumentObservation(raw, {
          instrumentId: instrument.id,
          observationKind: "valuation",
          ...observed,
          amountMinor: resolved.valueCents,
          currency,
          source: "manual",
        });
      }
      const [row] = await db
        .update(assets)
        .set({
          category: fields.category,
          currentValueCents: resolved.valueCents,
          currency,
          instrumentId: instrument.id,
          notes: fields.notes,
          commodityType: fields.commodityType,
          quantity: fields.quantity,
          unit: fields.unit,
          priceSymbol: liveSymbol,
          pricedAt: liveSymbol ? new Date(observed.observedAt * 1000) : null,
          useLivePrice: fields.useLivePrice,
          updatedAt: new Date(),
        })
        .where(eq(assets.id, id))
        .returning();
      postAssetOpeningPosition(raw, {
        assetId: row.id,
        instrumentId: instrument.id,
        currency,
        quantity: openingQuantity(fields, liveSymbol),
        bookAmountMinor: resolved.valueCents,
        effectiveDate: observed.observedDay,
        description: `Opening position for ${manualInstrumentLabel(fields)}`,
        recordedAt: observed.observedAt,
        source: liveSymbol ? "manual-live-holding" : "manual-holding",
      });
      const projection = projectPositionHolding(raw, instrument.id, currency);
      const [projected] = await db.select().from(assets).where(eq(assets.id, projection.assetId));
      if (!projected) throw new Error("Opening-position projection could not be read back");
      return projected;
    });



    revalidate("/", "/accounts");
    return { success: true, data: asset };
  } catch (error) {
    console.error("Failed to update asset:", error);
    return { error: (error as Error).message || "Failed to update asset." };
  }
}


export async function setAssetArchived(id: number, archived: boolean) {
  try {
    const outcome = await withDb(async (db) => {
      const [existing] = await db.select().from(assets).where(eq(assets.id, id));
      if (!existing) return { error: "That asset no longer exists." } as const;
      if (existing.category === "Cash") {
        return {
          error: "Cash is calculated from your transactions and cannot be archived.",
        } as const;
      }
      const [row] = await db
        .update(assets)
        .set({ archived, updatedAt: new Date() })
        .where(eq(assets.id, id))
        .returning();
      return { success: true as const, data: row };
    });
    if ("error" in outcome) return outcome;
    revalidate("/", "/accounts");
    return outcome;
  } catch (error) {
    console.error("Failed to archive asset:", error);
    return { error: (error as Error).message || "Failed to archive asset." };
  }
}


export async function deleteAsset(id: number, options?: { confirmed?: boolean }) {
  try {
    const outcome = await withDb(async (db, raw) => {
      const [asset] = await db.select().from(assets).where(eq(assets.id, id));
      if (!asset) return { error: "That asset no longer exists." } as const;
      if (asset?.category === "Cash") {
        throw new AssetProtectedError(
          "Cash is calculated from your transactions and cannot be deleted.",
        );
      }
      if (options?.confirmed !== true) {
        return {
          error:
            "Permanent delete requires explicit confirmation. Archive this holding to keep its history.",
        } as const;
      }
      if (asset.instrumentId) {
        const opening = findAssetOpeningChain(raw, id);
        const position = getExactPosition(raw, asset.instrumentId, asset.currency);
        if (position && !opening) {
          return {
            error: "This holding is transaction-backed; delete its purchase transaction instead.",
          } as const;
        }
        deleteAssetOpeningPosition(raw, id);
      }
      await db.delete(assets).where(eq(assets.id, id));
      return { success: true as const };
    });

    if ("error" in outcome) return outcome;


    revalidate("/", "/accounts");
    return outcome;
  } catch (error) {
    if (error instanceof AssetProtectedError) return { error: error.message };
    console.error("Failed to delete asset:", error);
    return { error: "Failed to delete asset." };
  }
}

class AssetProtectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetProtectedError";
  }
}
