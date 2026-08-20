import { sqliteTable, integer, text, index, uniqueIndex, check, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { categories } from "./categories";
import { accounts } from "./accounts";
import { recurringTransactions } from "./recurring";
import type { Cents } from "@/lib/money";
import { ledgerEvents } from "./ledger";
import { instruments } from "./instruments";

export const transactionDirections = ["inflow", "outflow", "transfer"] as const;
export type TransactionDirection = (typeof transactionDirections)[number];

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: integer("date", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),

    categoryId: integer("category_id").references(() => categories.id),

    accountId: integer("account_id").references(() => accounts.id),

    transferAccountId: integer("transfer_account_id").references(() => accounts.id),

    amountCents: integer("amount_cents").notNull().$type<Cents>(),

    direction: text("direction", { enum: transactionDirections })
      .notNull()

      .default(sql`'legacy'`),

    currency: text("currency").notNull().default("USD"),

    currentEventId: text("current_event_id").references(() => ledgerEvents.eventId, {
      onDelete: "restrict",
    }),
    instrumentId: text("instrument_id").references(() => instruments.id, {
      onDelete: "restrict",
    }),

    quantityDelta: text("quantity_delta"),
    transferPrincipalAmountCents: integer("transfer_principal_amount_cents").$type<Cents>(),
    comment: text("comment"),
    pending: integer("pending", { mode: "boolean" }).notNull().default(false),

    recurringId: integer("recurring_id").references(() => recurringTransactions.id, {
      onDelete: "set null",
    }),

    recurringOccurrence: text("recurring_occurrence"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    accountIdx: index("transactions_account_idx").on(table.accountId),
    categoryIdx: index("transactions_category_idx").on(table.categoryId),
    dateIdx: index("transactions_date_idx").on(table.date),

    recurringOccurrenceUnique: uniqueIndex("transactions_recurring_occurrence_unique")
      .on(table.recurringId, table.recurringOccurrence)
      .where(sql`recurring_id IS NOT NULL`),

    transferDistinct: check(
      "transactions_transfer_distinct",
      sql`transfer_account_id IS NULL OR transfer_account_id <> account_id`,
    ),
    amountMagnitude: check(
      "transactions_amount_magnitude",
      sql`typeof(${table.amountCents}) = 'integer' AND ${table.amountCents} >= 0`,
    ),
    directionValid: check(
      "transactions_direction_valid",
      sql`${table.direction} IN ('inflow', 'outflow', 'transfer', 'legacy')`,
    ),
    directionShape: check(
      "transactions_direction_shape",
      sql`${table.direction} = 'legacy' OR (${table.direction} = 'transfer' AND ${table.transferAccountId} IS NOT NULL AND ${table.categoryId} IS NULL) OR (${table.direction} IN ('inflow', 'outflow') AND ${table.transferAccountId} IS NULL)`,
    ),
    currencyValid: check(
      "transactions_currency_valid",
      sql`${table.currency} GLOB '[A-Z][A-Z][A-Z]'`,
    ),
    principalValid: check(
      "transactions_transfer_principal_valid",
      sql`${table.transferPrincipalAmountCents} IS NULL OR (typeof(${table.transferPrincipalAmountCents}) = 'integer' AND ${table.transferPrincipalAmountCents} >= 0 AND ${table.transferPrincipalAmountCents} <= ${table.amountCents})`,
    ),
  }),
);

export const transactionAllocations = sqliteTable(
  "transaction_allocations",
  {
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    amountCents: integer("amount_cents").notNull().$type<Cents>(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.transactionId, table.position] }),
    amountValid: check(
      "transaction_allocations_amount_valid",
      sql`typeof(${table.amountCents}) = 'integer' AND ${table.amountCents} > 0`,
    ),
  }),
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type TransactionAllocation = typeof transactionAllocations.$inferSelect;
export type NewTransactionAllocation = typeof transactionAllocations.$inferInsert;
