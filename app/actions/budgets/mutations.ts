import { and, asc, eq, sql } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";
import { withDb } from "@/lib/db/client";
import { budgets, categories, transactions, type Budget } from "@/lib/db/schema";
import { periodContaining } from "@/lib/budgets";
import { toDateKey, todayKey, type DateKey } from "@/lib/dates";
import { parseAmount } from "@/lib/money";
import { incomeBudgetRefusal } from "@/components/budgets/budget-view-logic";
import { str, parsePeriod, requireDateKey, goalFieldsFromFormData, type ActionResult } from "./shared";

export async function createBudget(formData: FormData): Promise<ActionResult<Budget>> {
  try {

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
    const rollover = formData.get("rollover") === "true";
    const goal = goalFieldsFromFormData(formData, period, rollover);

    const budget = await withDb(async (db) => {
      const [category] = await db.select().from(categories).where(eq(categories.id, categoryId));
      if (!category) throw new Error(`No category with id ${categoryId}`);




      if (category.type === "Income") throw new Error(incomeBudgetRefusal(category.name));

      let inheritedOrder: number | undefined;
      if (closePrevious) {
        const open = await db
          .select()
          .from(budgets)
          .where(and(eq(budgets.categoryId, categoryId), eq(budgets.period, period)));
        const dayBefore = previousDayKey(effectiveFrom);
        for (const row of open) {
          if (row.effectiveTo === null && row.effectiveFrom < effectiveFrom) {
            inheritedOrder = inheritedOrder === undefined
              ? row.displayOrder
              : Math.min(inheritedOrder, row.displayOrder);
            await db
              .update(budgets)
              .set({ effectiveTo: dayBefore, updatedAt: new Date() })
              .where(eq(budgets.id, row.id));
          }
        }
      }

      const [{ nextOrder }] = await db
        .select({
          nextOrder: sql<number>`COALESCE(MAX(${budgets.displayOrder}), -1) + 1`,
        })
        .from(budgets);

      const [row] = await db
        .insert(budgets)
        .values({
          categoryId,
          period,
          limitCents,
          effectiveFrom,
          effectiveTo,
          rollover,
          displayOrder: inheritedOrder ?? nextOrder,
          ...goal,
        })
        .returning();



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


export async function updateBudget(id: number, formData: FormData): Promise<ActionResult<Budget>> {
  try {
    const budget = await withDb(async (db) => {



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
        const rollover = formData.has("rollover")
          ? formData.get("rollover") === "true"
          : false;
        const goal = goalFieldsFromFormData(formData, period, rollover);
        const [{ nextOrder }] = await db
          .select({
            nextOrder: sql<number>`COALESCE(MAX(${budgets.displayOrder}), -1) + 1`,
          })
          .from(budgets);
        const [promoted] = await db
          .insert(budgets)
          .values({
            categoryId,
            period,
            limitCents:
              limitRaw === null ? category.monthlyLimitCents : parseAmount(limitRaw),
            effectiveFrom,
            effectiveTo,
            rollover,
            displayOrder: nextOrder,
            ...goal,
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
      const rollover = formData.has("rollover")
        ? formData.get("rollover") === "true"
        : existing.rollover;
      const goal = goalFieldsFromFormData(formData, period, rollover, {
        goalName: existing.goalName,
        goalAmountCents: existing.goalAmountCents,
      });

      const [row] = await db
        .update(budgets)
        .set({
          period,
          limitCents: limitRaw === null ? existing.limitCents : parseAmount(limitRaw),
          effectiveFrom,
          effectiveTo,
          rollover,
          ...goal,
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


export async function reorderBudgets(orderedIds: number[]): Promise<ActionResult<undefined>> {
  if (
    orderedIds.length === 0 ||
    orderedIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(orderedIds).size !== orderedIds.length
  ) {
    return { error: "The budget order is invalid. Refresh and try again." };
  }

  try {
    await withDb(async (db) => {
      const stored = await db
        .select({ id: budgets.id })
        .from(budgets)
        .orderBy(asc(budgets.displayOrder), asc(budgets.id));
      const storedIds = new Set(stored.map((row) => row.id));
      if (orderedIds.some((id) => !storedIds.has(id))) {
        throw new BudgetOrderConflictError();
      }

      const reorderedIds = new Set(orderedIds);
      let nextRequested = 0;
      const normalized = stored.map((row) => (
        reorderedIds.has(row.id) ? orderedIds[nextRequested++] : row.id
      ));
      const updatedAt = new Date();
      for (const [displayOrder, id] of normalized.entries()) {
        await db
          .update(budgets)
          .set({ displayOrder, updatedAt })
          .where(eq(budgets.id, id));
      }
    });
    revalidate("/budgets");
    return { success: true, data: undefined };
  } catch (error) {
    if (error instanceof BudgetOrderConflictError) return { error: error.message };
    console.error("Failed to reorder budgets:", error);
    return { error: "Failed to save the budget order." };
  }
}

class BudgetOrderConflictError extends Error {
  constructor() {
    super("One of these budgets changed. Refresh and try again.");
    this.name = "BudgetOrderConflictError";
  }
}


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


export async function importLegacyBudgets(): Promise<ActionResult<{ created: number }>> {
  try {
    const created = await withDb(async (db) => {
      const categoryRows = await db.select().from(categories);
      const existing = await db.select().from(budgets);


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
      let nextOrder = existing.reduce(
        (maximum, budget) => Math.max(maximum, budget.displayOrder),
        -1,
      ) + 1;
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
          displayOrder: nextOrder++,
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


function previousDayKey(key: DateKey): DateKey {
  const [y, m, d] = key.split("-").map(Number);
  return toDateKey(new Date(y, m - 1, d - 1));
}
