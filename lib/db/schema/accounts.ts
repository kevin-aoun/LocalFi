import { sqliteTable, integer, text, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { Cents } from "@/lib/money";
import type { DateKey } from "@/lib/dates";

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

export const accountKindForType: Record<AccountType, AccountKind> = {
  Checking: "asset",
  Savings: "asset",
  Cash: "asset",
  Investment: "asset",
  CreditCard: "liability",
  Loan: "liability",
  Mortgage: "liability",

  Other: "asset",
};

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),

    kind: text("kind", { enum: accountKinds }).notNull(),
    type: text("type", { enum: accountTypes }).notNull(),

    openingBalanceCents: integer("opening_balance_cents").notNull().default(0).$type<Cents>(),

    openingBalanceDate: text("opening_balance_date")
      .notNull()
      .default(sql`(date('now', 'localtime'))`)
      .$type<DateKey>(),
    currency: text("currency").notNull().default("USD"),

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
    openingBalanceMagnitude: check(
      "accounts_opening_balance_magnitude",
      sql`typeof(${table.openingBalanceCents}) = 'integer' AND ${table.openingBalanceCents} >= 0`,
    ),
    openingBalanceDateValid: check(
      "accounts_opening_balance_date_valid",
      sql`${table.openingBalanceDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(${table.openingBalanceDate}, '+0 days') = ${table.openingBalanceDate}`,
    ),
    currencyValid: check(
      "accounts_currency_valid",
      sql`${table.currency} GLOB '[A-Z][A-Z][A-Z]'`,
    ),
  }),
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
