"use server";

import { readDb, withDb } from "@/lib/db/client";
import { categories, transactions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getCategories() {
  return await readDb((db) => db.select().from(categories));
}

/**
 * Translate a SQLite constraint failure into something the user can act on.
 * Without this, a duplicate category name surfaced as the generic
 * "Failed to create category" — and because the dialog ignored the return value
 * entirely, as nothing at all.
 */
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
  const type = formData.get("type") as "Income" | "Expense" | "Investment";
  if (name === "") return { error: "A category needs a name." };

  try {
    const category = await withDb(async (db) => {
      const [row] = await db
        .insert(categories)
        .values({
          name,
          type,
          icon: formData.get("icon") as string,
          color: formData.get("color") as string,
        })
        .returning();
      return row;
    });

    revalidatePath("/budgets");
    return { success: true, data: category };
  } catch (error) {
    console.error("Failed to create category:", error);
    return { error: describeWriteFailure(error, name, "create") };
  }
}

export async function updateCategory(id: number, formData: FormData) {
  const name = ((formData.get("name") as string) ?? "").trim();
  const type = formData.get("type") as "Income" | "Expense" | "Investment";
  if (name === "") return { error: "A category needs a name." };

  try {
    const category = await withDb(async (db) => {
      const [row] = await db
        .update(categories)
        .set({
          name,
          type,
          // Budget limits belong to the budgets table. If an old category-level
          // limit becomes Income, clear it so it cannot reappear if the type is
          // changed back later; otherwise preserve it until edited/deleted as a budget.
          ...(type === "Income" ? { monthlyLimitCents: null } : {}),
          icon: formData.get("icon") as string,
          color: formData.get("color") as string,
          updatedAt: new Date(),
        })
        .where(eq(categories.id, id))
        .returning();
      if (!row) throw new NotFoundError(`Category ${id} no longer exists.`);
      return row;
    });

    revalidatePath("/budgets");
    return { success: true, data: category };
  } catch (error) {
    if (error instanceof NotFoundError) return { error: error.message };
    console.error("Failed to update category:", error);
    return { error: describeWriteFailure(error, name, "update") };
  }
}

/** How many transactions still point at this category. */
export async function countCategoryUsage(id: number): Promise<number> {
  const rows = await readDb((db) =>
    db.select().from(transactions).where(eq(transactions.categoryId, id)),
  );
  return rows.length;
}

/**
 * Delete a category, refusing when it would orphan transactions.
 *
 * WHY THE CHECK EXISTS: this action used to delete the row unconditionally, and
 * because foreign keys were historically OFF in this database the referencing
 * transactions survived pointing at a category id that no longer existed. It
 * ALREADY happened to the live database — two rows ended up with
 * `category_id = 0`, which makes them invisible to the cash balance and to every
 * breakdown (see lib/cash-balance.ts: an unknown category contributes nothing).
 * Money the user entered silently stopped counting.
 *
 * The referencing rows are counted and reported so the user can reassign or
 * delete them deliberately. Nothing is written when the delete is refused: the
 * refusal is raised as an exception INSIDE `withDb`, which discards the
 * in-memory image rather than flushing an unchanged one.
 */
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

    revalidatePath("/budgets");
    revalidatePath("/");
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
