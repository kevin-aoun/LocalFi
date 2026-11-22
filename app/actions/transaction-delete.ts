// Transaction delete plumbing shared by Server Actions. Deliberately not "use server": these helpers
// take a database handle and are not endpoints.

import type { Database } from "sql.js";
import { and, asc, desc, eq } from "drizzle-orm";

import type { BudgetDb } from "@/lib/db/client";
import { transactionAllocations, transactions, type Transaction } from "@/lib/db/schema";
import { toDateKey } from "@/lib/dates";
import { buildProjectedTransactionMovements, deleteLedgerEventInput, postLedgerEventRaw } from "@/lib/ledger";
import { syncPositionHoldingProjection } from "@/lib/investments";
import { assertAvailableInvestmentUnits } from "@/lib/investments/trades";
import type { Cents } from "@/lib/money";

export type AllocationInput = { categoryId: number; amountCents: Cents };

export type TransactionState = Pick<
  Transaction,
  | "id"
  | "date"
  | "categoryId"
  | "accountId"
  | "transferAccountId"
  | "amountCents"
  | "direction"
  | "currency"
  | "instrumentId"
  | "quantityDelta"
  | "transferPrincipalAmountCents"
  | "feeForTransferId"
  | "comment"
  | "pending"
  | "recurringId"
  | "recurringOccurrence"
  | "createdAt"
  | "updatedAt"
  | "currentEventId"
>;

export async function loadAllocations(db: BudgetDb, transactionId: number): Promise<AllocationInput[]> {
  const rows = await db
    .select({ categoryId: transactionAllocations.categoryId, amountCents: transactionAllocations.amountCents })
    .from(transactionAllocations)
    .where(eq(transactionAllocations.transactionId, transactionId))
    .orderBy(asc(transactionAllocations.position));
  return rows;
}

export async function linkedTransferFee(db: BudgetDb, transferId: number) {
  const [fee] = await db.select().from(transactions).where(eq(transactions.feeForTransferId, transferId));
  return fee;
}

export async function deleteTransactionWithin(db: BudgetDb, raw: Database, existing: TransactionState): Promise<void> {
  const fee = await linkedTransferFee(db, existing.id);
  if (fee) await deleteTransactionWithin(db, raw, fee);
  if (!existing.pending) {
    if (!existing.currentEventId) throw new Error("Confirmed transaction is missing its current ledger event");
    const allocations = await loadAllocations(db, existing.id);
    postLedgerEventRaw(raw, deleteLedgerEventInput(existing.currentEventId, buildProjectedTransactionMovements(raw, existing, allocations), {
      effectiveDate: toDateKey(existing.date), description: existing.comment ?? "",
      metadata: { projectionKey: existing.id, transaction: null },
    }));
  }
  await db.delete(transactions).where(eq(transactions.id, existing.id));
  if (existing.instrumentId) {
    if (!existing.pending) assertAvailableInvestmentUnits(raw, existing.instrumentId, existing.currency);
    syncPositionHoldingProjection(raw, existing.instrumentId, existing.currency);
  }
}

/**
 * Deletes every buy and sell of one holding, newest first so a sale never outlives the units it
 * sold. Returns how many were confirmed, so the caller knows whether cash changed.
 */
export async function deleteHoldingTransactionsWithin(
  db: BudgetDb,
  raw: Database,
  instrumentId: string,
  currency: string,
): Promise<number> {
  const rows = await db.select().from(transactions)
    .where(and(eq(transactions.instrumentId, instrumentId), eq(transactions.currency, currency)))
    .orderBy(desc(transactions.date), desc(transactions.id));
  for (const row of rows) await deleteTransactionWithin(db, raw, row);
  return rows.filter((row) => !row.pending).length;
}
