"use server";

import { readDb, withDb } from "@/lib/db/client";
import { assetHistory, assets, categories, transactions } from "@/lib/db/schema";
import { asc, eq } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";
import { calculateCommodityValue } from "./commodities";
import { tryParseAmount, type Cents } from "@/lib/money";
import { toDateKey } from "@/lib/dates";
import {
  purchaseCandidates,
  readLinkedTransactionIdsField,
  resolveAcquisitions,
  serializeLinkedTransactionIds,
  type AcquisitionTransaction,
  type AssetAcquisition,
  type PurchaseCandidate,
} from "@/lib/assets/acquisition";

export async function getAssets() {
  return await readDb((db) => db.select().from(assets));
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

/**
 * Holding values written alongside the daily net-worth ledger, oldest first.
 * Only investable categories are exposed here; houses, vehicles, and cash stay
 * in net worth without pretending they are market investments.
 */
export async function getInvestmentHistory(): Promise<InvestmentHistoryRow[]> {
  const rows = await readDb((db) =>
    db
      .select({
        assetId: assetHistory.assetId,
        valueCents: assetHistory.valueCents,
        recordedAt: assetHistory.recordedAt,
        category: assets.category,
        currency: assets.currency,
        notes: assets.notes,
        commodityType: assets.commodityType,
        priceSymbol: assets.priceSymbol,
      })
      .from(assetHistory)
      .innerJoin(assets, eq(assetHistory.assetId, assets.id))
      .orderBy(asc(assetHistory.recordedAt), asc(assetHistory.assetId)),
  );

  return rows
    .filter((row) => INVESTMENT_CATEGORIES.has(row.category))
    .map((row) => ({
      assetId: row.assetId,
      dateKey: toDateKey(row.recordedAt),
      valueCents: row.valueCents,
      category: row.category,
      currency: row.currency,
      label:
        row.priceSymbol ??
        row.commodityType ??
        (row.notes?.trim() || null) ??
        `${row.category} #${row.assetId}`,
    }));
}

/**
 * Every asset's acquisition — when it was bought, what it cost, and which
 * transaction says so — plus the purchases it could be linked to.
 *
 * This is a READ of the same `resolveAcquisitions` the net-worth and history
 * paths use, not a second opinion. A surface showing "bought on X" and a chart
 * that starts a holding on day X are answering the same call.
 */
export async function getAssetAcquisitions(): Promise<{
  acquisitions: AssetAcquisition[];
  /** Linkable Investment transactions, keyed by the asset category they suit. */
  candidatesByCategory: Record<string, PurchaseCandidate[]>;
}> {
  const { assetRows, txRows, categoryRows } = await readDb(async (db) => ({
    assetRows: await db.select().from(assets),
    txRows: await db.select().from(transactions),
    categoryRows: await db.select().from(categories),
  }));

  const ledger: AcquisitionTransaction[] = txRows.map((tx) => ({
    id: tx.id,
    // `toDateKey` on a local Date — never toISOString(), which would shift the
    // calendar day for anyone east or west of UTC.
    dateKey: toDateKey(tx.date instanceof Date ? tx.date : new Date(Number(tx.date) * 1000)),
    amountCents: tx.amountCents,
    categoryId: tx.categoryId,
    transferAccountId: tx.transferAccountId,
    pending: tx.pending,
    comment: tx.comment,
  }));

  const resolved = resolveAcquisitions(assetRows, ledger, categoryRows);

  const candidatesByCategory: Record<string, PurchaseCandidate[]> = {};
  for (const category of new Set(assetRows.map((a) => a.category))) {
    if (category === "Cash") continue;
    candidatesByCategory[category] = purchaseCandidates(category, ledger, categoryRows);
  }

  return { acquisitions: [...resolved.values()], candidatesByCategory };
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
  /** Physical weight; NOT money, so a real. `null` means "not provided". */
  quantity: number | null;
  unit: "oz" | "grams" | null;
  /**
   * `undefined` = the form never mentioned links, so LEAVE THE COLUMN ALONE.
   * `null` = explicitly linked to nothing. See `readLinkedTransactionIdsField`.
   */
  linkedTransactionIds: string | null | undefined;
  useLivePrice: boolean;
  /** Raw form value for the manual Current Value field. */
  rawCurrentValue: string | null;
};

function readFields(formData: FormData): AssetFields {
  const rawQuantity = formData.get("quantity");
  const quantityText = typeof rawQuantity === "string" ? rawQuantity.trim() : "";

  return {
    category: formData.get("category") as AssetCategory,
    currency: ((formData.get("currency") as string) || "USD").trim().toUpperCase(),
    notes: (formData.get("notes") as string) || null,
    commodityType: formData.get("commodityType")
      ? (formData.get("commodityType") as "Gold" | "Silver" | "Platinum" | "Palladium")
      : null,
    // EXPLICIT null check: `quantity ? …` treated a quantity of 0 as "absent",
    // which silently turned live pricing off and fell back to the typed value.
    quantity: quantityText === "" ? null : Number(quantityText),
    unit: formData.get("unit") ? (formData.get("unit") as "oz" | "grams") : null,
    linkedTransactionIds: readLinkedTransactionIdsField(formData),
    useLivePrice: formData.get("useLivePrice") === "true",
    rawCurrentValue: typeof formData.get("currentValue") === "string"
      ? (formData.get("currentValue") as string)
      : null,
  };
}

/**
 * Work out what to store in `current_value_cents`.
 *
 * WHY THIS IS ITS OWN STEP: when live pricing is on, the dialog HIDES the
 * Current Value input, so the form submits `""`. The old code did
 * `parseAmount("")`… which threw, was swallowed by the catch, and returned a
 * generic error — or, in the `Number("")` variants, quietly produced 0. And when
 * the SwissQuote fetch failed, `calculateCommodityValue` returned null, the `if`
 * simply did not fire, and the asset was **persisted at $0 with no error at
 * all**: the user's gold silently vanished from their net worth.
 *
 * Now every branch either produces a real value or an explicit failure. The
 * network fetch also happens HERE, before any database work, so no slow I/O
 * happens while holding the database lock.
 */
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
      // Fail LOUDLY. Saving 0 here is what made a $40,000 holding disappear.
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

    // Prevent manual creation of the derived Cash asset.
    if (fields.category === "Cash") {
      return { error: "Cash is calculated from your transactions and cannot be added by hand." };
    }

    const resolved = await resolveCurrentValue(fields);
    if ("error" in resolved) return resolved;

    const asset = await withDb(async (db) => {
      const [row] = await db
        .insert(assets)
        .values({
          category: fields.category,
          currentValueCents: resolved.valueCents,
          currency: fields.currency || "USD",
          notes: fields.notes,
          commodityType: fields.commodityType,
          quantity: fields.quantity,
          unit: fields.unit,
          linkedTransactionIds: fields.linkedTransactionIds,
          useLivePrice: fields.useLivePrice,
        })
        .returning();
      return row;
    });

    // A standalone asset counts towards net worth, so /accounts moves too.
    // `revalidate` never turns a committed write into a reported failure.
    revalidate("/", "/accounts");
    return { success: true, data: asset };
  } catch (error) {
    console.error("Failed to create asset:", error);
    return { error: "Failed to create asset." };
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

    const asset = await withDb(async (db) => {
      const [row] = await db
        .update(assets)
        .set({
          category: fields.category,
          currentValueCents: resolved.valueCents,
          currency: fields.currency || "USD",
          notes: fields.notes,
          commodityType: fields.commodityType,
          quantity: fields.quantity,
          unit: fields.unit,
          // Spread, so an UPDATE whose form never mentioned links leaves the
          // column untouched instead of erasing it. The dialog only sent this
          // field for Commodities, so editing any other asset used to silently
          // drop its purchase link.
          ...(fields.linkedTransactionIds === undefined
            ? {}
            : { linkedTransactionIds: fields.linkedTransactionIds }),
          useLivePrice: fields.useLivePrice,
          updatedAt: new Date(),
        })
        .where(eq(assets.id, id))
        .returning();
      return row;
    });

    // A standalone asset counts towards net worth, so /accounts moves too.
    // `revalidate` never turns a committed write into a reported failure.
    revalidate("/", "/accounts");
    return { success: true, data: asset };
  } catch (error) {
    console.error("Failed to update asset:", error);
    return { error: "Failed to update asset." };
  }
}

