"use server";

import type { Database } from "sql.js";

import { readDb, withDb, type BudgetDb } from "@/lib/db/client";
import {
  accounts,
  categories,
  transactionAllocations,
  transactions,
  type Transaction,
  type TransactionDirection,
} from "@/lib/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";
import { syncCashAssetWithin } from "@/lib/db/sync-cash";
import { parseAmount, type Cents } from "@/lib/money";
import { categoryCashDirection, normalizeLedgerCurrency } from "@/lib/cash-balance";
import { fromDateKey, isDateKey, toDateKey, type DateKey } from "@/lib/dates";
import {
  buildProjectedTransactionMovements,
  buildTransactionProjection,
  correctLedgerEventInput,
  deleteLedgerEventInput,
  postLedgerEventRaw,
  projectionEpochSeconds,
  readCategoryMovements,
} from "@/lib/ledger";
import {
  prepareInvestmentPurchase,
  previewPurchaseQuantity,
  projectPositionHolding,
  syncPositionHoldingProjection,
  type PreparedInvestmentPurchase,
} from "@/lib/investments";
import { describePriceError, fetchPriceQuote, pricedHolding } from "@/lib/prices";

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

function requireId(value: FormDataEntryValue | null, label: string): number {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}: ${String(value)}`);
  return parsed;
}

function requireMagnitude(cents: Cents, label = "Amount"): Cents {
  if (cents < 0) throw new Error(`${label} cannot be negative`);
  return cents;
}

async function accountCurrency(db: BudgetDb, accountId: number | null): Promise<string> {
  if (accountId === null) return "USD";
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw new Error(`No account with id ${accountId}`);
  return normalizeLedgerCurrency(account.currency);
}

async function categoryDirection(
  db: BudgetDb,
  categoryId: number,
): Promise<Exclude<TransactionDirection, "transfer">> {
  const [category] = await db.select().from(categories).where(eq(categories.id, categoryId));
  if (!category) throw new Error(`No category with id ${categoryId}`);
  const direction = categoryCashDirection(category.type);
  if (direction !== "inflow" && direction !== "outflow") {
    throw new Error(`Category ${categoryId} has no cash direction`);
  }
  return direction;
}

export async function getTransactions(categoryId?: number) {
  return readDb(async (db) => {
    const all = await db.select().from(transactions);
    const allocations = await db
      .select()
      .from(transactionAllocations)
      .orderBy(asc(transactionAllocations.transactionId), asc(transactionAllocations.position));
    const rows = all.map((transaction) => ({
      ...transaction,
      allocations: allocations
        .filter((allocation) => allocation.transactionId === transaction.id)
        .map(({ categoryId: allocationCategoryId, amountCents }) => ({
          categoryId: allocationCategoryId,
          amountCents,
        })),
    }));
    return categoryId ? rows.filter((transaction) => transaction.categoryId === categoryId) : rows;
  });
}

/** Canonical report/budget facts; mutable transaction rows are UI projections only. */
export async function getLedgerReportMovements() {
  return readDb((_db, raw) =>
    readCategoryMovements(raw).map((movement) => ({
      dateKey: movement.dateKey,
      categoryId: movement.categoryId,
      amountCents: Math.abs(movement.movementCents) as Cents,
      categoryMovementCents: movement.movementCents as Cents,
      direction: "outflow" as const,
      currency: movement.currency,
      accountId: null,
      transferAccountId: null,
      pending: false,
    })),
  );
}

/** Only the transfer rows, newest first — for a transfers view. */
export async function getTransfers() {
  return readDb(async (db) => {
    const rows = await db.select().from(transactions).where(eq(transactions.direction, "transfer"));
    const allocations = await db.select().from(transactionAllocations);
    return rows.map((transaction) => ({
      ...transaction,
      allocations: allocations
        .filter((allocation) => allocation.transactionId === transaction.id)
        .sort((a, b) => a.position - b.position)
        .map(({ categoryId, amountCents }) => ({ categoryId, amountCents })),
    }));
  });
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
 * Calendar inputs must name a real day. `new Date("2026-02-30")` silently rolls
 * into March, and date-only strings are interpreted as UTC, so neither behavior
 * is suitable for a local calendar-day ledger.
 */
function requireCalendarDate(raw: FormDataEntryValue | null, label = "date"): Date {
  if (raw === null || raw === "") return new Date();
  if (typeof raw !== "string") throw new Error(`Invalid ${label}: expected a calendar day`);

  // Current dialogs send local midnight; API/legacy callers may send the bare
  // key. Ignore the optional local time because this field represents a day.
  const match = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0{1,3})?)?$/.exec(raw);
  const dateKey = match?.[1];
  if (!isDateKey(dateKey)) {
    throw new Error(`Invalid date: ${JSON.stringify(raw)}`);
  }
  return fromDateKey(dateKey);
}

function requireFormDate(formData: FormData): Date {
  return requireCalendarDate(formData.get("date"));
}

type AllocationInput = { categoryId: number; amountCents: Cents };

type TransactionState = Pick<
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
  | "comment"
  | "pending"
  | "recurringId"
  | "recurringOccurrence"
  | "createdAt"
  | "updatedAt"
  | "currentEventId"
>;

async function loadAllocations(db: BudgetDb, transactionId: number): Promise<AllocationInput[]> {
  const rows = await db
    .select({ categoryId: transactionAllocations.categoryId, amountCents: transactionAllocations.amountCents })
    .from(transactionAllocations)
    .where(eq(transactionAllocations.transactionId, transactionId))
    .orderBy(asc(transactionAllocations.position));
  return rows;
}

/** DECISION: DEC-012 — transfer fees/interest are expense-category effects only. */
async function validateExpenseAllocations(
  db: BudgetDb,
  allocations: AllocationInput[],
): Promise<void> {
  const categoryIds = [...new Set(
    allocations
      .filter((allocation) => allocation.amountCents !== 0)
      .map((allocation) => allocation.categoryId),
  )];

  for (const categoryId of categoryIds) {
    const [category] = await db
      .select({ type: categories.type })
      .from(categories)
      .where(eq(categories.id, categoryId));
    if (!category) {
      throw new Error(`Transfer allocation category ${categoryId} does not exist`);
    }
    if (category.type !== "Expense") {
      throw new Error(
        `Transfer allocation category ${categoryId} must be an Expense category (received ${category.type})`,
      );
    }
  }
}

async function replaceAllocations(
  db: BudgetDb,
  transactionId: number,
  allocations: AllocationInput[],
): Promise<void> {
  await db.delete(transactionAllocations).where(eq(transactionAllocations.transactionId, transactionId));
  if (allocations.length > 0) {
    await db.insert(transactionAllocations).values(
      allocations.map((allocation, position) => ({ transactionId, position, ...allocation })),
    );
  }
}

function parseTransferSplit(formData: FormData, amountCents: Cents): {
  principalAmountCents: Cents;
  allocations: AllocationInput[];
} {
  const rawPrincipal = formData.get("principalAmount");
  const principalAmountCents =
    typeof rawPrincipal === "string" && rawPrincipal.trim() !== ""
      ? requireMagnitude(parseAmount(rawPrincipal), "Principal amount")
      : amountCents;
  if (principalAmountCents > amountCents) {
    throw new Error("Principal amount cannot exceed the total payment");
  }
  const interestAmountCents = (amountCents - principalAmountCents) as Cents;
  if (interestAmountCents === 0) return { principalAmountCents, allocations: [] };
  const categoryId = requireId(formData.get("interestCategoryId"), "interestCategoryId");
  return {
    principalAmountCents,
    allocations: [{ categoryId, amountCents: interestAmountCents }],
  };
}

type InvestmentFields = {
  symbol: string;
  quantity: string;
  unit: string | undefined;
  unitPriceMinor: number;
};

function readInvestmentFields(formData: FormData): InvestmentFields | null {
  const symbol = formData.get("instrumentSymbol");
  const quantity = formData.get("quantity");
  const unitPrice = formData.get("unitPrice");
  const unit = formData.get("instrumentUnit");
  const hasAny = [symbol, quantity, unitPrice, unit].some(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  if (!hasAny) return null;
  if (typeof symbol !== "string" || symbol.trim() === "") {
    throw new Error("Choose an investment instrument");
  }
  if (typeof quantity !== "string" || quantity.trim() === "") {
    throw new Error("A confirmed investment purchase requires an exact quantity");
  }
  if (typeof unitPrice !== "string" || unitPrice.trim() === "") {
    throw new Error("A confirmed investment purchase requires a frozen unit price");
  }
  return {
    symbol: symbol.trim(),
    quantity: quantity.trim(),
    unit: typeof unit === "string" && unit.trim() !== "" ? unit.trim() : undefined,
    unitPriceMinor: requireMagnitude(parseAmount(unitPrice), "Unit price"),
  };
}

function prepareInvestment(
  raw: Database,
  fields: InvestmentFields | null,
  currency: string,
  date: Date,
): PreparedInvestmentPurchase | null {
  if (!fields) return null;
  return prepareInvestmentPurchase(raw, {
    ...fields,
    currency,
    observedDay: toDateKey(date),
    observedAt: projectionEpochSeconds(date),
  });
}

function buildCurrentMovements(
  raw: Database,
  row: TransactionState,
  allocations: AllocationInput[],
 ) {
  if (row.accountId === null) throw new Error("A confirmed transaction requires a real account");
  if (row.direction !== "transfer" && row.categoryId === null) {
    throw new Error("A confirmed transaction requires a category");
  }
  return buildProjectedTransactionMovements(raw, row, allocations);
}

function postFirstTransactionEvent(
  raw: Database,
  row: TransactionState,
  allocations: AllocationInput[],
) {
  return postLedgerEventRaw(raw, {
    effectiveDate: toDateKey(row.date),
    description: row.comment ?? "",
    metadata: { projectionKey: row.id, transaction: buildTransactionProjection(row, allocations) },
    movements: buildCurrentMovements(raw, row, allocations),
    recordedAt: row.updatedAt,
  });
}

/** Read-only provider preview. The returned quantity is editable until the confirmed write freezes it. */
export async function previewInvestmentPurchase(symbol: string, paidAmount: string) {
  try {
    const spec = pricedHolding(symbol);
    if (!spec) return { error: "Choose a supported investment instrument" };
    const paidAmountMinor = requireMagnitude(parseAmount(paidAmount), "Purchase amount");
    const result = await fetchPriceQuote(spec.symbol);
    if (!result.ok) return { error: describePriceError(result.error) };
    const unitPriceMinor = requireMagnitude(
      parseAmount(String(result.quote.pricePerUnitUsd)),
      "Provider unit price",
    );
    if (unitPriceMinor === 0) return { error: "Provider unit price must be positive" };
    return {
      success: true as const,
      data: {
        symbol: spec.symbol,
        instrumentUnit: spec.defaultUnit,
        unitPriceMinor,
        quantity: previewPurchaseQuantity(paidAmountMinor, unitPriceMinor),
        sourceLabel: result.quote.sourceLabel,
        fetchedAt: result.quote.fetchedAt,
      },
    };
  } catch (error) {
    return { error: (error as Error).message || "Failed to preview investment purchase" };
  }
}

export async function createTransaction(formData: FormData) {
  try {
    const isPending = formData.get("pending") === "true";

    const transaction = await withDb(async (db, raw) => {
      const accountId = await resolveAccountId(db, formData);
      const categoryId = requireId(formData.get("categoryId"), "categoryId");
      const date = requireFormDate(formData);
      const amountCents = requireMagnitude(parseAmount(formData.get("amount") as string));
      const direction = await categoryDirection(db, categoryId);
      const currency = await accountCurrency(db, accountId);
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const purchase = prepareInvestment(raw, readInvestmentFields(formData), currency, date);
      const [row] = await db.insert(transactions).values({
        date,
        categoryId,
        accountId,
        amountCents,
        direction,
        currency,
        instrumentId: purchase?.instrumentId ?? null,
        quantityDelta: purchase?.quantityDelta ?? null,
        comment: (formData.get("comment") as string) || null,
        pending: isPending,
        createdAt: now,
        updatedAt: now,
      }).returning();

      // DECISION: DEC-011 — a draft is mutable and deliberately has no event.
      if (isPending) return row;

      const event = postFirstTransactionEvent(raw, row, []);
      const [projected] = await db
        .update(transactions)
        .set({ currentEventId: event.eventId })
        .where(eq(transactions.id, row.id))
        .returning();
      if (purchase) projectPositionHolding(raw, purchase.instrumentId, purchase.currency);
      await syncCashAssetWithin(db);
      return projected;
    });

    revalidate("/transactions", "/");
    return { success: true, data: transaction };
  } catch (error) {
    console.error("Failed to create transaction:", error);
    return { error: (error as Error).message || "Failed to create transaction" };
  }
}

export async function updateTransaction(id: number, formData: FormData) {
  try {
    const pendingValue = formData.get("pending");
    const requestedPending = pendingValue === null ? null : pendingValue === "true";

    // An account is only reassigned when the form actually carries one, so an
    // edit through a form that predates accounts cannot silently move the row.
    const accountRaw = formData.get("accountId");
    const accountId =
      typeof accountRaw === "string" && accountRaw.trim() !== ""
        ? Number(accountRaw)
        : undefined;

    const transaction = await withDb(async (db, raw) => {
      const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!existing) throw new Error(`No transaction with id ${id}`);
      if (existing.direction === "transfer" || existing.transferAccountId !== null) {
        throw new Error(`Transaction ${id} is a transfer; use the transfer editor`);
      }
      const isPending = requestedPending ?? existing.pending;
      if (!existing.pending && isPending) {
        throw new Error("A confirmed transaction cannot be changed back into a pending draft");
      }

      const categoryId = formData.has("categoryId")
        ? requireId(formData.get("categoryId"), "categoryId")
        : existing.categoryId;
      if (categoryId === null) throw new Error("A non-transfer transaction needs a category");
      const resolvedAccountId = accountId === undefined ? existing.accountId : accountId;
      if (resolvedAccountId !== null && (!Number.isInteger(resolvedAccountId) || resolvedAccountId <= 0)) {
        throw new Error(`Invalid accountId: ${String(resolvedAccountId)}`);
      }
      const amountRaw = formData.get("amount");
      const date = requireFormDate(formData);
      const currency = accountId === undefined
        ? existing.currency
        : await accountCurrency(db, resolvedAccountId);
      const purchase = prepareInvestment(raw, readInvestmentFields(formData), currency, date);
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const next: TransactionState = {
        ...existing,
        date,
        categoryId,
        accountId: resolvedAccountId,
        amountCents:
          typeof amountRaw === "string" && amountRaw.trim() !== ""
            ? requireMagnitude(parseAmount(amountRaw))
            : existing.amountCents,
        direction: formData.has("categoryId")
          ? await categoryDirection(db, categoryId)
          : existing.direction,
        currency,
        instrumentId: purchase?.instrumentId ?? existing.instrumentId,
        quantityDelta: purchase?.quantityDelta ?? existing.quantityDelta,
        comment: (formData.get("comment") as string) || null,
        pending: isPending,
        updatedAt: now,
      };

      if (existing.pending) {
        const [draft] = await db
          .update(transactions)
          .set({
            date: next.date,
            categoryId: next.categoryId,
            accountId: next.accountId,
            amountCents: next.amountCents,
            direction: next.direction,
            currency: next.currency,
            instrumentId: next.instrumentId,
            quantityDelta: next.quantityDelta,
            comment: next.comment,
            pending: next.pending,
            updatedAt: next.updatedAt,
          })
          .where(eq(transactions.id, id))
          .returning();
        if (isPending) return draft;

        const event = postFirstTransactionEvent(raw, { ...draft, pending: false }, []);
        const [confirmed] = await db
          .update(transactions)
          .set({ currentEventId: event.eventId })
          .where(eq(transactions.id, id))
          .returning();
        if (confirmed.instrumentId) {
          projectPositionHolding(raw, confirmed.instrumentId, confirmed.currency);
        }
        await syncCashAssetWithin(db);
        return confirmed;
      }

      if (!existing.currentEventId) {
        throw new Error("Confirmed transaction is missing its current ledger event");
      }
      const priorMovements = buildCurrentMovements(raw, existing, []);
      const nextMovements = buildCurrentMovements(raw, next, []);
      const event = postLedgerEventRaw(raw, correctLedgerEventInput(
        existing.currentEventId,
        priorMovements,
        nextMovements,
        {
          effectiveDate: toDateKey(next.date),
          description: next.comment ?? "",
          metadata: { projectionKey: id, transaction: buildTransactionProjection(next, []) },
          recordedAt: next.updatedAt,
        },
      ));
      const [projected] = await db
        .update(transactions)
        .set({
          date: next.date,
          categoryId: next.categoryId,
          accountId: next.accountId,
          amountCents: next.amountCents,
          direction: next.direction,
          currency: next.currency,
          instrumentId: next.instrumentId,
          quantityDelta: next.quantityDelta,
          comment: next.comment,
          pending: false,
          currentEventId: event.eventId,
          updatedAt: next.updatedAt,
        })
        .where(eq(transactions.id, id))
        .returning();
      if (existing.instrumentId) {
        syncPositionHoldingProjection(raw, existing.instrumentId, existing.currency);
      }
      if (projected.instrumentId && (
        projected.instrumentId !== existing.instrumentId || projected.currency !== existing.currency
      )) {
        projectPositionHolding(raw, projected.instrumentId, projected.currency);
      }
      await syncCashAssetWithin(db);
      return projected;
    });

    revalidate("/transactions", "/");
    return { success: true, data: transaction };
  } catch (error) {
    console.error("Failed to update transaction:", error);
    return { error: (error as Error).message || "Failed to update transaction" };
  }
}

// DECISION: DEC-009 — accept a DateKey from date controls; retain Date for legacy callers.
export async function confirmTransaction(id: number, date: Date | DateKey) {
  try {
    const confirmationDate =
      typeof date === "string"
        ? isDateKey(date)
          ? fromDateKey(date)
          : null
        : date instanceof Date && !Number.isNaN(date.getTime())
          ? new Date(date.getTime())
          : null;
    if (!confirmationDate) return { error: "Invalid confirmation date" };

    const transaction = await withDb(async (db, raw) => {
      const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!existing) throw new Error(`No transaction with id ${id}`);
      if (!existing.pending || existing.currentEventId !== null) {
        throw new Error("Only an eventless pending transaction can be confirmed");
      }
      const allocations = await loadAllocations(db, id);
      await validateExpenseAllocations(db, allocations);
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const next: TransactionState = {
        ...existing,
        pending: false,
        date: confirmationDate,
        updatedAt: now,
      };
      const event = postFirstTransactionEvent(raw, next, allocations);
      const [row] = await db
        .update(transactions)
        .set({
          pending: false,
          date: confirmationDate,
          currentEventId: event.eventId,
          updatedAt: now,
        })
        .where(eq(transactions.id, id))
        .returning();
      if (row.instrumentId) projectPositionHolding(raw, row.instrumentId, row.currency);
      await syncCashAssetWithin(db);
      return row;
    });

    revalidate("/transactions", "/");
    return { success: true, data: transaction };
  } catch (error) {
    console.error("Failed to confirm transaction:", error);
    return { error: (error as Error).message || "Failed to confirm transaction" };
  }
}

export async function deleteTransaction(id: number) {
  try {
    await withDb(async (db, raw) => {
      const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!existing) throw new Error(`No transaction with id ${id}`);
      if (existing.pending) {
        await db.delete(transactions).where(eq(transactions.id, id));
        return;
      }
      if (!existing.currentEventId) {
        throw new Error("Confirmed transaction is missing its current ledger event");
      }
      const allocations = await loadAllocations(db, id);
      const movements = buildCurrentMovements(raw, existing, allocations);
      postLedgerEventRaw(raw, deleteLedgerEventInput(existing.currentEventId, movements, {
        effectiveDate: toDateKey(existing.date),
        description: existing.comment ?? "",
        metadata: { projectionKey: id, transaction: null },
      }));
      await db.delete(transactions).where(eq(transactions.id, id));
      if (existing.instrumentId) {
        syncPositionHoldingProjection(raw, existing.instrumentId, existing.currency);
      }
      await syncCashAssetWithin(db);
    });

    revalidate("/transactions", "/");
    return { success: true };
  } catch (error) {
    console.error("Failed to delete transaction:", error);
    return { error: (error as Error).message || "Failed to delete transaction" };
  }
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/** A transfer posts signed real-account legs and no category unless it has a split fee. */
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

    const amountCents = requireMagnitude(parseAmount(formData.get("amount") as string), "Transfer amount");
    const date = requireCalendarDate(formData.get("date"), "transfer date");
    const isPending = formData.get("pending") === "true";
    const split = parseTransferSplit(formData, amountCents);

    const transfer = await withDb(async (db, raw) => {
      const rows = await db.select().from(accounts);
      const source = rows.find((account) => account.id === fromAccountId);
      const destination = rows.find((account) => account.id === toAccountId);
      if (!source) throw new Error(`No account with id ${fromAccountId}`);
      if (!destination) throw new Error(`No account with id ${toAccountId}`);
      const currency = normalizeLedgerCurrency(source.currency);
      const destinationCurrency = normalizeLedgerCurrency(destination.currency);
      if (currency !== destinationCurrency) {
        throw new Error(
          `Cannot transfer between ${currency} and ${destinationCurrency} accounts without an FX model.`,
        );
      }
      await validateExpenseAllocations(db, split.allocations);
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);

      const [row] = await db
        .insert(transactions)
        .values({
          date,
          categoryId: null, // a transfer is never income or expense
          accountId: fromAccountId,
          transferAccountId: toAccountId,
          amountCents,
          direction: "transfer",
          currency,
          transferPrincipalAmountCents: split.principalAmountCents,
          comment: (formData.get("comment") as string) || null,
          pending: isPending,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await replaceAllocations(db, row.id, split.allocations);

      // DECISION: DEC-011 — pending transfers remain mutable eventless drafts.
      if (isPending) return row;

      const event = postFirstTransactionEvent(raw, row, split.allocations);
      const [projected] = await db
        .update(transactions)
        .set({ currentEventId: event.eventId })
        .where(eq(transactions.id, row.id))
        .returning();
      await syncCashAssetWithin(db);
      return projected;
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
    const transfer = await withDb(async (db, raw) => {
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
      if (!Number.isInteger(fromAccountId) || !Number.isInteger(toAccountId)) {
        throw new Error("A transfer needs a source and a destination account");
      }
      if (fromAccountId === toAccountId) {
        throw new Error("A transfer must move money between two DIFFERENT accounts");
      }

      const amountRaw = formData.get("amount");
      const dateRaw = formData.get("date");
      const rows = await db.select().from(accounts);
      const source = rows.find((account) => account.id === fromAccountId);
      const destination = rows.find((account) => account.id === toAccountId);
      if (!source) throw new Error(`No account with id ${String(fromAccountId)}`);
      if (!destination) throw new Error(`No account with id ${String(toAccountId)}`);
      const currency = normalizeLedgerCurrency(source.currency);
      const destinationCurrency = normalizeLedgerCurrency(destination.currency);
      if (currency !== destinationCurrency) {
        throw new Error(
          `Cannot transfer between ${currency} and ${destinationCurrency} accounts without an FX model.`,
        );
      }
      const date = dateRaw === null || dateRaw === ""
        ? existing.date
        : requireCalendarDate(dateRaw, "transfer date");
      const amountCents =
        typeof amountRaw === "string" && amountRaw.trim() !== ""
          ? requireMagnitude(parseAmount(amountRaw), "Transfer amount")
          : existing.amountCents;
      const priorAllocations = await loadAllocations(db, id);
      const splitFieldsPresent = formData.has("principalAmount") || formData.has("interestCategoryId");
      const split = splitFieldsPresent
        ? parseTransferSplit(formData, amountCents)
        : amountCents === existing.amountCents
          ? {
              principalAmountCents: existing.transferPrincipalAmountCents ?? existing.amountCents,
              allocations: priorAllocations,
            }
          : { principalAmountCents: amountCents, allocations: [] };
      const pending = formData.has("pending")
        ? formData.get("pending") === "true"
        : existing.pending;
      if (!existing.pending && pending) {
        throw new Error("A confirmed transfer cannot be changed back into a pending draft");
      }
      await validateExpenseAllocations(db, split.allocations);
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const next: TransactionState = {
        ...existing,
        accountId: fromAccountId,
        transferAccountId: toAccountId,
        categoryId: null,
        direction: "transfer",
        currency,
        amountCents,
        transferPrincipalAmountCents: split.principalAmountCents,
        date,
        comment: formData.has("comment")
          ? (formData.get("comment") as string) || null
          : existing.comment,
        pending,
        updatedAt: now,
      };

      if (existing.pending) {
        const [draft] = await db
          .update(transactions)
          .set({
            accountId: next.accountId,
            transferAccountId: next.transferAccountId,
            categoryId: null,
            direction: "transfer",
            currency: next.currency,
            amountCents: next.amountCents,
            transferPrincipalAmountCents: next.transferPrincipalAmountCents,
            date: next.date,
            comment: next.comment,
            pending: next.pending,
            updatedAt: next.updatedAt,
          })
          .where(eq(transactions.id, id))
          .returning();
        await replaceAllocations(db, id, split.allocations);
        if (pending) return draft;

        const event = postFirstTransactionEvent(raw, { ...draft, pending: false }, split.allocations);
        const [confirmed] = await db
          .update(transactions)
          .set({ currentEventId: event.eventId })
          .where(eq(transactions.id, id))
          .returning();
        await syncCashAssetWithin(db);
        return confirmed;
      }

      if (!existing.currentEventId) {
        throw new Error("Confirmed transfer is missing its current ledger event");
      }
      const priorMovements = buildCurrentMovements(raw, existing, priorAllocations);
      const nextMovements = buildCurrentMovements(raw, next, split.allocations);
      const event = postLedgerEventRaw(raw, correctLedgerEventInput(
        existing.currentEventId,
        priorMovements,
        nextMovements,
        {
          effectiveDate: toDateKey(next.date),
          description: next.comment ?? "",
          metadata: { projectionKey: id, transaction: buildTransactionProjection(next, split.allocations) },
          recordedAt: next.updatedAt,
        },
      ));
      const [projected] = await db
        .update(transactions)
        .set({
          accountId: next.accountId,
          transferAccountId: next.transferAccountId,
          categoryId: null,
          direction: "transfer",
          currency: next.currency,
          amountCents: next.amountCents,
          transferPrincipalAmountCents: next.transferPrincipalAmountCents,
          date: next.date,
          comment: next.comment,
          pending: false,
          currentEventId: event.eventId,
          updatedAt: next.updatedAt,
        })
        .where(eq(transactions.id, id))
        .returning();
      await replaceAllocations(db, id, split.allocations);
      await syncCashAssetWithin(db);
      return projected;
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
