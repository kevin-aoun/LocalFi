

import { asc } from "drizzle-orm";

import { readDb } from "@/lib/db/client";
import {
  budgetReallocations,
  budgets,
  categories,
  type Budget,
} from "@/lib/db/schema";
import {
  budgetPeriods,
  budgetsFromLegacyLimits,
  periodContaining,
  type BudgetLedgerTransaction,
  type BudgetPeriod,
  type BudgetPeriodResult,
  type BudgetReallocationRow,
  type BudgetRow,
} from "@/lib/budgets";
import { isDateKey, todayKey, type DateKey } from "@/lib/dates";
import { parseAmount, type Cents } from "@/lib/money";
import { readCategoryMovements } from "@/lib/ledger";

export type ActionResult<T> = { success: true; data: T } | { error: string };

export type BudgetPerformanceRow = BudgetPeriodResult & {
  categoryName: string;
  categoryType: string;
  categoryColor: string;
  categoryIcon: string;
  displayOrder: number;

  legacy: boolean;

  effectiveFrom?: DateKey;
  effectiveTo?: DateKey | null;
};

export function str(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export function parsePeriod(value: string | null): BudgetPeriod {
  if (!value || !(budgetPeriods as readonly string[]).includes(value)) {
    throw new Error(`Invalid budget period: ${String(value)}. Expected one of ${budgetPeriods.join(", ")}`);
  }
  return value as BudgetPeriod;
}

export function requireDateKey(value: string | null, label: string): DateKey {
  if (!isDateKey(value)) {
    throw new Error(`Invalid ${label}: expected 'YYYY-MM-DD', received ${JSON.stringify(value)}`);
  }
  return value;
}

export type BudgetGoalFields = {
  goalName: string | null;
  goalAmountCents: Cents | null;
};

export function validateGoalFields(
  period: BudgetPeriod,
  rollover: boolean,
  fields: BudgetGoalFields,
): BudgetGoalFields {
  const { goalName, goalAmountCents } = fields;
  if (goalName === null && goalAmountCents === null) return fields;
  if (goalName === null || goalAmountCents === null) {
    throw new Error("Enter both a goal name and a target amount, or clear both fields.");
  }
  if (goalAmountCents <= 0) throw new Error("A savings goal target must be greater than zero.");
  if (period !== "monthly") throw new Error("A savings goal requires a monthly budget.");
  if (!rollover) throw new Error("Turn on rollover to use a savings goal.");
  return fields;
}


export function goalFieldsFromFormData(
  formData: FormData,
  period: BudgetPeriod,
  rollover: boolean,
  existing: BudgetGoalFields = { goalName: null, goalAmountCents: null },
): BudgetGoalFields {
  const goalName = formData.has("goalName") ? str(formData, "goalName") : existing.goalName;
  const goalAmountRaw = formData.has("goalAmount") ? str(formData, "goalAmount") : null;
  const goalAmountCents = formData.has("goalAmount")
    ? goalAmountRaw === null
      ? null
      : parseAmount(goalAmountRaw)
    : existing.goalAmountCents;
  return validateGoalFields(period, rollover, { goalName, goalAmountCents });
}


export function toBudgetRow(row: Budget): BudgetRow {
  return {
    id: row.id,
    categoryId: row.categoryId,
    period: row.period,
    limitCents: row.limitCents,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    rollover: row.rollover,
    goalName: row.goalName,
    goalAmountCents: row.goalAmountCents,
    displayOrder: row.displayOrder,
  };
}

export type LoadedLedger = {
  budgets: BudgetRow[];
  reallocations: BudgetReallocationRow[];

  legacyIds: Set<number>;


  transactions: BudgetLedgerTransaction[];
  categories: Array<{ id: number; name: string; type: string; color: string; icon: string }>;
};


export async function loadLedger(): Promise<LoadedLedger> {
  return readDb(async (db, raw) => {
    const budgetRows = await db
      .select()
      .from(budgets)
      .orderBy(asc(budgets.displayOrder), asc(budgets.id));
    const categoryRows = await db.select().from(categories).orderBy(asc(categories.id));
    const categoryMovements = readCategoryMovements(raw);
    const reallocationRows = await db
      .select()
      .from(budgetReallocations)
      .orderBy(asc(budgetReallocations.id));







    const incomeCategoryIds = new Set(
      categoryRows.filter((c) => c.type === "Income").map((c) => c.id),
    );

    const explicit = budgetRows.map(toBudgetRow).filter((b) => !incomeCategoryIds.has(b.categoryId));




    const todayForCoverage = todayKey();
    const covered = new Set(
      explicit
        .filter((b) => b.effectiveTo === null || b.effectiveTo >= todayForCoverage)
        .map((b) => b.categoryId),
    );

    const allMovements = categoryMovements;
    const movementCurrencies = [...new Set(allMovements.map((movement) => movement.currency))].sort();
    if (movementCurrencies.length > 1) {
      throw new Error(
        `Budget actuals span ${movementCurrencies.join(", ")}; LocalFi has no FX model, so these amounts cannot be combined.`,
      );
    }
    const earliest = allMovements.reduce<DateKey | null>(
      (min, movement) => min === null || movement.dateKey < min ? movement.dateKey : min,
      null,
    );




    const earliestKey = periodContaining(
      "monthly",
      earliest ?? todayKey(),
    ).startKey;

    const legacy = budgetsFromLegacyLimits(


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
      transactions: allMovements.map((movement) => ({
        categoryId: movement.categoryId,
        amountCents: Math.abs(movement.movementCents) as Cents,
        categoryMovementCents: movement.movementCents as Cents,
        dateKey: movement.dateKey,
        direction: "outflow" as const,
        currency: movement.currency,
        pending: false,
        accountId: null,
        transferAccountId: null,
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

export function decorate(results: BudgetPeriodResult[], loaded: LoadedLedger): BudgetPerformanceRow[] {
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
      displayOrder: budget?.displayOrder ?? Number.MAX_SAFE_INTEGER,
      legacy: loaded.legacyIds.has(result.budgetId),
      effectiveFrom: budget?.effectiveFrom,
      effectiveTo: budget?.effectiveTo,
    };
  });
}
