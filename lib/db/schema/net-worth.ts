import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { Cents } from "@/lib/money";

export const netWorthSources = ["recorded", "reconstructed"] as const;
export type NetWorthSource = (typeof netWorthSources)[number];

export const netWorthSnapshots = sqliteTable(
  "net_worth_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    date: text("date").notNull(),

    currency: text("currency").notNull().default("USD"),

    totalAssetsCents: integer("total_assets_cents").notNull().$type<Cents>(),

    totalLiabilitiesCents: integer("total_liabilities_cents").notNull().$type<Cents>(),

    netWorthCents: integer("net_worth_cents").notNull().$type<Cents>(),

    source: text("source", { enum: netWorthSources }).notNull().default("recorded"),

    sourceNote: text("source_note"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    dateUnique: uniqueIndex("net_worth_snapshots_date_unique").on(table.date),
  }),
);

export type NetWorthSnapshot = typeof netWorthSnapshots.$inferSelect;
export type NewNetWorthSnapshot = typeof netWorthSnapshots.$inferInsert;
