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

export const quantityUnits = ["oz", "grams", "coins"] as const;

export const priceSymbols = ["XAU", "XAG", "XPT", "XPD", "BTC", "ETH"] as const;

export const assets = sqliteTable("assets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category", { enum: assetTypes }).notNull(),

  currentValueCents: integer("current_value_cents").notNull().$type<Cents>(),
  currency: text("currency").notNull().default("USD"),

  instrumentId: text("instrument_id").references(() => instruments.id, {
    onDelete: "restrict",
  }),
  notes: text("notes"),

  commodityType: text("commodity_type", { enum: commodityTypes }),

  quantity: real("quantity"),
  unit: text("unit", { enum: quantityUnits }),

  priceSymbol: text("price_symbol", { enum: priceSymbols }),

  pricedAt: integer("priced_at", { mode: "timestamp" }),
  linkedTransactionIds: text("linked_transaction_ids"),
  useLivePrice: integer("use_live_price", { mode: "boolean" }).default(false),

  archived: integer("archived", { mode: "boolean" }).notNull().default(false),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const assetHistory = sqliteTable(
  "asset_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    assetId: integer("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),

    valueCents: integer("value_cents").notNull().$type<Cents>(),
    currency: text("currency").notNull().default("USD"),

    recordedDay: text("recorded_day").notNull(),

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
