import { sqliteTable, integer, text, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { categories } from "./categories";
import { accounts } from "./accounts";
import { recurringTransactions } from "./recurring";
import type { Cents } from "@/lib/money";

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
    /** Positive magnitude in integer cents. Direction comes from the category/transfer. */
    amountCents: integer("amount_cents").notNull().$type<Cents>(),
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
  }),
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
