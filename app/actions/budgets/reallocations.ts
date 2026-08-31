import { asc, eq } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";
import { readDb, withDb, type BudgetDb } from "@/lib/db/client";
import { budgetReallocations, budgets, categories, type BudgetReallocation, type BudgetReallocationInputMode } from "@/lib/db/schema";
import {
  budgetInForce,
  monthlyReallocationAdjustment,
  percentageOfBudgetCents,
  periodContaining,
  reallocationMaximumCents,
  spendInRange,
  type BudgetLedgerTransaction,
  type BudgetReallocationRow,
  type BudgetRow,
} from "@/lib/budgets";
import { isDateKey, type DateKey } from "@/lib/dates";
import { formatMoney, parseAmount, type Cents } from "@/lib/money";
import { readCategoryMovements } from "@/lib/ledger";
import { str, toBudgetRow, type ActionResult } from "./shared";

export type BudgetReallocationView = BudgetReallocation & {
  fromCategoryName: string;
  toCategoryName: string;
};

export type BudgetReallocationAvailability = {
  month: string;
  categoryId: number;
  categoryName: string;
  budgetedCents: Cents;
  spentCents: Cents;
  maximumCents: Cents;
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

function toExistingRows(rows: readonly BudgetReallocation[]): BudgetReallocationRow[] {
  return rows.map((allocation) => ({
    id: allocation.id,
    month: allocation.month,
    fromCategoryId: allocation.fromCategoryId,
    toCategoryId: allocation.toCategoryId,
    amountCents: allocation.amountCents,
  }));
}

function sourceSpending(
  raw: Parameters<typeof readCategoryMovements>[0],
  categoryId: number,
  month: string,
): Cents {
  const startKey = `${month}-01` as DateKey;
  const monthEnd = periodContaining("monthly", startKey).endKey;
  const movements = readCategoryMovements(raw, { fromKey: startKey, toKey: monthEnd });
  const currencies = new Set(movements.filter((movement) => movement.categoryId === categoryId).map((movement) => movement.currency));
  if (currencies.size > 1) {
    throw new Error("This category has spending in multiple currencies, so it cannot be reallocated.");
  }
  const transactions: BudgetLedgerTransaction[] = movements.map((movement) => ({
    categoryId: movement.categoryId,
    amountCents: Math.abs(movement.movementCents) as Cents,
    categoryMovementCents: movement.movementCents as Cents,
    dateKey: movement.dateKey,
    direction: "outflow",
    currency: movement.currency,
    pending: false,
    accountId: null,
    transferAccountId: null,
  }));
  return spendInRange(transactions, categoryId, startKey, monthEnd);
}

async function sourceAvailability(
  db: BudgetDb,
  raw: Parameters<typeof readCategoryMovements>[0],
  month: string,
  categoryId: number,
): Promise<BudgetReallocationAvailability> {
  const categoryRows = await db.select().from(categories);
  const category = categoryRows.find((row) => row.id === categoryId);
  if (!category) throw new Error(`No category with id ${categoryId}`);
  if (category.type === "Income") throw new Error("Budget can only be reallocated between spending categories.");
  const storedBudgets = (await db.select().from(budgets)).map(toBudgetRow);
  const sourceBudget = monthlyBudgetFor(storedBudgets, category, `${month}-01` as DateKey);
  if (!sourceBudget) throw new Error(`${category.name} has no monthly budget in ${month}.`);
  const existing = await db.select().from(budgetReallocations).where(eq(budgetReallocations.month, month));
  const budgetedCents = (
    sourceBudget.limitCents + monthlyReallocationAdjustment(toExistingRows(existing), categoryId, month)
  ) as Cents;
  const spentCents = sourceSpending(raw, categoryId, month);
  return {
    month,
    categoryId,
    categoryName: category.name,
    budgetedCents,
    spentCents,
    maximumCents: reallocationMaximumCents(budgetedCents, spentCents),
  };
}

export async function getBudgetReallocationAvailability(options: {
  month: string;
  categoryId: number;
}): Promise<BudgetReallocationAvailability> {
  const month = requireMonth(options.month);
  if (!Number.isInteger(options.categoryId) || options.categoryId <= 0) {
    throw new Error("Choose the category to take budget from.");
  }
  return readDb((db, raw) => sourceAvailability(db, raw, month, options.categoryId));
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

    const row = await withDb(async (db, raw) => {
      const categoryRows = await db.select().from(categories);
      const fromCategory = categoryRows.find((category) => category.id === fromCategoryId);
      const toCategory = categoryRows.find((category) => category.id === toCategoryId);
      if (!fromCategory) throw new Error(`No category with id ${fromCategoryId}`);
      if (!toCategory) throw new Error(`No category with id ${toCategoryId}`);
      if (fromCategory.type === "Income" || toCategory.type === "Income") {
        throw new Error("Budget can only be reallocated between spending categories.");
      }

      const monthStart = `${month}-01` as DateKey;
      const availability = await sourceAvailability(db, raw, month, fromCategoryId);
      const storedBudgets = (await db.select().from(budgets)).map(toBudgetRow);
      const targetBudget = monthlyBudgetFor(storedBudgets, toCategory, monthStart);
      if (!targetBudget) {
        throw new Error(`${toCategory.name} has no monthly budget in ${month}.`);
      }

      const amountCents =
        inputMode === "amount"
          ? parseAmount(inputValue)
          : percentageOfBudgetCents(availability.budgetedCents, parsePercentageBasisPoints(inputValue));
      if (amountCents <= 0) throw new Error("The reallocated amount must be greater than zero.");
      if (amountCents > availability.maximumCents) {
        throw new Error(
          `${fromCategory.name} only has ${formatMoney(availability.maximumCents)} unspent to reallocate in ${month}.`,
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
