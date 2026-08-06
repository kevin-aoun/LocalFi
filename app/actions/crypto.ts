"use server";

/**
 * Quote and persist symbol-priced holdings. Price lookup finishes before the DB
 * write; an unavailable or malformed quote leaves the stored value untouched.
 */

import { eq } from "drizzle-orm";

import { readLinkedTransactionIdsField } from "@/lib/assets/acquisition";
import { readDb, withDb } from "@/lib/db/client";
import { assets } from "@/lib/db/schema";
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
  /**
   * THREE states, and the difference is the whole bug this field once caused:
   *   - `undefined` — the form did not mention links at all. LEAVE THE COLUMN
   *     ALONE. `refreshLivePricedAssets` builds a FormData with only price
   *     fields, so treating "absent" as "empty" made every nightly snapshot
   *     silently erase every link the user had made.
   *   - `null`      — the form said "linked to nothing". Clear the column.
   *   - a string    — the canonical JSON array to store.
   */
  linkedTransactionIds: string | null | undefined;
};

type ActionResult<T> = { success: true; data: T } | { error: string };

function fieldText(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw : null;
}

/**
 * Validate the form BEFORE any network or database work.
 *
 * Note the quantity handling: `readQuantityField` distinguishes "the field was
 * empty" from "the field said 0". `quantity ? … : …` conflated the two, which
 * silently turned live pricing off and fell back to a typed value — the falsy-zero
 * bug this app has already been bitten by.
 */
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

  // A symbol with no price source is refused HERE, before the network and before
  // the database. Platinum and palladium are storable but not priceable (see
  // lib/prices.ts), and letting one through would mean a form that says "Live
  // Price" and then never has one. The stored value is untouched either way.
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

  // An unrecognised unit falls back to the holding's own unit rather than being
  // rejected: the dialog always sends a valid one, and lib/prices.ts refuses a
  // genuinely incompatible unit (grams of Bitcoin) with a typed error anyway.
  const rawUnit = (fieldText(formData, "unit") ?? "").trim().toLowerCase();
  const unit = (spec.units as readonly string[]).includes(rawUnit) ? rawUnit : spec.defaultUnit;

  const currency = (fieldText(formData, "currency") ?? "USD").trim().toUpperCase() || "USD";
  const notes = fieldText(formData, "notes");

  return {
    spec,
    quantity: quantity.value,
    unit,
    currency,
    notes: notes && notes.trim() !== "" ? notes : null,
    linkedTransactionIds: readLinkedTransactionIdsField(formData),
  };
}

/**
 * Fetch the price and compute the value. Runs BEFORE any database work, so slow
 * network I/O never happens while holding the database lock — and so a failure
 * cannot leave a half-written row.
 */
