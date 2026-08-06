"use server";

import { readDb, withDb, type BudgetDb } from "@/lib/db/client";
import { accounts, transactions } from "@/lib/db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";
import { syncCashAssetWithin } from "@/lib/db/sync-cash";
import { parseAmount } from "@/lib/money";

/**
 * Which account a new transaction belongs to.
 *
 * Read from the form when the caller supplies it; otherwise fall back to the
 * oldest non-archived asset account (the "Main" account the 0003 migration
 * seeds). Returns null only when the database has no accounts at all, in which
 * case the row lands in the "unassigned" bucket rather than being rejected —
 * `deriveAccountBalances` still counts it, so no money disappears.
 */
async function resolveAccountId(db: BudgetDb, formData: FormData): Promise<number | null> {
  const raw = formData.get("accountId");
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) throw new Error(`Invalid accountId: ${raw}`);
    return parsed;
  }
  const [fallback] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.archived, false), eq(accounts.kind, "asset")))
    .orderBy(asc(accounts.id))
    .limit(1);
  return fallback?.id ?? null;
}

export async function getTransactions(categoryId?: number) {
  return readDb(async (db) => {
    const all = await db.select().from(transactions);
    if (categoryId) {
      return all.filter((t) => t.categoryId === categoryId);
    }
    return all;
  });
}

/** Only the transfer rows, newest first — for a transfers view. */
export async function getTransfers() {
  return readDb((db) =>
    db.select().from(transactions).where(isNotNull(transactions.transferAccountId)),
  );
}

export async function syncCashAssetManually() {
  try {
    await withDb((db) => syncCashAssetWithin(db));
    revalidate("/");
    return { success: true };
  } catch (error) {
    console.error("Failed to sync cash asset:", error);
    return { error: "Failed to sync cash asset" };
  }
}

/**
 * Validate a date coming off a form.
 *
 * `new Date(<garbage>)` yields an Invalid Date, which SQLite happily stores as a
 * NaN timestamp — the row is then undated forever. `createTransfer` already
 * guarded this; `createTransaction` and `updateTransaction` did not.
 */
