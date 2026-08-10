import { sqliteTable, integer, text, index, uniqueIndex, check, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { categories } from "./categories";
import { accounts } from "./accounts";
import { recurringTransactions } from "./recurring";
import type { Cents } from "@/lib/money";
import { ledgerEvents } from "./ledger";
import { instruments } from "./instruments";

/** DECISION: DEC-003 — historical cash meaning is stored on each ledger row. */
export const transactionDirections = ["inflow", "outflow", "transfer"] as const;
export type TransactionDirection = (typeof transactionDirections)[number];

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: integer("date", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    /**
     * NULLABLE since 0003. Two reasons: a TRANSFER has no category (it is not
     * income or expense), and the live database contained two rows pointing at a
     * category that had been deleted, which a NOT NULL column could only pretend
     * was fine. See lib/cash-balance.ts: a row with no category contributes
     * nothing to any balance.
     */
    categoryId: integer("category_id").references(() => categories.id),
    /**
     * The account the money moves out of (expense/transfer) or into (income).
     * Nullable so pre-0003 rows and the existing seed/import scripts stay valid;
     * the 0003 migration backfills every existing row onto the default account,
     * and `deriveAccountBalances` puts anything still NULL into an explicit
     * "unassigned" bucket rather than dropping it out of net worth.
     */
    accountId: integer("account_id").references(() => accounts.id),
    /**
     * Set ONLY on a transfer: the account the money moves into. A transfer is a
     * first-class transaction, not a category hack — it is net-neutral to net
     * worth and excluded from income, expense and budget spend.
     */
    transferAccountId: integer("transfer_account_id").references(() => accounts.id),
    /** Non-negative magnitude in integer cents. */
    amountCents: integer("amount_cents").notNull().$type<Cents>(),
    /** Historical cash direction, snapshotted when this row is written. */
    direction: text("direction", { enum: transactionDirections })
      .notNull()
      // SQL migration 0009 normalizes this compatibility sentinel immediately
      // in an AFTER INSERT trigger. It keeps pre-0009 internal producers typed
      // while supported actions always provide an explicit direction.
      .default(sql`'legacy'`),
    /** Historical denomination, snapshotted from the selected account. */
    currency: text("currency").notNull().default("USD"),
    /** Head event from which this rebuildable read model was projected. */
    currentEventId: text("current_event_id").references(() => ledgerEvents.eventId, {
      onDelete: "restrict",
    }),
    instrumentId: text("instrument_id").references(() => instruments.id, {
      onDelete: "restrict",
    }),
    /** Exact confirmed quantity snapshot, stored as canonical decimal text. */
    quantityDelta: text("quantity_delta"),
    transferPrincipalAmountCents: integer("transfer_principal_amount_cents").$type<Cents>(),
    comment: text("comment"),
    pending: integer("pending", { mode: "boolean" }).notNull().default(false),
    /** The recurring template that generated this row, if any. */
    recurringId: integer("recurring_id").references(() => recurringTransactions.id, {
      onDelete: "set null",
    }),
    /**
     * 'YYYY-MM-DD' of the occurrence this row materialises. Together with
     * `recurring_id` it is UNIQUE, which makes materialisation idempotent at the
     * DATABASE level instead of trusting a cursor: running the generator twice
     * cannot double-post rent.
     */
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
    /** Partial unique index: at most one row per (template, occurrence). */
    recurringOccurrenceUnique: uniqueIndex("transactions_recurring_occurrence_unique")
      .on(table.recurringId, table.recurringOccurrence)
      .where(sql`recurring_id IS NOT NULL`),
    /** A transfer to the same account would be a no-op that still looked like a move. */
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
