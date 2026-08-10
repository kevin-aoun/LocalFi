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
import {
  deriveCashBalanceCents,
  normalizeLedgerCurrency,
  type CashLedgerCategory,
  type CashLedgerTransaction,
} from "@/lib/cash-balance";
import type { Cents } from "@/lib/money";
import { assets, categories, ledgerProjectionState, transactions } from "./schema";
import type { BudgetDb } from "./client";

export const CASH_PROJECTION_MARKER_PREFIX = "cash:";

type CashAssetIdentity = {
  id: number;
  currency: unknown;
};

export type CashProjectionTarget<T extends CashAssetIdentity> =
  | { kind: "invalid-marker" }
  | {
      kind: "legacy" | "managed";
      asset: T | null;
      currency: string;
      marker: string | null;
    };

export function cashProjectionMarker(currency: unknown, assetId: number): string {
  const normalizedCurrency = normalizeLedgerCurrency(currency);
  if (!Number.isSafeInteger(assetId) || assetId <= 0) {
    throw new Error("Cash projection asset ID is invalid");
  }
  return `${CASH_PROJECTION_MARKER_PREFIX}${normalizedCurrency}:${assetId}`;
}

/** Shared marker parser/selector for live sync and raw CONTRACT-014 recovery. */
export function selectCashProjectionTarget<T extends CashAssetIdentity>(
  projectionNames: readonly string[],
  cashAssets: readonly T[],
): CashProjectionTarget<T> {
  const markerNames = projectionNames.filter((name) =>
    name.toLowerCase().startsWith(CASH_PROJECTION_MARKER_PREFIX));
  if (markerNames.length === 0) {
    const asset = [...cashAssets].sort((a, b) => a.id - b.id)[0] ?? null;
    return {
      kind: "legacy",
      asset,
      currency: normalizeLedgerCurrency(asset?.currency, "USD"),
      marker: null,
    };
  }
  if (markerNames.length !== 1) return { kind: "invalid-marker" };
  const match = /^cash:([A-Z]{3}):([1-9][0-9]*)$/.exec(markerNames[0]);
  if (!match) return { kind: "invalid-marker" };
  const assetId = Number(match[2]);
  if (!Number.isSafeInteger(assetId) || assetId <= 0) return { kind: "invalid-marker" };
  return {
    kind: "managed",
    asset: cashAssets.find((asset) => asset.id === assetId) ?? null,
    currency: match[1],
    marker: markerNames[0],
  };
}

export type CashAssetProjection = {
  currentValueCents: Cents;
  currency: string;
};

/** Shared CONTRACT-014 projection rule for the provenance-marked Cash row. */
export function deriveCashAssetProjection(
  ledgerTransactions: readonly CashLedgerTransaction[],
  ledgerCategories: readonly CashLedgerCategory[],
  storedCurrency?: unknown,
): CashAssetProjection {
  const currency = normalizeLedgerCurrency(storedCurrency, "USD");
  return {
    currentValueCents: deriveCashBalanceCents(ledgerTransactions, ledgerCategories, { currency }),
    currency,
  };
}

/**
 * Recompute the "Cash" asset from the whole ledger and write it back, creating
 * the row if it does not exist yet. Returns the balance it stored.
 */
export async function syncCashAssetWithin(db: BudgetDb): Promise<Cents> {
  const allTransactions = await db.select().from(transactions);
  const allCategories = await db.select().from(categories);
  const cashAssets = await db
    .select()
    .from(assets)
    .where(eq(assets.category, "Cash"))
    .orderBy(assets.id);
  const projectionNames = (await db
    .select({ projection: ledgerProjectionState.projection })
    .from(ledgerProjectionState))
    .map((row) => row.projection);
  const target = selectCashProjectionTarget(projectionNames, cashAssets);
  if (target.kind === "invalid-marker") {
    throw new Error("Cash projection marker state is invalid");
  }
  // DECISION: DEC-004 — the compatibility Cash row has one stored
  // denomination, so it mirrors only transaction facts in that denomination.
  const projection = deriveCashAssetProjection(
    allTransactions,
    allCategories,
    target.currency,
  );

  let managedAssetId: number;
  if (target.asset) {
    await db
      .update(assets)
      .set({ ...projection, updatedAt: new Date() })
      .where(eq(assets.id, target.asset.id));
    managedAssetId = target.asset.id;
  } else {
    const [created] = await db
      .insert(assets)
      .values({
        category: "Cash",
        ...projection,
        notes: `Auto-calculated from ${projection.currency} transactions`,
      })
      .returning({ id: assets.id });
    if (!created) throw new Error("Cash projection row could not be created");
    managedAssetId = created.id;
  }

  const nextMarker = cashProjectionMarker(projection.currency, managedAssetId);
  if (target.marker !== nextMarker) {
    await db.insert(ledgerProjectionState).values({ projection: nextMarker });
    if (target.marker !== null) {
      await db
        .delete(ledgerProjectionState)
        .where(eq(ledgerProjectionState.projection, target.marker));
    }
  }

  return projection.currentValueCents;
}
