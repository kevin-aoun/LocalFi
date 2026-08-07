"use server";

/** Budget persistence; period and reallocation arithmetic lives in lib/budgets.ts. */
import { and, asc, eq } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";

import { readDb, withDb } from "@/lib/db/client";
import {
  budgetReallocations,
  budgets,
  categories,
  transactions,
  type Budget,
  type BudgetReallocation,
  type BudgetReallocationInputMode,
} from "@/lib/db/schema";
import {
  budgetInForce,
  budgetPerformance,
  budgetPeriods,
  budgetsFromLegacyLimits,
  monthlyReallocationAdjustment,
  periodContaining,
  spendVsBudget,
  type BudgetReallocationRow,
  type BudgetLedgerTransaction,
  type BudgetPeriod,
  type BudgetPeriodResult,
  type BudgetRow,
} from "@/lib/budgets";
import { isDateKey, toDateKey, todayKey, type DateKey } from "@/lib/dates";
import { formatMoney, parseAmount, type Cents } from "@/lib/money";
import { incomeBudgetRefusal } from "@/components/budgets/budget-view-logic";

export type ActionResult<T> = { success: true; data: T } | { error: string };

/** A performance row plus the category's display fields, for rendering. */
export type BudgetPerformanceRow = BudgetPeriodResult & {
  categoryName: string;
  categoryType: string;
  categoryColor: string;
  categoryIcon: string;
  /** True when this came from `categories.monthly_limit_cents`, not the budgets table. */
  legacy: boolean;
  /** Storage window, used when editing a budget from a period result. */
  effectiveFrom?: DateKey;
  effectiveTo?: DateKey | null;
};

function str(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function parsePeriod(value: string | null): BudgetPeriod {
  if (!value || !(budgetPeriods as readonly string[]).includes(value)) {
    throw new Error(`Invalid budget period: ${String(value)}. Expected one of ${budgetPeriods.join(", ")}`);
  }
  return value as BudgetPeriod;
}

function requireDateKey(value: string | null, label: string): DateKey {
  if (!isDateKey(value)) {
    throw new Error(`Invalid ${label}: expected 'YYYY-MM-DD', received ${JSON.stringify(value)}`);
  }
  return value;
}

/** Rows straight from the database, shaped for lib/budgets.ts. */
function toBudgetRow(row: Budget): BudgetRow {
  return {
    id: row.id,
    categoryId: row.categoryId,
    period: row.period,
    limitCents: row.limitCents,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    rollover: row.rollover,
  };
}

type LoadedLedger = {
  budgets: BudgetRow[];
  reallocations: BudgetReallocationRow[];
  /** ids of budgets that came from the legacy column (negative ids). */
  legacyIds: Set<number>;
  transactions: BudgetLedgerTransaction[];
  categories: Array<{ id: number; name: string; type: string; color: string; icon: string }>;
};

/**
 * Load everything the budget engine needs, in one pass, with the legacy fallback
 * applied.
 *
 * `earliestKey` is the day the legacy budgets are treated as effective from: the
 * first day of the month of the earliest transaction, so historical performance
 * covers the whole ledger. With no transactions at all it falls back to today.
 */
async function loadLedger(): Promise<LoadedLedger> {
  return readDb(async (db) => {
    const budgetRows = await db.select().from(budgets).orderBy(asc(budgets.id));
    const categoryRows = await db.select().from(categories).orderBy(asc(categories.id));
    const txRows = await db.select().from(transactions);
    const reallocationRows = await db
      .select()
      .from(budgetReallocations)
      .orderBy(asc(budgetReallocations.id));

    // DEFENSIVE READ PATH. An Income category cannot be given a budget any more,
    // but a row written before this rule (or straight into the database) must
    // not be measured as if a paycheque were spending: it would land in the
    // over-budget count and in the spending totals. Dropping it here keeps every
    // consumer — page, agent, CLI — consistent. The rows themselves are left
    // alone; `getBudgets()` still returns them so the page can report them.
    const incomeCategoryIds = new Set(
      categoryRows.filter((c) => c.type === "Income").map((c) => c.id),
    );

    const explicit = budgetRows.map(toBudgetRow).filter((b) => !incomeCategoryIds.has(b.categoryId));
    // Only a budget still IN FORCE masks the category's legacy monthly limit.
    // Counting closed rows as "covered" made that legacy value unreachable: the
    // category dropped out of the list entirely and importLegacyBudgets skipped
    // it too, so the limit could only be recovered by editing the database.
    const todayForCoverage = todayKey();
    const covered = new Set(
      explicit
        .filter((b) => b.effectiveTo === null || b.effectiveTo >= todayForCoverage)
        .map((b) => b.categoryId),
    );

    const earliest = txRows.reduce<Date | null>(
      (min, tx) => (min === null || tx.date < min ? tx.date : min),
      null,
    );
    // Always anchor to the START of a period. The empty-ledger fallback used a
    // bare `todayKey()`, so on a database with no transactions yet a legacy
    // budget became effective mid-month and was therefore not in force for the
    // month containing it — a brand-new user saw no budgets at all.
    const earliestKey = periodContaining(
      "monthly",
      earliest ? toDateKey(earliest) : todayKey(),
    ).startKey;

    const legacy = budgetsFromLegacyLimits(
      // Same rule for the legacy column: a monthly_limit_cents left on an Income
      // category is not a budget either.
      categoryRows.filter((c) => !covered.has(c.id) && !incomeCategoryIds.has(c.id)),
      earliestKey,
    );

    return {
      budgets: [...explicit, ...legacy],
      reallocations: reallocationRows.map((row) => ({
        id: row.id,
        month: row.month,
        fromCategoryId: row.fromCategoryId,
        toCategoryId: row.toCategoryId,
        amountCents: row.amountCents,
      })),
      legacyIds: new Set(legacy.map((b) => b.id)),
      transactions: txRows.map((tx) => ({
        categoryId: tx.categoryId,
        amountCents: tx.amountCents,
        dateKey: toDateKey(tx.date),
        pending: tx.pending,
        accountId: tx.accountId,
        transferAccountId: tx.transferAccountId,
      })),
      categories: categoryRows.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        color: c.color,
        icon: c.icon,
      })),
    };
  });
}

