import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { Cents } from "@/lib/money";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userName: text("user_name").notNull().default(""),
  accentColor: text("accent_color").notNull().default("default"),
  theme: text("theme", { enum: ["light", "dark", "system"] }).notNull().default("system"),
  showLedger: integer("show_ledger", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const quickCommands = sqliteTable("quick_commands", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  command: text("command").notNull(),
  categoryName: text("category_name").notNull(),
  /** Pre-filled transaction amount in integer cents. Never a float. */
  amountCents: integer("amount_cents").notNull().$type<Cents>(),
  comment: text("comment").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type Settings = typeof settings.$inferSelect;
export type NewSettings = typeof settings.$inferInsert;
export type QuickCommand = typeof quickCommands.$inferSelect;
export type NewQuickCommand = typeof quickCommands.$inferInsert;
