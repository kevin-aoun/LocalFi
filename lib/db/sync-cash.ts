/**
 * Keeps the derived "Cash" asset row in step with the ledger.
 *
 * This is glue, NOT a business rule: the rule itself is `deriveCashBalanceCents`
 * in lib/cash-balance.ts and is not restated here. The glue lives in its own
 * module because several server actions (transactions, recurring generation) must
 * run it, and a `"use server"` file may only export async functions — so they
 * cannot share a helper through one of those files without also making it a
 * server action.
 *
 * IMPORTANT: this takes an already-open drizzle handle and performs no locking or
 * flushing. Call it INSIDE a `withDb(...)` callback (or between getDb/saveDb).
 * Calling `withDb` from within `withDb` deadlocks — the lock is not reentrant.
 */
import { eq } from "drizzle-orm";
import { deriveCashBalanceCents } from "@/lib/cash-balance";
import type { Cents } from "@/lib/money";
import { assets, categories, transactions } from "./schema";
import type { BudgetDb } from "./client";

/**
 * Recompute the "Cash" asset from the whole ledger and write it back, creating
 * the row if it does not exist yet. Returns the balance it stored.
 */
export async function syncCashAssetWithin(db: BudgetDb): Promise<Cents> {
  const allTransactions = await db.select().from(transactions);
  const allCategories = await db.select().from(categories);

  const cashBalanceCents = deriveCashBalanceCents(allTransactions, allCategories);

  const allAssets = await db.select().from(assets);
  const cashAsset = allAssets.find((a) => a.category === "Cash");

  if (cashAsset) {
    await db
      .update(assets)
      .set({ currentValueCents: cashBalanceCents, updatedAt: new Date() })
      .where(eq(assets.id, cashAsset.id));
  } else {
    await db.insert(assets).values({
      category: "Cash",
      currentValueCents: cashBalanceCents,
      currency: "USD",
      notes: "Auto-calculated from transactions",
    });
  }

  return cashBalanceCents;
}
