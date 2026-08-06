import { sqliteTable, integer, text, index, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { accounts } from "./accounts";
import { categories } from "./categories";
import type { Cents } from "@/lib/money";

export const recurrenceFrequencies = ["daily", "weekly", "monthly", "yearly"] as const;
export type RecurrenceFrequency = (typeof recurrenceFrequencies)[number];

/**
 * Templates for transactions that repeat: rent, salary, subscriptions.
 *
 * The three date columns do different jobs and must not be conflated:
 *   - `start_date`  the ANCHOR. Every occurrence is computed from it by index, so
 *                   "the 31st" clamps to Feb 28 for February only and returns to
 *                   the 31st in March. Advancing from the last posted date instead
 *                   would walk the rent day backwards to the 28th forever.
 *   - `next_due`    a denormalised cursor for "what is coming up", kept in step
 *                   with `last_generated` by the materialiser.
 *   - `last_generated` the high-water mark of what has been posted. Occurrences
 *                   are emitted strictly after it, which is what makes catch-up
 *                   across missed months post each month exactly once.
 *
 * Idempotency does NOT rest on those cursors alone: every materialised row carries
 * (`recurring_id`, `recurring_occurrence`) under a partial UNIQUE index, so a
 * double post is rejected by the database itself. See lib/db/schema/transactions.ts.
 */
export const recurringTransactions = sqliteTable(
  "recurring_transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Human label for the template ("Rent", "Netflix"). */
    name: text("name").notNull(),

    // ---- template of the transaction to post -----------------------------
    accountId: integer("account_id").references(() => accounts.id, { onDelete: "set null" }),
    /** Set to make each occurrence a TRANSFER (e.g. monthly savings sweep). */
    transferAccountId: integer("transfer_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    /** NULL for a transfer template. */
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    /** Amount of ONE occurrence, in integer cents. Never a float. */
    amountCents: integer("amount_cents").notNull().$type<Cents>(),
    comment: text("comment"),

    // ---- recurrence rule -------------------------------------------------
    frequency: text("frequency", { enum: recurrenceFrequencies }).notNull(),
    /** Every `interval` days/weeks/months/years. Integer >= 1. */
    interval: integer("interval").notNull().default(1),
    /** 'YYYY-MM-DD' anchor / first occurrence. */
    startDate: text("start_date").notNull(),
    /** 'YYYY-MM-DD' inclusive last day an occurrence may fall on. NULL = forever. */
    endDate: text("end_date"),

    // ---- cursors ---------------------------------------------------------
    /** 'YYYY-MM-DD' next occurrence not yet posted. NULL once the rule is exhausted. */
    nextDue: text("next_due"),
    /** 'YYYY-MM-DD' latest occurrence already posted. NULL = nothing posted yet. */
    lastGenerated: text("last_generated"),

    /** Paused templates generate nothing but keep their history. */
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
    // A "transfer to itself" would be a no-op that still moved the cursor.
    transferDistinct: check(
      "recurring_transfer_distinct",
      sql`${table.transferAccountId} IS NULL OR ${table.transferAccountId} <> ${table.accountId}`,
    ),
  }),
);

export type RecurringTransaction = typeof recurringTransactions.$inferSelect;
export type NewRecurringTransaction = typeof recurringTransactions.$inferInsert;
