import { sqliteTable, integer, text, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { Cents } from "@/lib/money";

/**
 * ONE table for both halves of the balance sheet, discriminated by `kind`.
 *
 * WHY NOT A SEPARATE `liabilities` TABLE: net worth is then
 * `sum(asset accounts) - sum(liability accounts)`, a single query over a single
 * table, so the two halves cannot drift apart. A parallel table means two
 * inventories of money that have to be kept in agreement by hand — which is how
 * "net worth" silently became "gross assets" in the first place.
 */
export const accountKinds = ["asset", "liability"] as const;
export type AccountKind = (typeof accountKinds)[number];

export const accountTypes = [
  "Checking",
  "Savings",
  "Cash",
  "CreditCard",
  "Loan",
  "Mortgage",
  "Investment",
  "Other",
] as const;
export type AccountType = (typeof accountTypes)[number];

/** Which `kind` each `type` belongs on. Used to validate input in the actions. */
export const accountKindForType: Record<AccountType, AccountKind> = {
  Checking: "asset",
  Savings: "asset",
  Cash: "asset",
  Investment: "asset",
  CreditCard: "liability",
  Loan: "liability",
  Mortgage: "liability",
  // "Other" can legitimately be either, so it is not constrained here.
  Other: "asset",
};

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    /** 'asset' | 'liability' — see the note above. */
    kind: text("kind", { enum: accountKinds }).notNull(),
    type: text("type", { enum: accountTypes }).notNull(),
    /**
     * Balance at inception, in integer cents, as a MAGNITUDE in the direction the
     * user thinks about the account: for an asset, how much is in it; for a
     * liability, how much is OWED (a card with $500 outstanding stores 50000).
     * The single sign flip lives in lib/cash-balance.ts.
     *
     * This is what stops a user who imported only recent history from sitting
     * permanently negative.
     */
    openingBalanceCents: integer("opening_balance_cents").notNull().default(0).$type<Cents>(),
    currency: text("currency").notNull().default("USD"),
    /** Closed accounts stay visible to history; they are hidden from pickers. */
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    nameUnique: uniqueIndex("accounts_name_unique").on(table.name),
    kindIdx: index("accounts_kind_idx").on(table.kind),
    kindValid: check("accounts_kind_valid", sql`${table.kind} IN ('asset', 'liability')`),
  }),
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
