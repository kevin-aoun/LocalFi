import { asc, eq } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";
import { readDb, withDb } from "@/lib/db/client";
import { budgetReallocations, budgets, categories, type BudgetReallocation, type BudgetReallocationInputMode } from "@/lib/db/schema";
import { budgetInForce, monthlyReallocationAdjustment, type BudgetReallocationRow, type BudgetRow } from "@/lib/budgets";
import { isDateKey, type DateKey } from "@/lib/dates";
import { formatMoney, parseAmount, type Cents } from "@/lib/money";
import { str, toBudgetRow, type ActionResult } from "./shared";

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
