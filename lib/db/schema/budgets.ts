import { sqliteTable, integer, text, index, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { categories } from "./categories";
import type { Cents } from "@/lib/money";

/**
 * Real budget periods, with history.
 *
 * WHAT THIS REPLACES: `categories.monthly_limit_cents`, a single nullable column
 * that could only express "this much, per calendar month, right now". It had no
 * history (so last month's performance was unknowable), no other period length,
 * and no carry-over.
 *
 * INCOME CATEGORIES MAY NOT HAVE A BUDGET. A budget is a limit on money you
 * choose to spend; income is money that arrives, so a "limit" on it constrains
 * nothing and reads as a forecast the app cannot honour. `createBudget`,
 * `updateBudget` and `importLegacyBudgets` in app/actions/budgets.ts all refuse
 * one, and `loadLedger` drops any that predate the rule. The constraint is not
 * expressible here because `type` lives on `categories`, not on this row — so
 * treat those four call sites as the enforcement point, not this table.
 *
 * `categories.monthly_limit_cents` is deliberately KEPT and still read as the
 * legacy monthly budget (see `budgetsFromLegacyLimits` in lib/budgets.ts); the
 * 0003 migration copies its non-null values into this table.
 */
export const budgetPeriods = ["weekly", "monthly", "yearly"] as const;
export type BudgetPeriodName = (typeof budgetPeriods)[number];

export const budgets = sqliteTable(
  "budgets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Must reference an Expense category — see the Income rule above. */
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    period: text("period", { enum: budgetPeriods }).notNull(),
    /** The spending ceiling for ONE period, in integer cents. */
    limitCents: integer("limit_cents").notNull().$type<Cents>(),
    /** 'YYYY-MM-DD', inclusive. Stored as a text DateKey, never a UTC timestamp. */
    effectiveFrom: text("effective_from").notNull(),
    /** 'YYYY-MM-DD', inclusive. NULL = still in force. */
    effectiveTo: text("effective_to"),
    /** When true, an unused surplus is available in the next period. */
    rollover: integer("rollover", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    categoryIdx: index("budgets_category_idx").on(table.categoryId, table.effectiveFrom),
    periodIdx: index("budgets_period_idx").on(table.period),
    periodValid: check("budgets_period_valid", sql`${table.period} IN ('weekly', 'monthly', 'yearly')`),
    // An inverted window would make `budgetInForce` return nothing, silently.
    windowValid: check(
      "budgets_window_valid",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
  }),
);

export type Budget = typeof budgets.$inferSelect;
export type NewBudget = typeof budgets.$inferInsert;

export const budgetReallocationInputModes = ["amount", "percentage"] as const;
export type BudgetReallocationInputMode = (typeof budgetReallocationInputModes)[number];

/**
 * A one-off transfer between two MONTHLY category budgets.
 *
 * `amount_cents` is the historical fact used by the budget engine. Percentage
 * entry is resolved to cents when saved, so a later permanent budget edit does
 * not rewrite what the owner decided for an earlier month. `input_*` preserves
 * how that fixed amount was entered for an audit-friendly label in the UI.
 */
export const budgetReallocations = sqliteTable(
  "budget_reallocations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 'YYYY-MM': exactly one calendar month. */
    month: text("month").notNull(),
    fromCategoryId: integer("from_category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    toCategoryId: integer("to_category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull().$type<Cents>(),
    inputMode: text("input_mode", { enum: budgetReallocationInputModes }).notNull(),
    /** Decimal amount or percentage exactly as entered, for display only. */
    inputValue: text("input_value").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    monthIdx: index("budget_reallocations_month_idx").on(table.month),
    fromIdx: index("budget_reallocations_from_idx").on(table.fromCategoryId, table.month),
    toIdx: index("budget_reallocations_to_idx").on(table.toCategoryId, table.month),
    amountPositive: check("budget_reallocations_amount_positive", sql`${table.amountCents} > 0`),
    categoriesDifferent: check(
      "budget_reallocations_categories_different",
      sql`${table.fromCategoryId} <> ${table.toCategoryId}`,
    ),
    modeValid: check(
      "budget_reallocations_mode_valid",
      sql`${table.inputMode} IN ('amount', 'percentage')`,
    ),
  }),
);

export type BudgetReallocation = typeof budgetReallocations.$inferSelect;
export type NewBudgetReallocation = typeof budgetReallocations.$inferInsert;
