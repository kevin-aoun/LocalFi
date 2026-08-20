"use server";

import { readDb, withDb } from "@/lib/db/client";
import { categories, transactions } from "@/lib/db/schema";
import { asc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

const CATEGORY_TYPES = ["Income", "Expense", "Investment"] as const;
type CategoryType = (typeof CATEGORY_TYPES)[number];

function isCategoryType(value: string): value is CategoryType {
  return CATEGORY_TYPES.includes(value as CategoryType);
}

function revalidateCategorySurfaces() {
  revalidatePath("/budgets");
  revalidatePath("/transactions");
  revalidatePath("/recurring");
  revalidatePath("/settings");
  revalidatePath("/");
}

export async function getCategories() {
  return await readDb((db) => db.select().from(categories).orderBy(
    sql`CASE ${categories.type} WHEN 'Income' THEN 0 WHEN 'Expense' THEN 1 ELSE 2 END`,
    asc(categories.displayOrder),
    asc(categories.id),
  ));
}


function describeWriteFailure(error: unknown, name: string, verb: "create" | "update"): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed: categories\.name/i.test(message)) {
    return `A category named "${name}" already exists.`;
  }
  if (/CHECK constraint failed/i.test(message) || /NOT NULL constraint failed/i.test(message)) {
    return `That category is not valid: ${message}`;
  }
  return `Failed to ${verb} category.`;
}

export async function createCategory(formData: FormData) {
  const name = ((formData.get("name") as string) ?? "").trim();
  const typeValue = String(formData.get("type") ?? "");
  if (name === "") return { error: "A category needs a name." };
  if (!isCategoryType(typeValue)) return { error: "Choose a valid category type." };
  const type = typeValue;

  try {
    const category = await withDb(async (db) => {
      const [{ nextOrder }] = await db
        .select({
          nextOrder: sql<number>`COALESCE(MAX(${categories.displayOrder}), -1) + 1`,
        })
        .from(categories)
        .where(eq(categories.type, type));
      const [row] = await db
        .insert(categories)
        .values({
          name,
          type,
          displayOrder: nextOrder,
          icon: formData.get("icon") as string,
          color: formData.get("color") as string,
        })
        .returning();
      return row;
    });

    revalidateCategorySurfaces();
    return { success: true, data: category };
  } catch (error) {
    console.error("Failed to create category:", error);
    return { error: describeWriteFailure(error, name, "create") };
  }
}

export async function updateCategory(id: number, formData: FormData) {
  const name = ((formData.get("name") as string) ?? "").trim();
  const typeValue = String(formData.get("type") ?? "");
  if (name === "") return { error: "A category needs a name." };
  if (!isCategoryType(typeValue)) return { error: "Choose a valid category type." };
  const type = typeValue;

  try {
    const category = await withDb(async (db) => {
      const [existing] = await db
        .select({ type: categories.type })
        .from(categories)
        .where(eq(categories.id, id))
        .limit(1);
      if (!existing) throw new NotFoundError(`Category ${id} no longer exists.`);

      let displayOrder: number | undefined;
      if (existing.type !== type) {
        const [{ nextOrder }] = await db
          .select({
            nextOrder: sql<number>`COALESCE(MAX(${categories.displayOrder}), -1) + 1`,
          })
          .from(categories)
          .where(eq(categories.type, type));
        displayOrder = nextOrder;
      }
      const [row] = await db
        .update(categories)
        .set({
          name,
          type,
          ...(displayOrder === undefined ? {} : { displayOrder }),



          ...(type === "Income" ? { monthlyLimitCents: null } : {}),
          icon: formData.get("icon") as string,
          color: formData.get("color") as string,
          updatedAt: new Date(),
        })
        .where(eq(categories.id, id))
        .returning();
      return row;
    });

    revalidateCategorySurfaces();
    return { success: true, data: category };
  } catch (error) {
    if (error instanceof NotFoundError) return { error: error.message };
    console.error("Failed to update category:", error);
    return { error: describeWriteFailure(error, name, "update") };
  }
}

export async function reorderCategories(type: string, orderedIds: number[]) {
  if (!isCategoryType(type)) return { error: "Choose a valid category type." };
  if (
    orderedIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(orderedIds).size !== orderedIds.length
  ) {
    return { error: "The category order is invalid. Refresh and try again." };
  }

  try {
    await withDb(async (db) => {
      const rows = await db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.type, type))
        .orderBy(asc(categories.displayOrder), asc(categories.id));
      const storedIds = new Set(rows.map((row) => row.id));
      if (
        rows.length !== orderedIds.length ||
        orderedIds.some((id) => !storedIds.has(id))
      ) {
        throw new ReorderConflictError();
      }

      const updatedAt = new Date();
      for (const [displayOrder, id] of orderedIds.entries()) {
        await db
          .update(categories)
          .set({ displayOrder, updatedAt })
          .where(eq(categories.id, id));
      }
    });
    revalidateCategorySurfaces();
    return { success: true };
  } catch (error) {
    if (error instanceof ReorderConflictError) return { error: error.message };
    console.error("Failed to reorder categories:", error);
    return { error: "Failed to save the category order." };
  }
}


export async function countCategoryUsage(id: number): Promise<number> {
  const rows = await readDb((db) =>
    db.select().from(transactions).where(eq(transactions.categoryId, id)),
  );
  return rows.length;
}


export async function deleteCategory(id: number) {
  try {
    await withDb(async (db) => {
      const referencing = await db
        .select()
        .from(transactions)
        .where(eq(transactions.categoryId, id));

      if (referencing.length > 0) {
        const n = referencing.length;
        throw new CategoryInUseError(
          `This category is still used by ${n} transaction${n === 1 ? "" : "s"}. ` +
            `Reassign or delete ${n === 1 ? "it" : "them"} first, deleting the category ` +
            `would leave ${n === 1 ? "that transaction" : "those transactions"} out of every ` +
            `balance and breakdown.`,
        );
      }

      await db.delete(categories).where(eq(categories.id, id));
    });

    revalidateCategorySurfaces();
    return { success: true };
  } catch (error) {
    if (error instanceof CategoryInUseError) return { error: error.message };
    console.error("Failed to delete category:", error);
    return { error: "Failed to delete category." };
  }
}

class CategoryInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CategoryInUseError";
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

class ReorderConflictError extends Error {
  constructor() {
    super("Categories changed while you were reordering them. Refresh and try again.");
    this.name = "ReorderConflictError";
  }
}
