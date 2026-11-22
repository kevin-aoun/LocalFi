"use server";

import type { Database } from "sql.js";

import { readDb, withDb, type BudgetDb } from "@/lib/db/client";
import {
  accounts,
  assets,
  categories,
  ledgerEvents,
  transactionAllocations,
  transactions,
  type Transaction,
  type TransactionDirection,
} from "@/lib/db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";
import { syncCashAssetWithin } from "@/lib/db/sync-cash";
import { parseAmount, sumCents, type Cents } from "@/lib/money";
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
  findInstrument,
  getExactPosition,
  prepareInvestmentPurchase,
  projectPositionHolding,
  syncPositionHoldingProjection,
  type PreparedInvestmentPurchase,
} from "@/lib/investments";
import { parsePurchaseQuantity, parsePurchaseUnitPrice, purchaseAmountCents, tradeCashAmount } from "@/lib/investments/cost";
import { assertAvailableInvestmentUnits, type InvestmentSide } from "@/lib/investments/trades";
import { assertAmountOnlyCategory, investmentKindForSymbol } from "@/lib/investments/categories";
import { negateCanonicalDecimal } from "@/lib/ledger/decimal";
import { requireMagnitude } from "./shared";

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

type InvestmentCost = { paidAmountCents: Cents; feeAmountCents: Cents };
type InvestmentEventMetadata = { investmentUnitPrice?: string; investmentCost?: InvestmentCost };

function recordedInvestmentCost(
  row: Pick<Transaction, "amountCents" | "quantityDelta" | "direction">,
  metadata: InvestmentEventMetadata,
): InvestmentCost | undefined {
  if (metadata.investmentCost) return metadata.investmentCost;
  if (row.direction !== "outflow" || !metadata.investmentUnitPrice || !row.quantityDelta ||
      row.quantityDelta === "0" || row.quantityDelta.startsWith("-")) return undefined;
  const paidAmountCents = purchaseAmountCents(row.quantityDelta, metadata.investmentUnitPrice);
  if (paidAmountCents > row.amountCents) return undefined;
  return { paidAmountCents, feeAmountCents: sumCents([row.amountCents, -paidAmountCents]) };
}

export async function getTransactions(categoryId?: number) {
  return readDb(async (db) => {
    const all = await db.select().from(transactions);
    const transferFees = new Map(all.filter((row) => row.feeForTransferId !== null).map((row) => [row.feeForTransferId, row]));
    const purchasePrices = await db.select({ eventId: ledgerEvents.eventId, metadataJson: ledgerEvents.metadataJson })
      .from(ledgerEvents).innerJoin(transactions, eq(ledgerEvents.eventId, transactions.currentEventId))
      .where(isNotNull(transactions.instrumentId));
    const purchaseMetadata = new Map(purchasePrices.map(({ eventId, metadataJson }) =>
      [eventId, JSON.parse(metadataJson) as InvestmentEventMetadata]));
    const allocations = await db
      .select()
      .from(transactionAllocations)
      .orderBy(asc(transactionAllocations.transactionId), asc(transactionAllocations.position));
    const allocationsByTransaction = new Map<number, Array<{ categoryId: number; amountCents: Cents }>>();
    for (const { transactionId, categoryId: allocationCategoryId, amountCents } of allocations) {
      const bucket = allocationsByTransaction.get(transactionId) ?? [];
      bucket.push({ categoryId: allocationCategoryId, amountCents });
      allocationsByTransaction.set(transactionId, bucket);
    }
    const rows = all.map((transaction) => ({
      ...transaction,
      ...(transaction.direction === "transfer" ? {
        feeAmountCents: transferFees.get(transaction.id)?.amountCents ?? null,
        feeCategoryId: transferFees.get(transaction.id)?.categoryId ?? null,
      } : {}),
      ...(transaction.instrumentId ? (() => {
        const metadata: InvestmentEventMetadata = transaction.currentEventId
          ? purchaseMetadata.get(transaction.currentEventId) ?? {}
          : transaction.investmentDraft ? JSON.parse(transaction.investmentDraft) : {};
        return {
          investmentUnitPrice: metadata.investmentUnitPrice ?? null,
          investmentFeeAmountCents: recordedInvestmentCost(transaction, metadata)?.feeAmountCents ?? null,
        };
      })() : {}),
      allocations: allocationsByTransaction.get(transaction.id) ?? [],
    }));
    return categoryId ? rows.filter((transaction) => transaction.categoryId === categoryId) : rows;
  });
}


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


