"use server";

/**
 * Batch spreadsheet import.
 *
 * WHY THIS FILE EXISTS: the import dialog used to call the single-row
 * `createTransaction` action once per spreadsheet line. Because the whole
 * database is a single sql.js file, every one of those calls did a full file
 * read, a full-ledger cash re-derivation and a full file write — O(n) complete
 * database rewrites for an n-row import — and there was no transaction, so a
 * failure on row 40 left rows 1..39 committed with no way back, and re-running
 * the import silently doubled every row.
 *
 * Everything below happens inside ONE `withDb` call:
 *   - validate every row first, and insert nothing at all if any row is bad;
 *   - drop rows that already exist (see `dedupeKey`) and rows repeated within
 *     the same batch, reporting how many were skipped;
 *   - insert the survivors;
 *   - re-derive the Cash asset ONCE, from the full ledger.
 *
 * If anything throws, `withDb` discards the in-memory image and nothing is
 * written, so a partial import cannot reach disk.
 */

import { eq } from "drizzle-orm";

import { withDb } from "@/lib/db/client";
import { accounts, categories, transactions } from "@/lib/db/schema";
import { revalidatePath } from "next/cache";
import { syncCashAssetWithin } from "@/lib/db/sync-cash";
import { dedupeKey } from "@/components/transactions/import-logic";
import { fromDateKey, isDateKey, toDateKey } from "@/lib/dates";
import { absCents, tryParseAmount, type Cents } from "@/lib/money";

/** One reviewed row, as the dialog sends it. */
export type ImportRowInput = {
  /** 'YYYY-MM-DD' — a calendar day, never an instant. */
  date: string;
  categoryId: number;
  /** Decimal string, e.g. "45.5". Parsed with `tryParseAmount`; sign ignored. */
  amount: string;
  comment: string;
};

export type ImportOptions = {
  /**
   * Account every imported row is filed against. Omit (or pass null) to leave
   * them unassigned, which is what pre-accounts imports did — those rows land in
   * the explicit "unassigned" bucket of `deriveAccountBalances`, so no money
   * disappears either way.
   *
   * Deliberately NOT part of `dedupeKey`: the same statement line imported twice
   * is the same transaction whichever account it is filed against, so including
   * it would let a re-import double the ledger.
   */
  accountId?: number | null;
};

export type ImportOutcome =
  | {
      success: true;
      inserted: number;
      /** Rows skipped because an identical transaction already existed. */
      duplicates: number;
      /** Rows skipped because the same row appeared twice in this batch. */
      repeated: number;
    }
  | { error: string };

/**
 * Insert a reviewed batch of transactions atomically.
 *
 * Returns `{ error }` — with NOTHING written — when any row fails validation.
 * That is deliberate: a spreadsheet is imported as a unit, and a half-imported
 * file is worse than no import at all.
 */
export async function importTransactions(
  rows: ImportRowInput[],
  options?: ImportOptions,
): Promise<ImportOutcome> {
  if (!Array.isArray(rows)) {
    return { error: "Nothing to import." };
  }
  if (rows.length === 0) {
    return { success: true, inserted: 0, duplicates: 0, repeated: 0 };
  }

  const accountId = options?.accountId ?? null;
  if (accountId !== null && !Number.isInteger(accountId)) {
    return { error: `Invalid account: ${JSON.stringify(String(options?.accountId))}.` };
  }

  // ---- Validate everything BEFORE opening the database -------------------
  type Prepared = { dateKey: string; categoryId: number; amountCents: Cents; comment: string | null };
  const prepared: Prepared[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const label = `Row ${i + 1}`;

    if (!row || typeof row !== "object") return { error: `${label}: malformed row.` };
    if (!isDateKey(row.date)) {
      return { error: `${label}: ${JSON.stringify(String(row?.date))} is not a valid date (expected YYYY-MM-DD).` };
    }
    if (!Number.isInteger(row.categoryId) || row.categoryId <= 0) {
      return { error: `${label}: no category selected.` };
    }
    const parsed = tryParseAmount(row.amount);
    if (parsed === null) {
      return { error: `${label}: ${JSON.stringify(String(row.amount))} is not a valid amount.` };
    }

    prepared.push({
      dateKey: row.date,
      categoryId: row.categoryId,
      // The stored amount is a magnitude; the category decides the direction.
      // See the sign rule in components/transactions/import-logic.ts.
      amountCents: absCents(parsed),
      comment: typeof row.comment === "string" && row.comment.trim() !== "" ? row.comment : null,
    });
  }

  try {
    const outcome = await withDb(async (db) => {
      const allCategories = await db.select().from(categories);
      const knownIds = new Set(allCategories.map((c) => c.id));
      const unknown = prepared.find((p) => !knownIds.has(p.categoryId));
      if (unknown) {
        throw new ImportValidationError(
          `Category ${unknown.categoryId} does not exist. Nothing was imported.`,
        );
      }

      if (accountId !== null) {
        const [account] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId));
        if (!account) {
          throw new ImportValidationError(
            `Account ${accountId} does not exist. Nothing was imported.`,
          );
        }
      }

      // Duplicate detection against what is already on the ledger.
      const existing = await db.select().from(transactions);
      const seen = new Set(
        existing.map((tx) =>
          dedupeKey({
            date: toDateKey(tx.date),
            amountCents: tx.amountCents,
            categoryId: tx.categoryId ?? null,
            comment: tx.comment,
          }),
        ),
      );

      let duplicates = 0;
      let repeated = 0;
      const batch: Prepared[] = [];
      const batchKeys = new Set<string>();

      for (const row of prepared) {
        const key = dedupeKey({
          date: row.dateKey,
          amountCents: row.amountCents,
          categoryId: row.categoryId,
          comment: row.comment,
        });
        if (seen.has(key)) {
          duplicates += 1;
          continue;
        }
        if (batchKeys.has(key)) {
          repeated += 1;
          continue;
        }
        batchKeys.add(key);
        batch.push(row);
      }

      if (batch.length > 0) {
        // One multi-row INSERT, not one write per row.
        await db.insert(transactions).values(
          batch.map((row) => ({
            // Local midnight, so the stored instant reads back as the calendar
            // day the spreadsheet named in every timezone.
            date: fromDateKey(row.dateKey),
            categoryId: row.categoryId,
            accountId,
            amountCents: row.amountCents,
            comment: row.comment,
            pending: false,
          })),
        );

        // ONCE, from the full ledger — not once per row. Safe here because we
        // are already inside `withDb`, which is what this helper requires.
        await syncCashAssetWithin(db);
      }

      return { success: true as const, inserted: batch.length, duplicates, repeated };
    });

    revalidatePath("/transactions");
    revalidatePath("/");
    return outcome;
  } catch (error) {
    if (error instanceof ImportValidationError) {
      return { error: error.message };
    }
    console.error("Failed to import transactions:", error);
    return { error: "Failed to import transactions. Nothing was saved." };
  }
}

/** Thrown inside `withDb` so the transaction is discarded, then translated. */
class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}