async function priceHolding(fields: HoldingFields, batch?: PriceBatch) {
  // With a batch in hand there is NOTHING to fetch: every price already arrived
  // in the single request `refreshLivePricedAssets` made. Without one, this is a
  // lone user action and one request is also the right number.
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
    // FAIL LOUDLY. Returning 0 here is what made a real holding disappear.
    return { error: describePriceError(valued.error) };
  }
  return valued;
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

    const asset = await withDb(async (db) => {
      const [row] = await db
        .insert(assets)
        .values({
          // The category comes from the registry, not the form: a BTC holding
          // filed under "Commodities" would be a lie that the next refresh would
          // have to guess its way out of.
          category: fields.spec.assetCategory,
          currentValueCents: priced.valueCents,
          currency: fields.currency,
          notes: fields.notes,
          // Kept in sync for every consumer that still reads "Gold"; null for crypto.
          commodityType: fields.spec.commodityType,
          priceSymbol: fields.spec.symbol,
          quantity: fields.quantity,
          unit: fields.unit as (typeof assets.$inferInsert)["unit"],
          pricedAt: new Date(priced.quote.fetchedAt),
          // `undefined` on an INSERT means "use the column default", i.e. NULL —
          // which is right: a brand-new holding whose form said nothing about
          // links has no links.
          linkedTransactionIds: fields.linkedTransactionIds,
          useLivePrice: true,
        })
        .returning();
      return row;
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

/**
 * The body of `updateLivePricedAsset`, plus an optional batch of prices already
 * fetched.
 *
 * Not exported: everything exported from a `"use server"` module becomes a
 * remotely callable server action, and a map of quotes is an internal detail, not
 * something a browser should be able to hand the server.
 */
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

    const asset = await withDb(async (db) => {
      const [row] = await db
        .update(assets)
        .set({
          category: fields.spec.assetCategory,
          currentValueCents: priced.valueCents,
          currency: fields.currency,
          notes: fields.notes,
          commodityType: fields.spec.commodityType,
          priceSymbol: fields.spec.symbol,
          quantity: fields.quantity,
          unit: fields.unit as (typeof assets.$inferInsert)["unit"],
          pricedAt: new Date(priced.quote.fetchedAt),
          // Spread, NOT a plain assignment. Drizzle omits an `undefined` value
          // from the UPDATE, so a form that never mentioned links leaves the
          // column untouched — which is what `refreshLivePricedAssets` submits
          // every night. Writing `linkedTransactionIds: fields.linked…` directly
          // was harmless-looking and, because the field defaulted to null, it
          // erased the user's links on every scheduled snapshot. That is why
          // `linked_transaction_ids` was NULL on every row despite the dialog
          // sending it.
          ...(fields.linkedTransactionIds === undefined
            ? {}
            : { linkedTransactionIds: fields.linkedTransactionIds }),
          useLivePrice: true,
          updatedAt: new Date(),
        })
        .where(eq(assets.id, id))
        .returning();
      return row;
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

/**
 * Re-price every holding that carries a symbol and a quantity.
 *
 * ## Why this exists
 *
 * `snapshotNetWorth()` reads `assets.current_value_cents` straight from the
 * database — it does not fetch anything. So a scheduled snapshot was recording
 * whatever value happened to be stored, which for a holding that had never been
 * priced meant recording a figure from the original migration. The net-worth
 * chart would then be a flat line made of stale numbers, which is worse than an
 * empty one because it looks like data.
 *
 * Callers should treat failure as non-fatal: an offline machine should still
 * record a snapshot of the values it has, and say that it did.
 *
 * ## ONE request, however many holdings
 *
 * Every price is fetched ONCE, up front, before the write loop. The keyless
 * CoinGecko tier allows roughly 5–15 requests a minute and answers a burst with
 * 429; a per-holding fetch would spend that budget re-asking for the same four
 * numbers and then fail partway, having already rewritten some rows and not
 * others. Now either every price arrives or none does.
 *
 * The writes stay sequential, never `Promise.all`: each takes the single database
 * lock in lib/db/client.ts, so a fan-out would only queue.
 *
 * ## Three outcomes, not two
 *
 * `unpriceable` is separate from `failed` on purpose. A platinum holding is not a
 * transient error to retry and alarm about nightly — it is a standing fact
 * (nothing keyless prices platinum per troy ounce), and its stored value stands
 * untouched rather than being zeroed. Reporting it as a failure every single
 * night would train the owner to ignore failures, which is how the real one gets
 * missed.
 */
export async function refreshLivePricedAssets(): Promise<{
  refreshed: number;
  skipped: number;
  /** Holdings whose symbol has no price source at all. Stored values KEPT. */
  unpriceable: Array<{ id: number; label: string; symbol: string; reason: string }>;
  failed: Array<{ id: number; label: string; error: string }>;
}> {
  const rows = await readDb((db) => db.select().from(assets));
  const live = rows.filter(
    (asset) => asset.useLivePrice === true || (asset.priceSymbol ?? "") !== "",
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
    formData.set("currency", asset.currency ?? "USD");
    if (asset.notes !== null && asset.notes !== undefined) formData.set("notes", asset.notes);
    // `linkedTransactionIds` is deliberately NOT set. This is a RE-PRICE, not an
    // edit of the holding's provenance, and an absent field now means "leave the
    // column alone" (see readLinkedTransactionIdsField). Setting it here — or
    // treating absent as empty, as this path used to — is what silently wiped
    // every purchase link the user had made, once per scheduled snapshot.

    const result = await updateLivePricedAssetWith(asset.id, formData, batch);
    if ("error" in result) {
      failed.push({ id: asset.id, label, error: result.error });
      continue;
    }
    refreshed += 1;
  }

  return { refreshed, skipped, unpriceable, failed };
}