export async function getTransfers() {
  return (await getTransactions()).filter((transaction) => transaction.direction === "transfer");
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


function requireCalendarDate(raw: FormDataEntryValue | null, label = "date"): Date {
  if (raw === null || raw === "") return new Date();
  if (typeof raw !== "string") throw new Error(`Invalid ${label}: expected a calendar day`);



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
  | "feeForTransferId"
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
  side: InvestmentSide;
  symbol: string;
  quantity: string;
  unit: string | undefined;
  unitPriceMinor: number;
  unitPrice: string;
};

function readInvestmentFields(formData: FormData, fallbackSide: InvestmentSide = "buy"): InvestmentFields | null {
  const symbol = formData.get("instrumentSymbol");
  const quantity = formData.get("quantity");
  const unitPrice = formData.get("unitPrice");
  const unit = formData.get("instrumentUnit");
  const hasAny = [symbol, quantity, unitPrice, unit].some(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  if (!hasAny) return null;
  const side = formData.get("investmentSide") ?? fallbackSide;
  if (side !== "buy" && side !== "sell") throw new Error("Choose Buy or Sell");
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
    side,
    symbol: symbol.trim(),
    quantity: parsePurchaseQuantity(quantity),
    unit: typeof unit === "string" && unit.trim() !== "" ? unit.trim() : undefined,
    unitPrice: parsePurchaseUnitPrice(unitPrice),
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
  const purchase = prepareInvestmentPurchase(raw, {
    ...fields,
    currency,
    observedDay: toDateKey(date),
    observedAt: projectionEpochSeconds(date),
    source: fields.side === "sell" ? "sale" : "purchase",
  });
  return { ...purchase, quantityDelta: fields.side === "sell" ? negateCanonicalDecimal(purchase.quantityDelta) : purchase.quantityDelta };
}

async function validateInvestmentCategory(db: BudgetDb, categoryId: number, accountId: number | null, symbol?: string) {
  const [category] = await db.select().from(categories).where(eq(categories.id, categoryId));
  if (category?.type !== "Investment") throw new Error("Choose an Investment category for this trade");
  if (symbol && category.investmentKind && category.investmentKind !== investmentKindForSymbol(symbol)) {
    throw new Error("The instrument does not match the selected category's asset type");
  }
  const [account] = accountId === null ? [] : await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account || account.archived || account.kind !== "asset") throw new Error("Choose an active asset account for this trade");
  return category;
}

// Stock, Crypto and Commodities categories expect units and a price, which manual holdings lack.
function assertPlainInvestmentCategory(category: { investmentKind: string | null }) {
  if (category.investmentKind) {
    throw new Error("Stock, crypto and commodity categories record units and prices. Choose another Investment category for this holding.");
  }
}

function isManualInstrument(raw: Database, instrumentId: string | null): boolean {
  return instrumentId !== null && findInstrument(raw, instrumentId)?.kind === "manual";
}

// Only a NEW confirmed state needs a real account and category. Prior states use
// buildProjectedTransactionMovements directly, so legacy 0012 rows can still be corrected.
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
  investmentCost?: { paidAmountCents: Cents; feeAmountCents: Cents; unitPrice: string },
) {
  return postLedgerEventRaw(raw, {
    effectiveDate: toDateKey(row.date),
    description: row.comment ?? "",
    metadata: {
      projectionKey: row.id, transaction: buildTransactionProjection(row, allocations),
      ...(investmentCost ? {
        investmentCost: { paidAmountCents: investmentCost.paidAmountCents, feeAmountCents: investmentCost.feeAmountCents },
        investmentUnitPrice: investmentCost.unitPrice,
      } : {}),
    },
    movements: buildCurrentMovements(raw, row, allocations),
    recordedAt: row.updatedAt,
  });
}

