import { sqliteTable, integer, text, index, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { accounts } from "./accounts";
import { categories } from "./categories";
import type { Cents } from "@/lib/money";

export const recurrenceFrequencies = ["daily", "weekly", "monthly", "yearly"] as const;
export type RecurrenceFrequency = (typeof recurrenceFrequencies)[number];

export const recurringTransactions = sqliteTable(
  "recurring_transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    name: text("name").notNull(),

    accountId: integer("account_id").references(() => accounts.id, { onDelete: "set null" }),

    transferAccountId: integer("transfer_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),

    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),

    amountCents: integer("amount_cents").notNull().$type<Cents>(),
    comment: text("comment"),

    frequency: text("frequency", { enum: recurrenceFrequencies }).notNull(),

    interval: integer("interval").notNull().default(1),

    startDate: text("start_date").notNull(),

    endDate: text("end_date"),

    nextDue: text("next_due"),

    lastGenerated: text("last_generated"),

    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    dueIdx: index("recurring_next_due_idx").on(table.nextDue),
    frequencyValid: check(
      "recurring_frequency_valid",
      sql`${table.frequency} IN ('daily', 'weekly', 'monthly', 'yearly')`,
    ),
    intervalValid: check("recurring_interval_valid", sql`${table.interval} >= 1`),

    transferDistinct: check(
      "recurring_transfer_distinct",
      sql`${table.transferAccountId} IS NULL OR ${table.transferAccountId} <> ${table.accountId}`,
    ),
  }),
);

export type RecurringTransaction = typeof recurringTransactions.$inferSelect;
export type NewRecurringTransaction = typeof recurringTransactions.$inferInsert;