/**
 * Link (or unlink) an asset's purchase transactions — the one-click action.
 *
 * Deliberately its OWN action rather than a field on the save path:
 *
 *   - it touches `linked_transaction_ids` and nothing else, so recording where a
 *     holding came from can never re-price it, re-round it, or fail because the
 *     network is down;
 *   - it works for every category, not just Commodities. BTC and ETH have no
 *     purchase transaction in the owner's ledger today, and the moment he adds
 *     one this is how he attaches it.
 *
 * An empty list is a real instruction — "this is linked to nothing" — and clears
 * the column. Ids that name no transaction are REFUSED rather than dropped: a
 * link that silently half-applied is how provenance rots.
 */
export async function setAssetPurchaseLinks(id: number, transactionIds: readonly number[]) {
  try {
    const requested = [...new Set(transactionIds)].filter((v) => Number.isInteger(v));

    const outcome = await withDb(async (db) => {
      const [asset] = await db.select().from(assets).where(eq(assets.id, id));
      if (!asset) return { error: "That asset no longer exists." } as const;
      if (asset.category === "Cash") {
        return {
          error: "Cash is calculated from your transactions and has no purchase to link.",
        } as const;
      }

      const known = new Set((await db.select().from(transactions)).map((tx) => tx.id));
      const missing = requested.filter((txId) => !known.has(txId));
      if (missing.length > 0) {
        return {
          error: `No transaction with id ${missing.join(", ")}; nothing was linked.`,
        } as const;
      }

      const [row] = await db
        .update(assets)
        .set({
          linkedTransactionIds: serializeLinkedTransactionIds(requested),
          updatedAt: new Date(),
        })
        .where(eq(assets.id, id))
        .returning();
      return { success: true as const, data: row };
    });

    if ("error" in outcome) return outcome;

    // An acquisition date changes which days a holding counts on, so the
    // dashboard chart and /accounts both move.
    revalidate("/", "/accounts");
    return outcome;
  } catch (error) {
    console.error("Failed to link asset transactions:", error);
    return { error: "Failed to link those transactions." };
  }
}

export async function deleteAsset(id: number) {
  try {
    const outcome = await withDb(async (db) => {
      const [asset] = await db.select().from(assets).where(eq(assets.id, id));
      if (asset?.category === "Cash") {
        throw new AssetProtectedError(
          "Cash is calculated from your transactions and cannot be deleted.",
        );
      }
      await db.delete(assets).where(eq(assets.id, id));
      return { success: true as const };
    });

    // A standalone asset counts towards net worth, so /accounts moves too.
    // `revalidate` never turns a committed write into a reported failure.
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
