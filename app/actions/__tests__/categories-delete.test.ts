/**
 * Regression tests for `deleteCategory` orphaning transactions (item 10) and for
 * the error values the dialogs now surface (item 5, server half).
 *
 * The live database already contains the damage this prevents: two transactions
 * ended up with `category_id = 0` after a category was deleted, which makes them
 * invisible to the cash balance and to every breakdown. Repairing those rows is
 * a migration's job; this file only proves it cannot happen again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDb, execOn, seedCategory, seedTransaction, type TempDb } from "./support/temp-db";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { createCategory, deleteCategory, updateCategory, countCategoryUsage, getCategories } =
  await import("../categories");

let temp: TempDb;

beforeEach(async () => {
  temp = await createTempDb();
});

afterEach(async () => {
  await temp.cleanup();
});

function categoryForm(over: Partial<Record<string, string>> = {}) {
  const fd = new FormData();
  fd.append("name", over.name ?? "Groceries");
  fd.append("type", over.type ?? "Expense");
  fd.append("icon", over.icon ?? "Wallet");
  fd.append("color", over.color ?? "#10b981");
  if (over.monthlyLimit !== undefined) fd.append("monthlyLimit", over.monthlyLimit);
  return fd;
}

describe("deleteCategory refuses to orphan transactions", () => {
  it("blocks the delete and says how many transactions are in the way", async () => {
    seedCategory(temp, { id: 1, name: "Groceries", type: "Expense" });
    seedTransaction(temp, { categoryId: 1, amountCents: 4500, dateKey: "2026-07-28" });
    seedTransaction(temp, { categoryId: 1, amountCents: 1200, dateKey: "2026-07-29" });

    const result = await deleteCategory(1);

    expect(result).toMatchObject({ error: expect.stringContaining("2 transactions") });
    expect(temp.query("SELECT id FROM categories")).toHaveLength(1);
    // And, crucially, the transactions still point at a category that exists.
    expect(temp.query("SELECT category_id FROM transactions")).toEqual([
      { category_id: 1 },
      { category_id: 1 },
    ]);
  });

  it("uses the singular when exactly one transaction blocks it", async () => {
    seedCategory(temp, { id: 1, name: "Groceries", type: "Expense" });
    seedTransaction(temp, { categoryId: 1, amountCents: 4500, dateKey: "2026-07-28" });

    const result = await deleteCategory(1);
    expect(result).toMatchObject({ error: expect.stringContaining("1 transaction.") });
  });

  it("counts PENDING transactions too — they are still real rows", async () => {
    seedCategory(temp, { id: 1, name: "Groceries", type: "Expense" });
    seedTransaction(temp, {
      categoryId: 1,
      amountCents: 4500,
      dateKey: "2026-07-28",
      pending: true,
    });

    expect(await deleteCategory(1)).toMatchObject({ error: expect.any(String) });
  });

  it("deletes a category nothing references", async () => {
    seedCategory(temp, { id: 1, name: "Groceries", type: "Expense" });
    seedCategory(temp, { id: 2, name: "Unused", type: "Expense" });
    seedTransaction(temp, { categoryId: 1, amountCents: 4500, dateKey: "2026-07-28" });

    expect(await deleteCategory(2)).toEqual({ success: true });
    expect(temp.query("SELECT id FROM categories ORDER BY id")).toEqual([{ id: 1 }]);
  });

  it("leaves the database byte-identical when it refuses", async () => {
    seedCategory(temp, { id: 1, name: "Groceries", type: "Expense" });
    seedTransaction(temp, { categoryId: 1, amountCents: 4500, dateKey: "2026-07-28" });

    // Touch the database once through the client so any lazy auto-migration has
    // already been flushed, then snapshot it.
    await getCategories();
    const { readFileSync } = await import("node:fs");
    const before = readFileSync(temp.file);

    await deleteCategory(1);

    expect(readFileSync(temp.file).equals(before)).toBe(true);
  });

  it("reports the usage count on its own, for the UI", async () => {
    seedCategory(temp, { id: 1, name: "Groceries", type: "Expense" });
    seedTransaction(temp, { categoryId: 1, amountCents: 4500, dateKey: "2026-07-28" });
    expect(await countCategoryUsage(1)).toBe(1);
    expect(await countCategoryUsage(99)).toBe(0);
  });

  it("fails closed when a transaction was orphaned before the fix landed", async () => {
    // Simulate the shape of the live damage: a row pointing at category 0.
    seedCategory(temp, { id: 1, name: "Groceries", type: "Expense" });
    execOn(temp, (db) => {
      db.run("PRAGMA foreign_keys = OFF");
      db.run(
        "INSERT INTO transactions (date, category_id, amount_cents, comment, pending) VALUES (0, 0, 100, 'orphan', 1)",
      );
    });

    // DECISION: DEC-005 — database readiness refuses pre-existing FK
    // corruption before any product query or delete can run.
    const result = await deleteCategory(1);
    expect(result).toMatchObject({ error: "Failed to delete category." });
    // The failed startup leaves both the referenced category and the orphan
    // untouched. Repairing existing corruption is a migration/recovery job,
    // not a destructive action side effect.
    expect(temp.query("SELECT id FROM categories")).toEqual([{ id: 1 }]);
    expect(temp.query("SELECT category_id FROM transactions")).toEqual([{ category_id: 0 }]);
  });
});

describe("category writes report their failures instead of pretending to succeed", () => {
  it("names the conflict when a category name is already taken", async () => {
    expect(await createCategory(categoryForm({ name: "Groceries" }))).toMatchObject({
      success: true,
    });

    const duplicate = await createCategory(categoryForm({ name: "Groceries" }));
    expect(duplicate).toEqual({ error: 'A category named "Groceries" already exists.' });
    expect(temp.query("SELECT id FROM categories")).toHaveLength(1);
  });

  it("rejects a blank name", async () => {
    expect(await createCategory(categoryForm({ name: "   " }))).toEqual({
      error: "A category needs a name.",
    });
  });

  it("reports an update that collides with another name", async () => {
    await createCategory(categoryForm({ name: "Groceries" }));
    await createCategory(categoryForm({ name: "Rent" }));
    const [, rent] = await getCategories();

    expect(await updateCategory(rent.id, categoryForm({ name: "Groceries" }))).toEqual({
      error: 'A category named "Groceries" already exists.',
    });
    // The original name survived.
    expect(temp.query("SELECT name FROM categories ORDER BY id")).toEqual([
      { name: "Groceries" },
      { name: "Rent" },
    ]);
  });

  it("reports an update to a category that no longer exists", async () => {
    expect(await updateCategory(4242, categoryForm())).toEqual({
      error: "Category 4242 no longer exists.",
    });
  });
});

describe("category writes do not create budget limits", () => {
  it("ignores the retired monthlyLimit field on create", async () => {
    await createCategory(categoryForm({ name: "Coffee", monthlyLimit: "50" }));
    expect(temp.query("SELECT monthly_limit_cents FROM categories")).toEqual([
      { monthly_limit_cents: null },
    ]);
  });

  it("preserves an old limit while editing a non-income category", async () => {
    seedCategory(temp, {
      id: 1,
      name: "Coffee",
      type: "Expense",
      monthlyLimitCents: 5_000,
    });
    await updateCategory(1, categoryForm({ name: "Coffee & Tea", monthlyLimit: "0" }));
    expect(temp.query("SELECT monthly_limit_cents FROM categories")).toEqual([
      { monthly_limit_cents: 5_000 },
    ]);
  });

  it("clears an old spending limit when its category becomes Income", async () => {
    seedCategory(temp, {
      id: 1,
      name: "Coffee",
      type: "Expense",
      monthlyLimitCents: 5_000,
    });
    await updateCategory(1, categoryForm({ name: "Coffee refund", type: "Income" }));
    expect(temp.query("SELECT monthly_limit_cents FROM categories")).toEqual([
      { monthly_limit_cents: null },
    ]);
  });
});
