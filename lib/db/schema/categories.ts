import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { Cents } from "@/lib/money";

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull().unique(),
    type: text("type", { enum: ["Income", "Expense", "Investment"] }).notNull(),

    monthlyLimitCents: integer("monthly_limit_cents").$type<Cents>(),

    displayOrder: integer("display_order").notNull().default(0),
    icon: text("icon").notNull(),
    color: text("color").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    displayOrderIdx: index("categories_type_display_order_idx").on(
      table.type,
      table.displayOrder,
      table.id,
    ),
  }),
);

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