type TransferFeeInput = { amountCents: Cents; categoryId: number | null };

function readTransferFee(formData: FormData): TransferFeeInput | null {
  if (!formData.has("fees") && !formData.has("feeCategoryId")) return null;
  const raw = formData.get("fees");
  const amountCents = raw === null || raw === "" ? 0 : requireMagnitude(parseAmount(raw as string), "Fees");
  return { amountCents, categoryId: amountCents > 0 ? requireId(formData.get("feeCategoryId"), "fee category") : null };
}

async function linkedTransferFee(db: BudgetDb, transferId: number) {
  const [fee] = await db.select().from(transactions).where(eq(transactions.feeForTransferId, transferId));
  return fee;
}

async function deleteTransactionWithin(db: BudgetDb, raw: Database, existing: TransactionState): Promise<void> {
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

async function syncTransferFeeWithin(db: BudgetDb, raw: Database, transfer: TransactionState, input: TransferFeeInput | null): Promise<void> {
  const existing = await linkedTransferFee(db, transfer.id);
  const fee = input ?? (existing ? { amountCents: existing.amountCents, categoryId: existing.categoryId } : null);
  if (fee === null || fee.amountCents === 0) {
    if (existing) await deleteTransactionWithin(db, raw, existing);
    return;
  }
  if (fee.categoryId === null) throw new Error("Choose a fee expense category");
  sumCents([transfer.amountCents, fee.amountCents]);
  await validateExpenseAllocations(db, [{ categoryId: fee.categoryId, amountCents: fee.amountCents }]);
  if (existing && !existing.pending && transfer.pending) throw new Error("A confirmed fee cannot become a pending draft");
  if (existing && !existing.pending && !existing.currentEventId) throw new Error("Confirmed fee is missing its ledger event");
  const values = {
    accountId: transfer.accountId, categoryId: fee.categoryId, transferAccountId: null,
    amountCents: fee.amountCents, direction: "outflow" as const, currency: transfer.currency,
    date: transfer.date, comment: transfer.comment ? `Transfer fee · ${transfer.comment}` : "Transfer fee",
    feeForTransferId: transfer.id, pending: transfer.pending, updatedAt: transfer.updatedAt,
  };
  const [row] = existing
    ? await db.update(transactions).set(values).where(eq(transactions.id, existing.id)).returning()
    : await db.insert(transactions).values({ ...values, createdAt: transfer.updatedAt }).returning();
  if (row.pending) return;
  const event = existing && !existing.pending
    ? postLedgerEventRaw(raw, correctLedgerEventInput(
      existing.currentEventId!, buildProjectedTransactionMovements(raw, existing, []), buildCurrentMovements(raw, row, []),
      { effectiveDate: toDateKey(row.date), description: row.comment ?? "", metadata: { projectionKey: row.id, transaction: buildTransactionProjection(row, []) }, recordedAt: row.updatedAt },
    ))
    : postFirstTransactionEvent(raw, row, []);
  await db.update(transactions).set({ currentEventId: event.eventId }).where(eq(transactions.id, row.id));
}


export async function createTransaction(formData: FormData) {
  try {
    const isPending = formData.get("pending") === "true";
    const fields = readInvestmentFields(formData);

    const transaction = await withDb(async (db, raw) => {
      const accountId = await resolveAccountId(db, formData);
      const categoryId = requireId(formData.get("categoryId"), "categoryId");
      const [category] = await db.select().from(categories).where(eq(categories.id, categoryId));
      if (!fields) assertAmountOnlyCategory(category);
      const date = requireFormDate(formData);
      const paidAmountCents = fields
        ? purchaseAmountCents(fields.quantity, fields.unitPrice)
        : requireMagnitude(parseAmount(formData.get("amount") as string));
      const rawFees = formData.get("fees");
      const feeAmountCents = rawFees === null || rawFees === "" ? 0 : requireMagnitude(parseAmount(rawFees as string), "Fees");
      const amountCents = fields ? tradeCashAmount(fields.quantity, fields.unitPrice, feeAmountCents as Cents, fields.side) : sumCents([paidAmountCents, feeAmountCents]);
      const direction = fields ? fields.side === "sell" ? "inflow" : "outflow" : await categoryDirection(db, categoryId);
      const currency = await accountCurrency(db, accountId);
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const purchase = prepareInvestment(raw, fields, currency, date);
      if (feeAmountCents > 0 && !purchase) throw new Error("Fees require an investment purchase");
      if (purchase) {
        await validateInvestmentCategory(db, categoryId, accountId, fields!.symbol);
      }
      const [row] = await db.insert(transactions).values({
        date,
        categoryId,
        accountId,
        amountCents,
        direction,
        currency,
        instrumentId: purchase?.instrumentId ?? null,
        quantityDelta: purchase?.quantityDelta ?? null,
        investmentDraft: isPending && fields ? JSON.stringify({ investmentCost: { paidAmountCents, feeAmountCents }, investmentUnitPrice: fields.unitPrice }) : null,
        comment: (formData.get("comment") as string) || null,
        pending: isPending,
        createdAt: now,
        updatedAt: now,
      }).returning();


      if (isPending) return row;

      const event = postFirstTransactionEvent(raw, row, [], purchase && fields ? { paidAmountCents, feeAmountCents, unitPrice: fields.unitPrice } : undefined);
      if (purchase) assertAvailableInvestmentUnits(raw, purchase.instrumentId, currency);
      const [projected] = await db
        .update(transactions)
        .set({ currentEventId: event.eventId })
        .where(eq(transactions.id, row.id))
        .returning();
      if (purchase) projectPositionHolding(raw, purchase.instrumentId, purchase.currency);
      await syncCashAssetWithin(db);
      return projected;
    });

    revalidate("/transactions", "/", "/accounts", "/reports");
    return { success: true, data: transaction };
  } catch (error) {
    console.error("Failed to create transaction:", error);
    return { error: (error as Error).message || "Failed to create transaction" };
  }
}

/**
 * Sells a manually valued holding (property, vehicle, other) in full. The sale
 * is an ordinary confirmed Investment transaction: the proceeds enter the
 * account and every unit leaves the holding, so later edits and deletes go
 * through Transactions like any other trade.
 */
export async function sellManualHolding(assetId: number, formData: FormData) {
  try {
    const transaction = await withDb(async (db, raw) => {
      const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
      const instrument = asset?.instrumentId ? findInstrument(raw, asset.instrumentId) : null;
      if (!asset || !instrument) throw new Error("That holding no longer exists");
      if (instrument.kind !== "manual") throw new Error("Sell stocks, crypto and metals by units and price.");
      const position = getExactPosition(raw, instrument.id, asset.currency);
      if (!position || position.quantity === "0" || position.quantity.startsWith("-")) {
        throw new Error("This holding has already been sold");
      }
      const accountId = requireId(formData.get("accountId"), "account");
      const categoryId = requireId(formData.get("categoryId"), "category");
      assertPlainInvestmentCategory(await validateInvestmentCategory(db, categoryId, accountId));
      const currency = await accountCurrency(db, accountId);
      if (currency !== position.currency) {
        throw new Error(`Receive the proceeds into a ${position.currency} account; this holding is valued in ${position.currency}.`);
      }
      const rawAmount = formData.get("amount");
      if (typeof rawAmount !== "string" || rawAmount.trim() === "") throw new Error("Enter the sale proceeds");
      const comment = formData.get("comment");
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const [row] = await db.insert(transactions).values({
        date: requireFormDate(formData),
        categoryId,
        accountId,
        amountCents: requireMagnitude(parseAmount(rawAmount), "Sale proceeds"),
        direction: "inflow",
        currency,
        instrumentId: instrument.id,
        quantityDelta: negateCanonicalDecimal(position.quantity),
        comment: typeof comment === "string" && comment.trim() !== "" ? comment.trim() : `Sold ${instrument.label}`,
        pending: false,
        createdAt: now,
        updatedAt: now,
      }).returning();
      const event = postFirstTransactionEvent(raw, row, []);
      assertAvailableInvestmentUnits(raw, instrument.id, currency);
      const [projected] = await db.update(transactions)
        .set({ currentEventId: event.eventId })
        .where(eq(transactions.id, row.id))
        .returning();
      syncPositionHoldingProjection(raw, instrument.id, currency);
      await syncCashAssetWithin(db);
      return projected;
    });

    revalidate("/transactions", "/", "/accounts", "/reports");
    return { success: true as const, data: transaction };
  } catch (error) {
    console.error("Failed to sell holding:", error);
    return { error: (error as Error).message || "Failed to sell holding" };
  }
}

export async function updateTransaction(id: number, formData: FormData) {
  try {
    const pendingValue = formData.get("pending");
    const requestedPending = pendingValue === null ? null : pendingValue === "true";



    const accountRaw = formData.get("accountId");
    const accountId =
      typeof accountRaw === "string" && accountRaw.trim() !== ""
        ? Number(accountRaw)
        : undefined;

    const transaction = await withDb(async (db, raw) => {
      const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!existing) throw new Error(`No transaction with id ${id}`);
      if (existing.feeForTransferId !== null) throw new Error("Edit the transfer to change its fee");
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
      const date = formData.has("date") ? requireFormDate(formData) : existing.date;
      const [currentEvent] = existing.currentEventId
        ? await db.select({ metadataJson: ledgerEvents.metadataJson }).from(ledgerEvents)
          .where(eq(ledgerEvents.eventId, existing.currentEventId))
        : [];
      const priorMetadata: InvestmentEventMetadata = currentEvent ? JSON.parse(currentEvent.metadataJson)
        : existing.investmentDraft ? JSON.parse(existing.investmentDraft) : {};
      let investmentCost = recordedInvestmentCost(existing, priorMetadata);
      const currency = accountId === undefined
        ? existing.currency
        : await accountCurrency(db, resolvedAccountId);
      const fields = readInvestmentFields(formData, existing.instrumentId && existing.direction === "inflow" ? "sell" : "buy");
      const manualTrade = isManualInstrument(raw, existing.instrumentId);
      const purchase = prepareInvestment(raw, fields, currency, date);
      if (fields) {
        const paidAmountCents = purchaseAmountCents(fields.quantity, fields.unitPrice);
        const rawFees = formData.get("fees");
        const feeAmountCents = rawFees === null
          ? investmentCost?.feeAmountCents ?? 0
          : rawFees === "" ? 0 : requireMagnitude(parseAmount(rawFees as string), "Fees");
        investmentCost = { paidAmountCents, feeAmountCents };
        await validateInvestmentCategory(db, categoryId, resolvedAccountId, fields.symbol);
      } else if (existing.instrumentId && !manualTrade && (
        formData.has("fees") || (typeof amountRaw === "string" && amountRaw.trim() !== "" && parseAmount(amountRaw) !== existing.amountCents)
      )) {
        throw new Error("Edit the investment units, price, and fees together to change its cash amount");
      }
      if (!fields && existing.instrumentId) {
        const category = await validateInvestmentCategory(db, categoryId, resolvedAccountId);
        if (manualTrade) assertPlainInvestmentCategory(category);
      }
      // Legacy amount-only rows may keep a category that later gained trade fields; moving one there may not.
      if (!fields && !existing.instrumentId && categoryId !== existing.categoryId) {
        const [category] = await db.select().from(categories).where(eq(categories.id, categoryId));
        assertAmountOnlyCategory(category);
      }
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const next: TransactionState = {
        ...existing,
        date,
        categoryId,
        accountId: resolvedAccountId,
        amountCents: fields && investmentCost
          ? tradeCashAmount(fields.quantity, fields.unitPrice, investmentCost.feeAmountCents, fields.side)
          : typeof amountRaw === "string" && amountRaw.trim() !== ""
            ? requireMagnitude(parseAmount(amountRaw))
            : existing.amountCents,
        direction: fields ? fields.side === "sell" ? "inflow" : "outflow" : existing.instrumentId ? existing.direction : formData.has("categoryId")
          ? await categoryDirection(db, categoryId)
          : existing.direction,
        currency,
        instrumentId: purchase?.instrumentId ?? existing.instrumentId,
        quantityDelta: purchase?.quantityDelta ?? existing.quantityDelta,
        comment: formData.has("comment") ? (formData.get("comment") as string) || null : existing.comment,
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
            investmentDraft: isPending ? JSON.stringify({ investmentCost, investmentUnitPrice: fields?.unitPrice ?? priorMetadata.investmentUnitPrice }) : null,
            comment: next.comment,
            pending: next.pending,
            updatedAt: next.updatedAt,
          })
          .where(eq(transactions.id, id))
          .returning();
        if (isPending) return draft;

        const draftPrice = fields?.unitPrice ?? priorMetadata.investmentUnitPrice;
        const event = postFirstTransactionEvent(raw, { ...draft, pending: false }, [], draftPrice && investmentCost ? { ...investmentCost, unitPrice: draftPrice } : undefined);
        if (draft.instrumentId) assertAvailableInvestmentUnits(raw, draft.instrumentId, draft.currency);
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
      const priorMovements = buildProjectedTransactionMovements(raw, existing, []);
      const nextMovements = buildCurrentMovements(raw, next, []);
      const investmentUnitPrice = fields?.unitPrice ?? priorMetadata.investmentUnitPrice;
      const event = postLedgerEventRaw(raw, correctLedgerEventInput(
        existing.currentEventId,
        priorMovements,
        nextMovements,
        {
          effectiveDate: toDateKey(next.date),
          description: next.comment ?? "",
          metadata: {
            projectionKey: id, transaction: buildTransactionProjection(next, []),
            ...(investmentUnitPrice ? { investmentUnitPrice } : {}),
            ...(investmentCost ? { investmentCost } : {}),
          },
          recordedAt: next.updatedAt,
        },
      ));
      if (existing.instrumentId) assertAvailableInvestmentUnits(raw, existing.instrumentId, existing.currency);
      if (next.instrumentId) assertAvailableInvestmentUnits(raw, next.instrumentId, next.currency);
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

    revalidate("/transactions", "/", "/accounts", "/reports");
    return { success: true, data: transaction };
  } catch (error) {
    console.error("Failed to update transaction:", error);
    return { error: (error as Error).message || "Failed to update transaction" };
  }
}


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
      let [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!existing) throw new Error(`No transaction with id ${id}`);
      if (existing.feeForTransferId !== null) {
        [existing] = await db.select().from(transactions).where(eq(transactions.id, existing.feeForTransferId));
        if (!existing) throw new Error("The fee's transfer no longer exists");
      }
      if (!existing.pending || existing.currentEventId !== null) {
        throw new Error("Only an eventless pending transaction can be confirmed");
      }
      const allocations = await loadAllocations(db, existing.id);
      await validateExpenseAllocations(db, allocations);
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const next: TransactionState = {
        ...existing,
        pending: false,
        date: confirmationDate,
        updatedAt: now,
      };
      if (existing.instrumentId) await validateInvestmentCategory(db, existing.categoryId!, existing.accountId);
      const metadata: InvestmentEventMetadata = existing.investmentDraft ? JSON.parse(existing.investmentDraft) : {};
      const event = postFirstTransactionEvent(raw, next, allocations, metadata.investmentCost && metadata.investmentUnitPrice ? { ...metadata.investmentCost, unitPrice: metadata.investmentUnitPrice } : undefined);
      if (next.instrumentId) assertAvailableInvestmentUnits(raw, next.instrumentId, next.currency);
      const [row] = await db
        .update(transactions)
        .set({
          pending: false,
          date: confirmationDate,
          currentEventId: event.eventId,
          investmentDraft: null,
          updatedAt: now,
        })
        .where(eq(transactions.id, existing.id))
        .returning();
      if (row.instrumentId) projectPositionHolding(raw, row.instrumentId, row.currency);
      if (row.direction === "transfer") await syncTransferFeeWithin(db, raw, row, null);
      await syncCashAssetWithin(db);
      return row;
    });

    revalidate("/transactions", "/", "/accounts", "/reports");
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
      await deleteTransactionWithin(db, raw, existing);
      if (!existing.pending) await syncCashAssetWithin(db);
    });

    revalidate("/transactions", "/", "/accounts", "/reports");
    return { success: true };
  } catch (error) {
    console.error("Failed to delete transaction:", error);
    return { error: (error as Error).message || "Failed to delete transaction" };
  }
}






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
    const fee = readTransferFee(formData);
    const split = fee === null ? parseTransferSplit(formData, amountCents) : { principalAmountCents: amountCents, allocations: [] };

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
          categoryId: null,
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


      if (isPending) {
        await syncTransferFeeWithin(db, raw, row, fee);
        return row;
      }

      const event = postFirstTransactionEvent(raw, row, split.allocations);
      const [projected] = await db
        .update(transactions)
        .set({ currentEventId: event.eventId })
        .where(eq(transactions.id, row.id))
        .returning();
      await syncTransferFeeWithin(db, raw, projected, fee);
      await syncCashAssetWithin(db);
      return projected;
    });

    revalidate("/transactions", "/", "/accounts", "/reports");


    return { success: true as const, data: transfer };
  } catch (error) {
    console.error("Failed to create transfer:", error);
    return { error: (error as Error).message || "Failed to create transfer" };
  }
}


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
      const fee = readTransferFee(formData);
      const existingFee = await linkedTransferFee(db, id);
      const splitFieldsPresent = formData.has("principalAmount") || formData.has("interestCategoryId");
      const split = fee !== null || existingFee
        ? { principalAmountCents: amountCents, allocations: [] }
        : splitFieldsPresent
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
        if (pending) {
          await syncTransferFeeWithin(db, raw, draft, fee);
          return draft;
        }

        const event = postFirstTransactionEvent(raw, { ...draft, pending: false }, split.allocations);
        const [confirmed] = await db
          .update(transactions)
          .set({ currentEventId: event.eventId })
          .where(eq(transactions.id, id))
          .returning();
        await syncTransferFeeWithin(db, raw, confirmed, fee);
        await syncCashAssetWithin(db);
        return confirmed;
      }

      if (!existing.currentEventId) {
        throw new Error("Confirmed transfer is missing its current ledger event");
      }
      const priorMovements = buildProjectedTransactionMovements(raw, existing, priorAllocations);
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
      await syncTransferFeeWithin(db, raw, projected, fee);
      await syncCashAssetWithin(db);
      return projected;
    });

    revalidate("/transactions", "/", "/accounts", "/reports");


    return { success: true as const, data: transfer };
  } catch (error) {
    console.error("Failed to update transfer:", error);
    return { error: (error as Error).message || "Failed to update transfer" };
  }
}