function requireFormDate(formData: FormData): Date {
  const raw = formData.get("date");
  const date = typeof raw === "string" && raw !== "" ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${JSON.stringify(raw)}`);
  }
  return date;
}

export async function createTransaction(formData: FormData) {
  try {
    const isPending = formData.get("pending") === "true";

    const transaction = await withDb(async (db) => {
      const [row] = await db.insert(transactions).values({
        date: requireFormDate(formData),
        categoryId: Number(formData.get("categoryId")),
        accountId: await resolveAccountId(db, formData),
        amountCents: parseAmount(formData.get("amount") as string),
        comment: (formData.get("comment") as string) || null,
        pending: isPending,
      }).returning();

      // Only sync balance for confirmed transactions
      if (!isPending) {
        await syncCashAssetWithin(db);
      }
      return row;
    });

    revalidate("/transactions", "/");
    return { success: true, data: transaction };
  } catch (error) {
    console.error("Failed to create transaction:", error);
    return { error: "Failed to create transaction" };
  }
}

export async function updateTransaction(id: number, formData: FormData) {
  try {
    const pendingValue = formData.get("pending");
    const isPending = pendingValue === "true";

    // An account is only reassigned when the form actually carries one, so an
    // edit through a form that predates accounts cannot silently move the row.
    const accountRaw = formData.get("accountId");
    const accountId =
      typeof accountRaw === "string" && accountRaw.trim() !== ""
        ? Number(accountRaw)
        : undefined;

    const transaction = await withDb(async (db) => {
      const [row] = await db.update(transactions)
        .set({
          date: requireFormDate(formData),
          categoryId: Number(formData.get("categoryId")),
          ...(accountId === undefined ? {} : { accountId }),
          amountCents: parseAmount(formData.get("amount") as string),
          comment: (formData.get("comment") as string) || null,
          pending: isPending,
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, id))
        .returning();

      // Always sync — the transaction may have changed from pending to confirmed or vice versa
      await syncCashAssetWithin(db);
      return row;
    });

    revalidate("/transactions", "/");
    return { success: true, data: transaction };
  } catch (error) {
    console.error("Failed to update transaction:", error);
    return { error: "Failed to update transaction" };
  }
}

export async function confirmTransaction(id: number, date: Date) {
  try {
    if (Number.isNaN(date.getTime())) return { error: "Invalid confirmation date" };

    const transaction = await withDb(async (db) => {
      const [row] = await db.update(transactions)
        .set({
          pending: false,
          date: date,
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, id))
        .returning();

      await syncCashAssetWithin(db);
      return row;
    });

    revalidate("/transactions", "/");
    return { success: true, data: transaction };
  } catch (error) {
    console.error("Failed to confirm transaction:", error);
    return { error: "Failed to confirm transaction" };
  }
}

export async function deleteTransaction(id: number) {
  try {
    await withDb(async (db) => {
      await db.delete(transactions).where(eq(transactions.id, id));
      // Sync Cash asset after deletion
      await syncCashAssetWithin(db);
    });

    revalidate("/transactions", "/");
    return { success: true };
  } catch (error) {
    console.error("Failed to delete transaction:", error);
    return { error: "Failed to delete transaction" };
  }
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/**
 * Move money between two of the user's own accounts.
 *
 * A transfer is a FIRST-CLASS transaction, not a category hack: one row carrying
 * both accounts, with NO category. Before accounts existed, moving money to
 * savings had to be entered as an "Investment" expense, which the app then booked
 * as a net-worth LOSS. This row type is net-neutral to net worth and is excluded
 * from income, expense and budget totals — see lib/cash-balance.ts.
 *
 * Fields: fromAccountId, toAccountId, amount, date, comment, pending.
 */
export async function createTransfer(formData: FormData) {
  try {
    const fromAccountId = Number(formData.get("fromAccountId"));
    const toAccountId = Number(formData.get("toAccountId"));
    if (!Number.isInteger(fromAccountId) || !Number.isInteger(toAccountId)) {
      return { error: "A transfer needs a source and a destination account" };
    }
    if (fromAccountId === toAccountId) {
      return { error: "A transfer must move money between two DIFFERENT accounts" };
    }

    const amountCents = parseAmount(formData.get("amount") as string);
    const dateRaw = formData.get("date");
    const date = typeof dateRaw === "string" && dateRaw !== "" ? new Date(dateRaw) : new Date();
    if (Number.isNaN(date.getTime())) return { error: "Invalid transfer date" };
    const isPending = formData.get("pending") === "true";

    const transfer = await withDb(async (db) => {
      const rows = await db.select().from(accounts);
      const known = new Set(rows.map((a) => a.id));
      if (!known.has(fromAccountId)) throw new Error(`No account with id ${fromAccountId}`);
      if (!known.has(toAccountId)) throw new Error(`No account with id ${toAccountId}`);

      const [row] = await db
        .insert(transactions)
        .values({
          date,
          categoryId: null, // a transfer is never income or expense
          accountId: fromAccountId,
          transferAccountId: toAccountId,
          amountCents,
          comment: (formData.get("comment") as string) || null,
          pending: isPending,
        })
        .returning();

      // Net-neutral to net worth, but the derived Cash asset is a whole-ledger
      // figure and must be recomputed through the one rule that owns it.
      await syncCashAssetWithin(db);
      return row;
    });

    revalidate("/transactions", "/");
    // `as const` keeps this a discriminated union: without it TS widens `true`
    // to `boolean` and callers cannot narrow on `success`.
    return { success: true as const, data: transfer };
  } catch (error) {
    console.error("Failed to create transfer:", error);
    return { error: (error as Error).message || "Failed to create transfer" };
  }
}

/** Edit an existing transfer. Both accounts, the amount, the date and the comment. */
export async function updateTransfer(id: number, formData: FormData) {
  try {
    const transfer = await withDb(async (db) => {
      const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!existing) throw new Error(`No transaction with id ${id}`);
      if (existing.transferAccountId === null) {
        throw new Error(`Transaction ${id} is not a transfer`);
      }

      const fromRaw = formData.get("fromAccountId");
      const toRaw = formData.get("toAccountId");
      const fromAccountId =
        typeof fromRaw === "string" && fromRaw.trim() !== "" ? Number(fromRaw) : existing.accountId;
      const toAccountId =
        typeof toRaw === "string" && toRaw.trim() !== "" ? Number(toRaw) : existing.transferAccountId;
      if (fromAccountId === toAccountId) {
        throw new Error("A transfer must move money between two DIFFERENT accounts");
      }

      const amountRaw = formData.get("amount");
      const dateRaw = formData.get("date");

      const [row] = await db
        .update(transactions)
        .set({
          accountId: fromAccountId,
          transferAccountId: toAccountId,
          categoryId: null,
          amountCents:
            typeof amountRaw === "string" && amountRaw.trim() !== ""
              ? parseAmount(amountRaw)
              : existing.amountCents,
          ...(typeof dateRaw === "string" && dateRaw !== "" ? { date: new Date(dateRaw) } : {}),
          comment: formData.has("comment")
            ? (formData.get("comment") as string) || null
            : existing.comment,
          pending: formData.has("pending")
            ? formData.get("pending") === "true"
            : existing.pending,
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, id))
        .returning();

      await syncCashAssetWithin(db);
      return row;
    });

    revalidate("/transactions", "/");
    // `as const` keeps this a discriminated union: without it TS widens `true`
    // to `boolean` and callers cannot narrow on `success`.
    return { success: true as const, data: transfer };
  } catch (error) {
    console.error("Failed to update transfer:", error);
    return { error: (error as Error).message || "Failed to update transfer" };
  }
}
