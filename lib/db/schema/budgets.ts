import { sqliteTable, integer, text, index, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { categories } from "./categories";
import type { Cents } from "@/lib/money";

export const budgetPeriods = ["weekly", "monthly", "yearly"] as const;
export type BudgetPeriodName = (typeof budgetPeriods)[number];

export const budgets = sqliteTable(
  "budgets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    period: text("period", { enum: budgetPeriods }).notNull(),

    limitCents: integer("limit_cents").notNull().$type<Cents>(),

    effectiveFrom: text("effective_from").notNull(),

    effectiveTo: text("effective_to"),

    rollover: integer("rollover", { mode: "boolean" }).notNull().default(false),

    goalName: text("goal_name"),

    goalAmountCents: integer("goal_amount_cents").$type<Cents>(),

    displayOrder: integer("display_order").notNull().default(0),
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
    displayOrderIdx: index("budgets_display_order_idx").on(table.displayOrder, table.id),
    periodValid: check("budgets_period_valid", sql`${table.period} IN ('weekly', 'monthly', 'yearly')`),

    windowValid: check(
      "budgets_window_valid",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    goalValid: check(
      "budgets_goal_valid",
      sql`(
        ${table.goalName} IS NULL AND ${table.goalAmountCents} IS NULL
      ) OR (
        ${table.goalName} IS NOT NULL
        AND ${table.goalAmountCents} IS NOT NULL
        AND length(trim(${table.goalName})) > 0
        AND typeof(${table.goalAmountCents}) = 'integer'
        AND ${table.goalAmountCents} > 0
        AND ${table.period} = 'monthly'
        AND ${table.rollover} = 1
      )`,
    ),
  }),
);

export type Budget = typeof budgets.$inferSelect;
export type NewBudget = typeof budgets.$inferInsert;

export const budgetReallocationInputModes = ["amount", "percentage"] as const;
export type BudgetReallocationInputMode = (typeof budgetReallocationInputModes)[number];


export const budgetReallocations = sqliteTable(
  "budget_reallocations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    month: text("month").notNull(),
    fromCategoryId: integer("from_category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    toCategoryId: integer("to_category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull().$type<Cents>(),
    inputMode: text("input_mode", { enum: budgetReallocationInputModes }).notNull(),

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
