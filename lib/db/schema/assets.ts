import { sqliteTable, integer, text, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { Cents } from "@/lib/money";
import { instruments } from "./instruments";

export const assetTypes = [
  "Cash",
  "Savings",
  "Investments",
  "Crypto",
  "Properties",
  "Vehicles",
  "Commodities",
  "Other",
] as const;

export const commodityTypes = ["Gold", "Silver", "Platinum", "Palladium"] as const;

/**
 * Units a `quantity` may be expressed in.
 *
 * `oz` / `grams` are physical weights (metals). `coins` is what `unit` means for
 * a crypto holding: a COUNT of coins or tokens, not a weight — `quantity` 0.0345
 * with unit `coins` is 0.0345 BTC. `quantity` stays a `real` precisely so a
 * fractional coin count survives intact.
 */
export const quantityUnits = ["oz", "grams", "coins"] as const;

/**
 * Which live-price feed values a holding, added by migration 0004.
 *
 * WHY THIS EXISTS: pricing used to be inferred from `commodity_type`, which only
 * works for metals on a forex feed. Bitcoin and Ethereum are not commodities and
 * are not on that feed, so a holding now names its own symbol and lib/prices.ts
 * routes it: XAU/XAG/XPT/XPD -> SwissQuote, BTC/ETH -> CoinGecko.
 *
 * Deliberately duplicated from `PRICE_SYMBOLS` in lib/prices.ts rather than
 * imported: this file is read by drizzle-kit, which resolves no path aliases at
 * runtime, and the schema layer must not depend on the fetching layer.
 * lib/__tests__/prices.test.ts asserts the two lists stay identical.
 */
export const priceSymbols = ["XAU", "XAG", "XPT", "XPD", "BTC", "ETH"] as const;

export const assets = sqliteTable("assets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category", { enum: assetTypes }).notNull(),
  /** Current value in integer cents, denominated in `currency`. Never a float. */
  currentValueCents: integer("current_value_cents").notNull().$type<Cents>(),
  currency: text("currency").notNull().default("USD"),
  /** Stable valuation unit; migration 0012 derives it from `currency`. */
  instrumentId: text("instrument_id").references(() => instruments.id, {
    onDelete: "restrict",
  }),
  notes: text("notes"),

  // Commodity-specific field, KEPT for compatibility: every consumer that reads
  // "Gold" still works, and 0004 backfilled `priceSymbol` alongside it rather
  // than replacing it.
  commodityType: text("commodity_type", { enum: commodityTypes }),
  /**
   * How much of the thing is held — NOT money, so this stays a real.
   *
   * A troy-ounce/gram weight for metals, a coin count for crypto (see `unit`).
   * Rounding it to two decimals would destroy both sub-gram precision and
   * sub-cent coin fractions. A quantity of 0 is a real quantity.
   */
  quantity: real("quantity"),
  unit: text("unit", { enum: quantityUnits }),
  /**
   * Which live-price feed values this holding: "XAU" (SwissQuote) or "BTC"
   * (CoinGecko). NULL for a hand-valued asset. This — not `category` and not
   * `commodityType` — is what `useLivePrice` refreshes against.
   */
  priceSymbol: text("price_symbol", { enum: priceSymbols }),
  /**
   * When `currentValueCents` was last set from a live quote. NULL means it never
   * was. Used to tell the user their value is STALE when a fetch fails, instead
   * of overwriting a real holding with 0.
   */
  pricedAt: integer("priced_at", { mode: "timestamp" }),
  linkedTransactionIds: text("linked_transaction_ids"), // JSON array of transaction IDs
  useLivePrice: integer("use_live_price", { mode: "boolean" }).default(false),
  /** Normal lifecycle: hidden from current views while all history remains. */
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/** Daily per-holding values written atomically with `net_worth_snapshots`. */
export const assetHistory = sqliteTable(
  "asset_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    assetId: integer("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    /** Historical asset value in integer cents, denominated in `currency`. */
    valueCents: integer("value_cents").notNull().$type<Cents>(),
    currency: text("currency").notNull().default("USD"),
    /** Explicit local calendar day used for uniqueness and idempotent upserts. */
    recordedDay: text("recorded_day").notNull(),
    /** Retained for chronology and compatibility; `recordedDay` owns day identity. */
    recordedAt: integer("recorded_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    assetDayUnique: uniqueIndex("asset_history_asset_day_unique").on(
      table.assetId,
      table.recordedDay,
    ),
  }),
);

export type Asset = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type AssetHistory = typeof assetHistory.$inferSelect;
export type NewAssetHistory = typeof assetHistory.$inferInsert;