function decorate(results: BudgetPeriodResult[], loaded: LoadedLedger): BudgetPerformanceRow[] {
  const byId = new Map(loaded.categories.map((c) => [c.id, c]));
  const budgetById = new Map(loaded.budgets.map((budget) => [budget.id, budget]));
  return results.map((result) => {
    const category = byId.get(result.categoryId);
    const budget = budgetById.get(result.budgetId);
    return {
      ...result,
      categoryName: category?.name ?? `Category ${result.categoryId}`,
      categoryType: category?.type ?? "Expense",
      categoryColor: category?.color ?? "#888888",
      categoryIcon: category?.icon ?? "Circle",
      legacy: loaded.legacyIds.has(result.budgetId),
      effectiveFrom: budget?.effectiveFrom,
      effectiveTo: budget?.effectiveTo,
    };
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Every budget row, oldest first. Does NOT include the legacy fallback. */
export async function getBudgets(): Promise<Budget[]> {
  return readDb((db) => db.select().from(budgets).orderBy(asc(budgets.id)));
}

/** The budgets in force for one category, newest window first. */
export async function getBudgetsForCategory(categoryId: number): Promise<Budget[]> {
  return readDb((db) =>
    db
      .select()
      .from(budgets)
      .where(eq(budgets.categoryId, categoryId))
      .orderBy(asc(budgets.effectiveFrom)),
  );
}

/**
 * Spend vs budget for ONE period — the period containing `dateKey`, which may be
 * any past, present or future day. This is the query the old monthly-only,
 * current-month-only model could not express.
 */
export async function getSpendVsBudget(options?: {
  dateKey?: DateKey;
  period?: BudgetPeriod;
  categoryId?: number;
}): Promise<BudgetPerformanceRow[]> {
  const dateKey = options?.dateKey ?? todayKey();
  if (!isDateKey(dateKey)) throw new Error(`Invalid dateKey: ${String(dateKey)}`);

  const loaded = await loadLedger();
  const results = spendVsBudget({
    budgets: loaded.budgets,
    transactions: loaded.transactions,
    reallocations: loaded.reallocations,
    dateKey,
    period: options?.period,
    categoryId: options?.categoryId,
  });
  return decorate(results, loaded);
}

/**
 * Historical performance: one row per (category, period) in `[fromKey, toKey]`.
 * Rollover is simulated from each budget's own start, so the carry-over shown for
 * a period does not depend on how far back the caller asked.
 */
export async function getBudgetHistory(options: {
  fromKey: DateKey;
  toKey: DateKey;
  period?: BudgetPeriod;
  categoryId?: number;
}): Promise<BudgetPerformanceRow[]> {
  if (!isDateKey(options.fromKey)) throw new Error(`Invalid fromKey: ${String(options.fromKey)}`);
  if (!isDateKey(options.toKey)) throw new Error(`Invalid toKey: ${String(options.toKey)}`);

  const loaded = await loadLedger();
  const results = budgetPerformance({
    budgets: loaded.budgets,
    transactions: loaded.transactions,
    reallocations: loaded.reallocations,
    fromKey: options.fromKey,
    toKey: options.toKey,
    period: options.period,
    categoryId: options.categoryId,
  });
  return decorate(results, loaded);
}

export type BudgetReallocationView = BudgetReallocation & {
  fromCategoryName: string;
  toCategoryName: string;
};

function requireMonth(value: string | null): string {
  if (!value || value.length !== 7 || !isDateKey(`${value}-01`)) {
    throw new Error(`Invalid month: expected 'YYYY-MM', received ${JSON.stringify(value)}`);
  }
  return value;
}

/** Parse a percentage to basis points without float arithmetic (50.25 -> 5025). */
function parsePercentageBasisPoints(value: string | null): number {
  const raw = value?.trim().replace(/%$/, "") ?? "";
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) throw new Error("Enter a percentage between 0.01 and 100.");
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (basisPoints < 1 || basisPoints > 10_000) {
    throw new Error("Enter a percentage between 0.01 and 100.");
  }
  return basisPoints;
}

function monthlyBudgetFor(
  rows: readonly BudgetRow[],
  category: { id: number; monthlyLimitCents: Cents | null },
  monthStart: DateKey,
): BudgetRow | null {
  const explicit = budgetInForce(rows, category.id, monthStart, "monthly");
  if (explicit) return explicit;
  if (category.monthlyLimitCents === null) return null;
  return {
    id: -category.id,
    categoryId: category.id,
    period: "monthly",
    limitCents: category.monthlyLimitCents,
    effectiveFrom: monthStart,
    effectiveTo: null,
    rollover: false,
  };
}

/** Reallocations, oldest first, optionally restricted to one calendar month. */
export async function getBudgetReallocations(options?: {
  month?: string;
}): Promise<BudgetReallocationView[]> {
  const month = options?.month === undefined ? null : requireMonth(options.month);
  return readDb(async (db) => {
    const rows = month
      ? await db
          .select()
          .from(budgetReallocations)
          .where(eq(budgetReallocations.month, month))
          .orderBy(asc(budgetReallocations.id))
      : await db.select().from(budgetReallocations).orderBy(asc(budgetReallocations.id));
    const categoryRows = await db.select().from(categories);
    const names = new Map(categoryRows.map((category) => [category.id, category.name]));
    return rows.map((row) => ({
      ...row,
      fromCategoryName: names.get(row.fromCategoryId) ?? `Category ${row.fromCategoryId}`,
      toCategoryName: names.get(row.toCategoryId) ?? `Category ${row.toCategoryId}`,
    }));
  });
}

/**
 * Move part of one monthly budget to another for exactly one month.
 * Percentage entry is resolved against the source category's current allocation
 * for that month, after any earlier reallocations.
 * The resulting cents are stored, so later budget edits cannot rewrite history.
 */
export async function createBudgetReallocation(
  formData: FormData,
): Promise<ActionResult<BudgetReallocation>> {
  try {
    const month = requireMonth(str(formData, "month"));
    const fromCategoryId = Number(str(formData, "fromCategoryId"));
    const toCategoryId = Number(str(formData, "toCategoryId"));
    if (!Number.isInteger(fromCategoryId) || fromCategoryId <= 0) {
      return { error: "Choose the category to take budget from." };
    }
    if (!Number.isInteger(toCategoryId) || toCategoryId <= 0) {
      return { error: "Choose the category to give budget to." };
    }
    if (fromCategoryId === toCategoryId) {
      return { error: "Choose two different categories." };
    }
    const inputMode = str(formData, "inputMode") as BudgetReallocationInputMode | null;
    if (inputMode !== "amount" && inputMode !== "percentage") {
      return { error: "Choose an amount or percentage." };
    }
    const inputValue = str(formData, "value");
    if (inputValue === null) return { error: "Enter how much budget to move." };

    const row = await withDb(async (db) => {
      const categoryRows = await db.select().from(categories);
      const fromCategory = categoryRows.find((category) => category.id === fromCategoryId);
      const toCategory = categoryRows.find((category) => category.id === toCategoryId);
      if (!fromCategory) throw new Error(`No category with id ${fromCategoryId}`);
      if (!toCategory) throw new Error(`No category with id ${toCategoryId}`);
      if (fromCategory.type === "Income" || toCategory.type === "Income") {
        throw new Error("Budget can only be reallocated between spending categories.");
      }

      const storedBudgets = (await db.select().from(budgets)).map(toBudgetRow);
      const monthStart = `${month}-01` as DateKey;
      const sourceBudget = monthlyBudgetFor(storedBudgets, fromCategory, monthStart);
      const targetBudget = monthlyBudgetFor(storedBudgets, toCategory, monthStart);
      if (!sourceBudget) {
        throw new Error(`${fromCategory.name} has no monthly budget in ${month}.`);
      }
      if (!targetBudget) {
        throw new Error(`${toCategory.name} has no monthly budget in ${month}.`);
      }

      const existing = await db
        .select()
        .from(budgetReallocations)
        .where(eq(budgetReallocations.month, month));
      const existingRows: BudgetReallocationRow[] = existing.map((allocation) => ({
        id: allocation.id,
        month: allocation.month,
        fromCategoryId: allocation.fromCategoryId,
        toCategoryId: allocation.toCategoryId,
        amountCents: allocation.amountCents,
      }));
      const adjustedSourceCents =
        sourceBudget.limitCents +
        monthlyReallocationAdjustment(existingRows, fromCategoryId, month);

      const amountCents =
        inputMode === "amount"
          ? parseAmount(inputValue)
          : Math.round((adjustedSourceCents * parsePercentageBasisPoints(inputValue)) / 10_000);
      if (amountCents <= 0) throw new Error("The reallocated amount must be greater than zero.");
      if (amountCents > adjustedSourceCents) {
        throw new Error(
          `${fromCategory.name} only has ${formatMoney(adjustedSourceCents)} left to reallocate in ${month}.`,
        );
      }

      const [created] = await db
        .insert(budgetReallocations)
        .values({
          month,
          fromCategoryId,
          toCategoryId,
          amountCents,
          inputMode,
          inputValue,
        })
        .returning();
      return created;
    });

    revalidate("/budgets", "/");
    return { success: true, data: row };
  } catch (error) {
    console.error("Failed to reallocate budget:", error);
    return { error: (error as Error).message || "Failed to reallocate budget." };
  }
}

export async function deleteBudgetReallocation(
  id: number,
): Promise<ActionResult<{ id: number }>> {
  try {
    await withDb(async (db) => {
      const deleted = await db
        .delete(budgetReallocations)
        .where(eq(budgetReallocations.id, id))
        .returning({ id: budgetReallocations.id });
      if (deleted.length === 0) throw new Error(`No budget reallocation with id ${id}`);
    });
    revalidate("/budgets", "/");
    return { success: true, data: { id } };
  } catch (error) {
    console.error("Failed to delete budget reallocation:", error);
    return { error: (error as Error).message || "Failed to delete budget reallocation." };
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create a budget.
 *
 * Fields: categoryId, period, limit (decimal string), effectiveFrom, effectiveTo,
 * rollover, closePrevious.
 *
 * `closePrevious=true` (the default) closes the currently-open budget for the same
 * category and period the day before this one starts, which is what "change my
 * food budget from next month" means. Set it to "false" to keep overlapping rows,
 * in which case the latest `effectiveFrom` wins.
 *
 * REFUSED for an Income category: a budget is a spending limit. The check runs
 * before any write, so a refused create leaves the previously-open budget for
 * that category untouched.
 */
export async function createBudget(formData: FormData): Promise<ActionResult<Budget>> {
  try {
    // `str()` returns null for a missing or blank field, and `Number(null)` is 0
    // — which IS an integer, so the guard below never fired and the user saw a
    // thrown "No category with id 0" instead of this message.
    const categoryIdRaw = str(formData, "categoryId");
    const categoryId = categoryIdRaw === null ? Number.NaN : Number(categoryIdRaw);
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return { error: "A budget needs a category" };
    }
    const period = parsePeriod(str(formData, "period") ?? "monthly");
    const limitCents = parseAmount(str(formData, "limit") ?? "");
    const effectiveFrom = requireDateKey(
      str(formData, "effectiveFrom") ?? periodContaining(period, todayKey()).startKey,
      "effectiveFrom",
    );
    const effectiveToRaw = str(formData, "effectiveTo");
    const effectiveTo = effectiveToRaw === null ? null : requireDateKey(effectiveToRaw, "effectiveTo");
    if (effectiveTo !== null && effectiveTo < effectiveFrom) {
      return { error: "The budget's end date cannot be before its start date" };
    }
    const closePrevious = formData.get("closePrevious") !== "false";

    const budget = await withDb(async (db) => {
      const [category] = await db.select().from(categories).where(eq(categories.id, categoryId));
      if (!category) throw new Error(`No category with id ${categoryId}`);
      // THE GATE. The dialog no longer offers an Income category, but the UI is
      // not the only caller: the agent and the CLI reach this action directly.
      // Refusing before `closePrevious` matters — otherwise a rejected create
      // would still have closed the category's live budget.
      if (category.type === "Income") throw new Error(incomeBudgetRefusal(category.name));

      if (closePrevious) {
        const open = await db
          .select()
          .from(budgets)
          .where(and(eq(budgets.categoryId, categoryId), eq(budgets.period, period)));
        const dayBefore = previousDayKey(effectiveFrom);
        for (const row of open) {
          if (row.effectiveTo === null && row.effectiveFrom < effectiveFrom) {
            await db
              .update(budgets)
              .set({ effectiveTo: dayBefore, updatedAt: new Date() })
              .where(eq(budgets.id, row.id));
          }
        }
      }

      const [row] = await db
        .insert(budgets)
        .values({
          categoryId,
          period,
          limitCents,
          effectiveFrom,
          effectiveTo,
          rollover: formData.get("rollover") === "true",
        })
        .returning();
      // Once a real monthly rule exists, the legacy category column must stop
      // being a second source of truth. Otherwise deleting this row later makes
      // the old value silently reappear as a synthetic budget.
      if (period === "monthly" && category.monthlyLimitCents !== null) {
        await db
          .update(categories)
          .set({ monthlyLimitCents: null, updatedAt: new Date() })
          .where(eq(categories.id, categoryId));
      }
      return row;
    });

    revalidate("/budgets", "/");
    return { success: true, data: budget };
  } catch (error) {
    console.error("Failed to create budget:", error);
    return { error: (error as Error).message || "Failed to create budget" };
  }
}

/**
 * Update a budget. Only the fields present in `formData` change.
 *
 * REFUSED when the budget sits on an Income category — which can only happen to
 * a row that predates the rule. Editing it is not the way out; delete it.
 */
export async function updateBudget(id: number, formData: FormData): Promise<ActionResult<Budget>> {
  try {
    const budget = await withDb(async (db) => {
      // Negative ids identify the old category-level monthly limits. Editing one
      // promotes it atomically to a regular budget and clears the old field; the
      // UI need not expose a separate conversion workflow.
      if (id < 0) {
        const categoryId = -id;
        const [category] = await db.select().from(categories).where(eq(categories.id, categoryId));
        if (!category || category.monthlyLimitCents === null) {
          throw new Error(`No budget with id ${id}`);
        }
        if (category.type === "Income") throw new Error(incomeBudgetRefusal(category.name));

        const period = formData.has("period")
          ? parsePeriod(str(formData, "period"))
          : "monthly";
        const transactionRows = await db.select().from(transactions);
        const earliest = transactionRows.reduce<Date | null>(
          (min, tx) => (min === null || tx.date < min ? tx.date : min),
          null,
        );
        const fallbackFrom = periodContaining(
          period,
          earliest ? toDateKey(earliest) : todayKey(),
        ).startKey;
        const effectiveFrom = formData.has("effectiveFrom")
          ? requireDateKey(str(formData, "effectiveFrom"), "effectiveFrom")
          : fallbackFrom;
        const effectiveTo = formData.has("effectiveTo")
          ? (() => {
              const raw = str(formData, "effectiveTo");
              return raw === null ? null : requireDateKey(raw, "effectiveTo");
            })()
          : null;
        if (effectiveTo !== null && effectiveTo < effectiveFrom) {
          throw new Error("The budget's end date cannot be before its start date");
        }

        const limitRaw = str(formData, "limit");
        const [promoted] = await db
          .insert(budgets)
          .values({
            categoryId,
            period,
            limitCents:
              limitRaw === null ? category.monthlyLimitCents : parseAmount(limitRaw),
            effectiveFrom,
            effectiveTo,
            rollover: formData.has("rollover")
              ? formData.get("rollover") === "true"
              : false,
          })
          .returning();
        await db
          .update(categories)
          .set({ monthlyLimitCents: null, updatedAt: new Date() })
          .where(eq(categories.id, categoryId));
        return promoted;
      }

      const [existing] = await db.select().from(budgets).where(eq(budgets.id, id));
      if (!existing) throw new Error(`No budget with id ${id}`);
      const [category] = await db
        .select()
        .from(categories)
        .where(eq(categories.id, existing.categoryId));
      if (category?.type === "Income") throw new Error(incomeBudgetRefusal(category.name));

      const period = formData.has("period") ? parsePeriod(str(formData, "period")) : existing.period;
      const effectiveFrom = formData.has("effectiveFrom")
        ? requireDateKey(str(formData, "effectiveFrom"), "effectiveFrom")
        : existing.effectiveFrom;
      const effectiveTo = formData.has("effectiveTo")
        ? (() => {
            const raw = str(formData, "effectiveTo");
            return raw === null ? null : requireDateKey(raw, "effectiveTo");
          })()
        : existing.effectiveTo;
      if (effectiveTo !== null && effectiveTo < effectiveFrom) {
        throw new Error("The budget's end date cannot be before its start date");
      }
      const limitRaw = str(formData, "limit");

      const [row] = await db
        .update(budgets)
        .set({
          period,
          limitCents: limitRaw === null ? existing.limitCents : parseAmount(limitRaw),
          effectiveFrom,
          effectiveTo,
          rollover: formData.has("rollover")
            ? formData.get("rollover") === "true"
            : existing.rollover,
          updatedAt: new Date(),
        })
        .where(eq(budgets.id, id))
        .returning();
      if (
        category?.monthlyLimitCents !== null &&
        category?.monthlyLimitCents !== undefined &&
        (existing.period === "monthly" || period === "monthly")
      ) {
        await db
          .update(categories)
          .set({ monthlyLimitCents: null, updatedAt: new Date() })
          .where(eq(categories.id, existing.categoryId));
      }
      return row;
    });

    revalidate("/budgets", "/");
    return { success: true, data: budget };
  } catch (error) {
    console.error("Failed to update budget:", error);
    return { error: (error as Error).message || "Failed to update budget" };
  }
}

/**
 * Delete a budget row. History for the periods it covered disappears with it; to
 * stop a budget while keeping its history, set `effectiveTo` instead.
 */
export async function deleteBudget(id: number): Promise<ActionResult<{ id: number }>> {
  try {
    await withDb(async (db) => {
      if (id < 0) {
        const categoryId = -id;
        const [category] = await db
          .select()
          .from(categories)
          .where(eq(categories.id, categoryId));
        if (!category || category.monthlyLimitCents === null) {
          throw new Error(`No budget with id ${id}`);
        }
        await db
          .update(categories)
          .set({ monthlyLimitCents: null, updatedAt: new Date() })
          .where(eq(categories.id, categoryId));
        return;
      }

      const [existing] = await db.select().from(budgets).where(eq(budgets.id, id));
      if (!existing) throw new Error(`No budget with id ${id}`);

      const deleted = await db
        .delete(budgets)
        .where(eq(budgets.id, id))
        .returning({ id: budgets.id });
      if (deleted.length === 0) throw new Error(`No budget with id ${id}`);
      if (existing.period === "monthly") {
        // Migration 0003 copied category limits into `budgets` but deliberately
        // retained the old column. Delete means delete, so remove that fallback
        // in the same transaction instead of resurrecting it on the next read.
        await db
          .update(categories)
          .set({ monthlyLimitCents: null, updatedAt: new Date() })
          .where(eq(categories.id, existing.categoryId));
      }
    });
    revalidate("/budgets", "/");
    return { success: true, data: { id } };
  } catch (error) {
    console.error("Failed to delete budget:", error);
    return { error: (error as Error).message || "Failed to delete budget" };
  }
}

/**
 * Copy any remaining `categories.monthly_limit_cents` values into real `budgets`
 * rows. Idempotent: a category that already has a budget of that period is left
 * alone. The 0003 migration does this once; this action exists for a database
 * that was set up some other way.
 *
 * An Income category is skipped: converting its legacy limit would create
 * exactly the row `createBudget` refuses.
 */
export async function importLegacyBudgets(): Promise<ActionResult<{ created: number }>> {
  try {
    const created = await withDb(async (db) => {
      const categoryRows = await db.select().from(categories);
      const existing = await db.select().from(budgets);
      // Same rule as loadLedger: a closed budget must not block the import, or
      // the legacy limit it masks can never be recovered.
      const todayForCoverage = todayKey();
      const covered = new Set(
        existing
          .filter((b) => b.period === "monthly")
          .filter((b) => b.effectiveTo === null || b.effectiveTo >= todayForCoverage)
          .map((b) => b.categoryId),
      );
      const txRows = await db.select().from(transactions);
      const earliest = txRows.reduce<Date | null>(
        (min, tx) => (min === null || tx.date < min ? tx.date : min),
        null,
      );
      const effectiveFrom = earliest
        ? periodContaining("monthly", toDateKey(earliest)).startKey
        : todayKey();

      let count = 0;
      for (const category of categoryRows) {
        if (category.type === "Income") continue;
        if (category.monthlyLimitCents === null || covered.has(category.id)) continue;
        await db.insert(budgets).values({
          categoryId: category.id,
          period: "monthly",
          limitCents: category.monthlyLimitCents,
          effectiveFrom,
          effectiveTo: null,
          rollover: false,
        });
        count++;
      }
      return count;
    });

    revalidate("/budgets");
    return { success: true, data: { created } };
  } catch (error) {
    console.error("Failed to import legacy budgets:", error);
    return { error: (error as Error).message || "Failed to import legacy budgets" };
  }
}

/** 'YYYY-MM-DD' -> the previous calendar day, in local time. */
function previousDayKey(key: DateKey): DateKey {
  const [y, m, d] = key.split("-").map(Number);
  return toDateKey(new Date(y, m - 1, d - 1));
}
