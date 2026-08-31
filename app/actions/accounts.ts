"use server";

import { and, asc, desc, eq, gte, lte, isNull, or } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";

import { readDb, withDb } from "@/lib/db/client";
import {
  accountKindForType,
  accountKinds,
  accountTypes,
  accounts,
  assetHistory,
  netWorthSnapshots,
  transactionAllocations,
  transactions,
  type Account,
  type AccountKind,
  type AccountType,
  type Transaction,
} from "@/lib/db/schema";
import {
  deriveNetWorth,
  normalizeLedgerCurrency,
  type AccountBalance,
  type NetWorth,
} from "@/lib/cash-balance";
import { fromDateKey, isDateKey, toDateKey, todayKey, type DateKey } from "@/lib/dates";
import { parseAmount, type Cents } from "@/lib/money";
import { refreshLivePricedAssets } from "./crypto";
import {
  buildTransactionMovements,
  correctLedgerEventInput,
  deleteLedgerEventInput,
  postLedgerEventRaw,
  readAccountMovements,
  readAccountBalances,
  readPositionValuations,
  readUnassignedAccountMovements,
  registerLedgerAccount,
  type CanonicalMetadata,
  type LedgerMovementInput,
} from "@/lib/ledger";
import type { Database } from "sql.js";

export type ActionResult<T> = { success: true; data: T } | { error: string };

type LivePriceRefresh = Awaited<ReturnType<typeof refreshLivePricedAssets>>;

export type NetWorthPriceRefresh =
  | ({ ok: true } & LivePriceRefresh)
  | { ok: false; error: string };

export type AccountWithBalance = Account & {

  balanceCents: Cents;

  activityCents: Cents;

  owedCents: Cents;

  balanceKind: "asset" | "liability";
};

export type NetWorthView = NetWorth & {

  dateKey: DateKey;
};

function str(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function parseType(value: string | null): AccountType {
  if (!value || !(accountTypes as readonly string[]).includes(value)) {
    throw new Error(`Invalid account type: ${String(value)}. Expected one of ${accountTypes.join(", ")}`);
  }
  return value as AccountType;
}


function resolveKind(type: AccountType, requested: string | null): AccountKind {
  const implied = accountKindForType[type];
  if (requested === null) return implied;
  if (!(accountKinds as readonly string[]).includes(requested)) {
    throw new Error(`Invalid account kind: ${requested}. Expected 'asset' or 'liability'`);
  }
  const kind = requested as AccountKind;
  if (type !== "Other" && type !== "Loan" && kind !== implied) {
    throw new Error(`An account of type ${type} must have kind '${implied}', not '${kind}'`);
  }
  return kind;
}

function requireMagnitude(cents: Cents, label: string): Cents {
  if (cents < 0) throw new Error(`${label} cannot be negative`);
  return cents;
}

function requireOpeningBalanceDate(value: string | null): DateKey {
  const dateKey = value ?? todayKey();
  if (!isDateKey(dateKey)) {
    throw new Error(`Invalid opening balance date: expected YYYY-MM-DD, received ${JSON.stringify(value)}`);
  }
  return dateKey;
}





function openingMovements(
  raw: Database,
  accountId: number,
  kind: AccountKind,
  amount: Cents,
  currency: string,
): LedgerMovementInput[] {
  const accountTarget = registerLedgerAccount(raw, {
    targetType: "real_account",
    targetRef: accountId,
    currency,
  });
  const counterTarget = registerLedgerAccount(raw, {
    targetType: "system",
    targetRef: "opening-balance",
    currency,
  });
  const signed = kind === "liability" ? -amount : amount;
  return [
    { ledgerAccountId: accountTarget, amountMinor: signed, currency },
    { ledgerAccountId: counterTarget, amountMinor: -signed, currency },
  ];
}

function latestOpeningEventId(raw: Database, accountId: number): string | null {
  const statement = raw.prepare(
    `SELECT e.event_id
       FROM ledger_events e
      WHERE EXISTS (
        SELECT 1 FROM ledger_movements m JOIN ledger_accounts a ON a.id = m.ledger_account_id
         WHERE m.event_id = e.event_id AND a.target_type = 'real_account' AND a.target_ref = ?
      ) AND EXISTS (
        SELECT 1 FROM ledger_movements m JOIN ledger_accounts a ON a.id = m.ledger_account_id
         WHERE m.event_id = e.event_id AND a.target_type = 'system' AND a.target_ref = 'opening-balance'
      )
      ORDER BY e.sequence DESC LIMIT 1`,
  );
  try {
    statement.bind([String(accountId)]);
    return statement.step() ? String(statement.get()[0]) : null;
  } finally {
    statement.free();
  }
}

function postAccountOpening(
  raw: Database,
  account: Pick<Account, "id" | "name" | "kind" | "openingBalanceCents" | "openingBalanceDate" | "currency">,
  prior?: Pick<Account, "kind" | "openingBalanceCents" | "currency">,
): void {
  if (account.openingBalanceCents === 0 && (prior?.openingBalanceCents ?? 0) === 0) return;
  const priorEventId = prior ? latestOpeningEventId(raw, account.id) : null;
  const common = {
    effectiveDate: account.openingBalanceDate,
    description: `Opening balance for ${account.name}`,
    metadata: {
      fact: "account-opening",
      accountId: account.id,
      openingBalanceCents: account.openingBalanceCents,
      expectedKind: account.kind,
      currency: account.currency,
    },
  };
  if (account.openingBalanceCents === 0) {
    if (!prior || prior.openingBalanceCents === 0 || priorEventId === null) return;
    const before = openingMovements(
      raw,
      account.id,
      prior.kind,
      prior.openingBalanceCents,
      prior.currency,
    );
    postLedgerEventRaw(raw, deleteLedgerEventInput(priorEventId, before, common));
    return;
  }
  const next = openingMovements(
    raw,
    account.id,
    account.kind,
    account.openingBalanceCents,
    account.currency,
  );
  if (!prior || prior.openingBalanceCents === 0 || priorEventId === null) {
    postLedgerEventRaw(raw, { ...common, movements: next });
    return;
  }
  const before = openingMovements(
    raw,
    account.id,
    prior.kind,
    prior.openingBalanceCents,
    prior.currency,
  );
  postLedgerEventRaw(raw, correctLedgerEventInput(priorEventId, before, next, common));
}

function journalBalances(
  accountRows: readonly Account[],
  raw: Database,
  asOfKey: DateKey,
): AccountBalance[] {
  const posted = readAccountBalances(raw, { asOfKey });
  const byId = new Map(posted.map((row) => [row.accountId, { ...row }]));
  const unassigned = new Map<string, Cents[]>();
  for (const movement of readUnassignedAccountMovements(raw, { toKey: asOfKey })) {
    const bucket = unassigned.get(movement.currency) ?? [];
    bucket.push(movement.amountCents as Cents);
    unassigned.set(movement.currency, bucket);
  }
  const balances: AccountBalance[] = accountRows.map((account) => {
    const balance = byId.get(account.id);
    if (balance && balance.currency !== account.currency) {
      throw new Error(`Account ${account.id} has ${balance.currency} movements but is ${account.currency}`);
    }
    const balanceCents = (balance?.balanceCents ?? 0) as Cents;
    return {
      accountId: account.id,
      currency: account.currency,
      kind: account.kind,
      openingBalanceCents: Math.abs(balance?.openingCents ?? 0) as Cents,
      activityCents: (balance?.activityCents ?? 0) as Cents,
      balanceCents,
      owedCents: (balanceCents < 0 ? -balanceCents : 0) as Cents,
      archived: account.archived,
    };
  });
  for (const [currency, effects] of unassigned) {
    const balanceCents = effects.reduce((sum, amount) => sum + amount, 0) as Cents;
    balances.push({
      accountId: null,
      currency,
      kind: "asset",
      openingBalanceCents: 0,
      activityCents: balanceCents,
      balanceCents,
      owedCents: balanceCents < 0 ? -balanceCents as Cents : 0,
      archived: false,
    });
  }
  return balances;
}

function worthFromJournal(
  accountRows: readonly Account[],
  raw: Database,
  asOfKey: DateKey,
): NetWorth {
  const balances = journalBalances(accountRows, raw, asOfKey);
  const valuations = readPositionValuations(raw, asOfKey);
  return deriveNetWorth({
    accounts: balances.map((balance) => ({
      id: balance.accountId!,
      kind: balance.balanceCents < 0 ? "liability" : "asset",
      openingBalanceCents: Math.abs(balance.balanceCents) as Cents,
      currency: balance.currency,
      archived: balance.archived,
    })),
    transactions: [],
    categories: [],
    standaloneAssets: [
      ...valuations.map((position) => ({
        id: position.assetId ?? undefined,
        category: position.category,
        currentValueCents: position.valueMinor as Cents,
        currency: position.currency,
        archived: position.archived,
      })),
    ],
  });
}


export async function getAccounts(options?: { includeArchived?: boolean }): Promise<Account[]> {
  const includeArchived = options?.includeArchived === true;
  return readDb((db) => {
    const query = db.select().from(accounts);
    return includeArchived
      ? query.orderBy(asc(accounts.id))
      : query.where(eq(accounts.archived, false)).orderBy(asc(accounts.id));
  });
}


export async function getDefaultAccountId(): Promise<number | null> {
  const rows = await readDb((db) =>
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.archived, false), eq(accounts.kind, "asset")))
      .orderBy(asc(accounts.id))
      .limit(1),
  );
  return rows[0]?.id ?? null;
}


export async function getLedgerCashMovements() {
  return readDb((_db, raw) => {
    const movements = [
      ...readAccountMovements(raw),
      ...readUnassignedAccountMovements(raw).map((movement) => ({ ...movement, accountId: null })),
    ];
    return movements.map((movement) => ({
      date: fromDateKey(movement.dateKey),
      categoryId: null,
      amountCents: Math.abs(movement.amountCents) as Cents,
      direction: movement.amountCents < 0 ? "outflow" as const : "inflow" as const,
      currency: movement.currency,
      pending: false,
      accountId: movement.accountId,
      transferAccountId: null,
    }));
  });
}


export async function getAccountBalances(options?: {
  includeArchived?: boolean;
}): Promise<AccountWithBalance[]> {
  const includeArchived = options?.includeArchived !== false;
  const { rows, balances } = await readDb(async (db, raw) => {
    const rows = await db.select().from(accounts).orderBy(asc(accounts.id));
    return { rows, balances: journalBalances(rows, raw, todayKey()) };
  });

  const byId = new Map<number, AccountBalance>();
  for (const balance of balances) {
    if (balance.accountId !== null) byId.set(balance.accountId, balance);
  }

  return rows
    .filter((row) => includeArchived || !row.archived)
    .map((row) => {
      const balance = byId.get(row.id);
      return {
        ...row,
        balanceCents: balance?.balanceCents ?? 0,
        activityCents: balance?.activityCents ?? 0,
        owedCents: balance?.owedCents ?? 0,
        balanceKind: (balance?.balanceCents ?? 0) < 0 ? "liability" : "asset",
      };
    });
}


export async function getNetWorth(): Promise<NetWorthView> {



  const dateKey = todayKey();
  const result = await readDb(async (db, raw) => {
    const accountRows = await db.select().from(accounts);
    return worthFromJournal(accountRows, raw, dateKey);
  });
  return { ...result, dateKey };
}


export async function getNetWorthHistory(options?: {
  fromKey?: DateKey;
  toKey?: DateKey;
}) {
  const fromKey = options?.fromKey;
  const toKey = options?.toKey;
  if (fromKey !== undefined && !isDateKey(fromKey)) throw new Error(`Invalid fromKey: ${fromKey}`);
  if (toKey !== undefined && !isDateKey(toKey)) throw new Error(`Invalid toKey: ${toKey}`);

  return readDb((db) => {
    const conditions = [
      fromKey ? gte(netWorthSnapshots.date, fromKey) : undefined,
      toKey ? lte(netWorthSnapshots.date, toKey) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const query = db.select().from(netWorthSnapshots);
    return conditions.length
      ? query.where(and(...conditions)).orderBy(asc(netWorthSnapshots.date))
      : query.orderBy(asc(netWorthSnapshots.date));
  });
}


export async function getLatestNetWorthSnapshot() {
  const rows = await readDb((db) =>
    db.select().from(netWorthSnapshots).orderBy(desc(netWorthSnapshots.date)).limit(1),
  );
  return rows[0] ?? null;
}






export async function createAccount(formData: FormData): Promise<ActionResult<Account>> {
  try {
    const name = str(formData, "name");
    if (!name) return { error: "An account needs a name" };
    const type = parseType(str(formData, "type"));
    const kind = resolveKind(type, str(formData, "kind"));
    const openingRaw = str(formData, "openingBalance");
    const openingBalanceCents = requireMagnitude(
      openingRaw === null ? 0 : parseAmount(openingRaw),
      "Opening balance",
    );
    const openingBalanceDate = requireOpeningBalanceDate(str(formData, "openingBalanceDate"));
    const currency = normalizeLedgerCurrency(str(formData, "currency") ?? "USD");

    const account = await withDb(async (db, raw) => {
      const [row] = await db
        .insert(accounts)
        .values({
          name,
          kind,
          type,
          openingBalanceCents,
          openingBalanceDate,
          currency,
          archived: formData.get("archived") === "true",
        })
        .returning();
      postAccountOpening(raw, row);
      return row;
    });

    revalidate("/", "/accounts", "/transactions");
    return { success: true, data: account };
  } catch (error) {
    console.error("Failed to create account:", error);
    const message = (error as Error).message ?? "";
    if (/UNIQUE/i.test(message)) return { error: "An account with that name already exists" };
    return { error: message || "Failed to create account" };
  }
}


export async function updateAccount(id: number, formData: FormData): Promise<ActionResult<Account>> {
  try {
    const account = await withDb(async (db, raw) => {
      const [existing] = await db.select().from(accounts).where(eq(accounts.id, id));
      if (!existing) throw new Error(`No account with id ${id}`);

      const type = formData.has("type") ? parseType(str(formData, "type")) : existing.type;
      const kind = formData.has("kind") || formData.has("type")
        ? resolveKind(type, formData.has("kind") ? str(formData, "kind") : null)
        : existing.kind;
      const openingRaw = str(formData, "openingBalance");
      const openingBalanceCents =
        openingRaw === null
          ? existing.openingBalanceCents
          : requireMagnitude(parseAmount(openingRaw), "Opening balance");
      const openingBalanceDate = formData.has("openingBalanceDate")
        ? requireOpeningBalanceDate(str(formData, "openingBalanceDate"))
        : existing.openingBalanceDate;
      const currency = formData.has("currency")
        ? normalizeLedgerCurrency(str(formData, "currency"), existing.currency)
        : existing.currency;

      if (currency !== existing.currency) {
        const hasPostedActivity = readAccountMovements(raw).some((movement) => movement.accountId === id);
        if (hasPostedActivity) {
          throw new Error(
            `Cannot change ${existing.name} from ${existing.currency} to ${currency} because the account has transaction history.`,
          );
        }
      }

      const [row] = await db
        .update(accounts)
        .set({
          name: str(formData, "name") ?? existing.name,
          type,
          kind,
          openingBalanceCents,
          openingBalanceDate,
          currency,
          archived: formData.has("archived")
            ? formData.get("archived") === "true"
            : existing.archived,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, id))
        .returning();
      const openingChanged =
        row.openingBalanceCents !== existing.openingBalanceCents ||
        row.openingBalanceDate !== existing.openingBalanceDate ||
        row.kind !== existing.kind ||
        row.currency !== existing.currency;
      if (openingChanged) postAccountOpening(raw, row, existing);
      return row;
    });

    revalidate("/", "/accounts", "/transactions");
    return { success: true, data: account };
  } catch (error) {
    console.error("Failed to update account:", error);
    const message = (error as Error).message ?? "";
    if (/UNIQUE/i.test(message)) return { error: "An account with that name already exists" };
    return { error: message || "Failed to update account" };
  }
}


export async function setAccountArchived(id: number, archived: boolean): Promise<ActionResult<Account>> {
  try {
    const account = await withDb(async (db) => {
      const [row] = await db
        .update(accounts)
        .set({ archived, updatedAt: new Date() })
        .where(eq(accounts.id, id))
        .returning();
      if (!row) throw new Error(`No account with id ${id}`);
      return row;
    });
    revalidate("/", "/accounts");
    return { success: true, data: account };
  } catch (error) {
    console.error("Failed to archive account:", error);
    return { error: (error as Error).message || "Failed to archive account" };
  }
}


export async function deleteAccount(id: number): Promise<ActionResult<{ id: number }>> {
  try {
    await withDb(async (db, raw) => {
      const referencing = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(or(eq(transactions.accountId, id), eq(transactions.transferAccountId, id)));
      if (referencing.length > 0) {
        throw new Error(
          `This account has ${referencing.length} transaction(s). Archive it instead of deleting it, ` +
            `so the history is kept.`,
        );
      }
      if (readAccountBalances(raw).some((balance) => balance.accountId === id)) {
        throw new Error("This account has posted ledger history. Archive it instead of deleting it.");
      }
      await db.delete(accounts).where(eq(accounts.id, id));
    });
    revalidate("/", "/accounts");
    return { success: true, data: { id } };
  } catch (error) {
    console.error("Failed to delete account:", error);
    return { error: (error as Error).message || "Failed to delete account" };
  }
}


export async function snapshotNetWorth(options?: { dateKey?: DateKey }) {
  try {
    const dateKey = options?.dateKey ?? todayKey();
    if (!isDateKey(dateKey)) throw new Error(`Invalid dateKey: ${String(dateKey)}`);



    if (dateKey > todayKey()) {
      return { error: `Cannot snapshot a future date (${dateKey}); today is ${todayKey()}.` };
    }

    const snapshot = await withDb(async (db, raw) => {
      const accountRows = await db.select().from(accounts);
      const worth = worthFromJournal(accountRows, raw, dateKey);

      if (worth.aggregate === null) {
        const currencies = worth.currencyTotals.map((total) => total.currency);
        throw new Error(
          `Cannot record one net-worth snapshot for mixed currencies (${currencies.join(", ")}). ` +
            "LocalFi has no FX model; keep the per-currency totals separate.",
        );
      }

      const values = {
        date: dateKey,
        currency: worth.aggregate.currency,
        totalAssetsCents: worth.aggregate.totalAssetsCents,
        totalLiabilitiesCents: worth.aggregate.totalLiabilitiesCents,
        netWorthCents: worth.aggregate.netWorthCents,






        source: "recorded" as const,
        sourceNote: null,
        updatedAt: new Date(),
      };




      const recordedAt = fromDateKey(dateKey);
      const holdingRows = readPositionValuations(raw, dateKey)
        .filter((position) => position.assetId !== null && !position.archived)
        .map((position) => ({
          assetId: position.assetId!,
          valueCents: position.valueMinor as Cents,
          currency: position.currency,
          recordedDay: dateKey,
          recordedAt,
        }));
      for (const holding of holdingRows) {
        await db
          .insert(assetHistory)
          .values(holding)
          .onConflictDoUpdate({
            target: [assetHistory.assetId, assetHistory.recordedDay],
            set: {
              valueCents: holding.valueCents,
              currency: holding.currency,
              recordedAt: holding.recordedAt,
            },
          });
      }

      const [existing] = await db
        .select()
        .from(netWorthSnapshots)
        .where(eq(netWorthSnapshots.date, dateKey));

      if (existing) {
        const [row] = await db
          .update(netWorthSnapshots)
          .set(values)
          .where(eq(netWorthSnapshots.id, existing.id))
          .returning();
        return row;
      }

      const [row] = await db.insert(netWorthSnapshots).values(values).returning();
      return row;
    });

    revalidate("/", "/accounts");
    return { success: true as const, data: snapshot };
  } catch (error) {
    console.error("Failed to snapshot net worth:", error);
    return { error: (error as Error).message || "Failed to snapshot net worth" };
  }
}

function describePriceRefresh(prices: NetWorthPriceRefresh): string {
  if (!prices.ok) {
    return `Live prices could not be refreshed (${prices.error}); stored values were recorded.`;
  }

  if (
    prices.refreshed === 0 &&
    prices.skipped === 0 &&
    prices.failed.length === 0 &&
    prices.unpriceable.length === 0
  ) {
    return "No live-priced holdings were configured.";
  }

  const parts = [
    `Refreshed ${prices.refreshed} live-priced holding${prices.refreshed === 1 ? "" : "s"}`,
  ];
  if (prices.failed.length > 0) {
    parts.push(
      `${prices.failed.length} failed (${prices.failed.map((item) => item.label).join(", ")})`,
    );
  }
  if (prices.unpriceable.length > 0) {
    parts.push(
      `${prices.unpriceable.length} kept stored values because no live source exists ` +
        `(${prices.unpriceable.map((item) => item.label).join(", ")})`,
    );
  }
  if (prices.skipped > 0) {
    parts.push(`${prices.skipped} skipped because their symbol or quantity is missing`);
  }
  return `${parts.join("; ")}.`;
}


export async function recordNetWorthToday() {
  let prices: NetWorthPriceRefresh;
  try {
    prices = { ok: true, ...(await refreshLivePricedAssets()) };
  } catch (cause) {
    const error =
      cause instanceof Error && cause.message ? cause.message : "Live price refresh failed.";
    prices = { ok: false, error };
    console.warn("record today: price refresh failed; recording stored values:", error);
  }

  const result = await snapshotNetWorth();
  if ("error" in result) return { error: result.error };

  return {
    success: true as const,
    data: {
      ...result.data,
      prices,
      priceSummary: describePriceRefresh(prices),
    },
  };
}


export async function deleteNetWorthSnapshot(dateKey: DateKey) {
  try {
    if (!isDateKey(dateKey)) throw new Error(`Invalid dateKey: ${String(dateKey)}`);
    await withDb(async (db) => {
      await db.delete(netWorthSnapshots).where(eq(netWorthSnapshots.date, dateKey));
      await db.delete(assetHistory).where(eq(assetHistory.recordedDay, dateKey));
    });
    revalidate("/", "/accounts");
    return { success: true as const, data: { dateKey } };
  } catch (error) {
    console.error("Failed to delete snapshot:", error);
    return { error: (error as Error).message || "Failed to delete snapshot" };
  }
}

type OrphanAllocation = { categoryId: number; amountCents: Cents };

function transactionEpoch(value: Date): number {
  const seconds = Math.floor(value.getTime() / 1000);
  if (!Number.isSafeInteger(seconds)) throw new Error("Transaction timestamp is invalid");
  return seconds;
}

function orphanSnapshot(
  row: Transaction,
  allocations: readonly OrphanAllocation[],
  accountId: number,
  updatedAt: Date,
) {
  return {
    id: row.id,
    date: transactionEpoch(row.date),
    categoryId: row.categoryId,
    accountId,
    transferAccountId: row.transferAccountId,
    amountCents: row.amountCents,
    direction: row.direction,
    currency: row.currency,
    comment: row.comment,
    pending: false,
    recurringId: row.recurringId,
    recurringOccurrence: row.recurringOccurrence,
    instrumentId: row.instrumentId,
    quantityDelta: row.quantityDelta,
    transferPrincipalAmountCents: row.transferPrincipalAmountCents,
    allocations: allocations.map((allocation) => ({ ...allocation })),
    createdAt: transactionEpoch(row.createdAt),
    updatedAt: transactionEpoch(updatedAt),
  };
}

function targetForCategory(raw: Database, categoryId: number | null, currency: string): string {
  if (categoryId === null) throw new Error("A posted orphan transaction requires a category");
  return registerLedgerAccount(raw, {
    targetType: "category",
    targetRef: categoryId,
    currency,
  });
}

function orphanCurrentMovements(
  raw: Database,
  row: Transaction,
  allocations: readonly OrphanAllocation[],
  sourceTargetId: string,
): LedgerMovementInput[] {
  const currency = normalizeLedgerCurrency(row.currency);
  if (row.direction === "transfer") {
    if (row.transferAccountId === null) throw new Error("A posted orphan transfer requires a destination account");
    const destinationTargetId = registerLedgerAccount(raw, {
      targetType: "real_account",
      targetRef: row.transferAccountId,
      currency,
    });
    const principal = row.transferPrincipalAmountCents ?? row.amountCents;
    const allocationTotal = allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
    if (principal + allocationTotal !== row.amountCents) {
      throw new Error("Transfer principal and allocations must equal the total source amount");
    }
    return [
      { ledgerAccountId: sourceTargetId, amountMinor: -row.amountCents, currency },
      { ledgerAccountId: destinationTargetId, amountMinor: principal, currency },
      ...allocations.map((allocation) => ({
        ledgerAccountId: targetForCategory(raw, allocation.categoryId, currency),
        amountMinor: allocation.amountCents,
        currency,
      })),
    ];
  }

  let instrumentTargetId: string | null = null;
  let instrumentBookCounterTargetId: string | null = null;
  if (row.instrumentId !== null || row.quantityDelta !== null) {
    if (row.instrumentId === null || row.quantityDelta === null) {
      throw new Error("Investment instrument and exact quantity must be stored together");
    }
    instrumentTargetId = registerLedgerAccount(raw, {
      targetType: "instrument",
      targetRef: row.instrumentId,
      currency,
      instrumentId: row.instrumentId,
    });
    instrumentBookCounterTargetId = registerLedgerAccount(raw, {
      targetType: "system",
      targetRef: `instrument-book:${row.instrumentId}`,
      currency,
    });
  }
  return buildTransactionMovements({
    direction: row.direction,
    amountMinor: row.amountCents,
    currency,
    accountTargetId: sourceTargetId,
    categoryTargetId: targetForCategory(raw, row.categoryId, currency),
    instrumentTargetId,
    instrumentBookCounterTargetId,
    quantityDelta: row.quantityDelta,
  });
}

function eventMetadata(raw: Database, eventId: string): CanonicalMetadata {
  const statement = raw.prepare("SELECT metadata_json FROM ledger_events WHERE event_id = ?");
  try {
    statement.bind([eventId]);
    if (!statement.step()) throw new Error(`Missing current ledger event ${eventId}`);
    const parsed: unknown = JSON.parse(String(statement.get()[0]));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid metadata for current ledger event ${eventId}`);
    }
    return parsed as CanonicalMetadata;
  } finally {
    statement.free();
  }
}


export async function assignOrphanTransactions(accountId: number) {
  try {
    const moved = await withDb(async (db, raw) => {
      const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
      if (!account) throw new Error(`No account with id ${accountId}`);
      const orphans = await db
        .select()
        .from(transactions)
        .where(isNull(transactions.accountId))
        .orderBy(asc(transactions.id));
      const allocationRows = await db
        .select()
        .from(transactionAllocations)
        .orderBy(asc(transactionAllocations.transactionId), asc(transactionAllocations.position));
      for (const orphan of orphans) {
        if (!orphan.pending && orphan.currentEventId === null) {
          throw new Error(`Posted transaction ${orphan.id} is missing current_event_id`);
        }
        if (!orphan.pending && normalizeLedgerCurrency(orphan.currency) !== account.currency) {
          throw new Error(
            `Posted transaction ${orphan.id} is ${orphan.currency}, but account ${accountId} is ${account.currency}`,
          );
        }
      }
      const postedOrphans = orphans.filter((orphan) => !orphan.pending);
      const realTarget = postedOrphans.length === 0 ? null : registerLedgerAccount(raw, {
        targetType: "real_account",
        targetRef: accountId,
        currency: account.currency,
      });
      const legacyTarget = postedOrphans.length === 0 ? null : registerLedgerAccount(raw, {
        targetType: "system",
        targetRef: "legacy-unassigned-account",
        currency: account.currency,
      });
      for (const orphan of orphans) {
        const now = new Date();
        if (orphan.pending) {
          await db
            .update(transactions)
            .set({ accountId, currency: account.currency, updatedAt: now })
            .where(eq(transactions.id, orphan.id));
          continue;
        }
        const allocations = allocationRows
          .filter((allocation) => allocation.transactionId === orphan.id)
          .map(({ categoryId, amountCents }) => ({ categoryId, amountCents }));
        const prior = orphanCurrentMovements(raw, orphan, allocations, legacyTarget!);
        const next = orphanCurrentMovements(raw, orphan, allocations, realTarget!);
        const priorMetadata = eventMetadata(raw, orphan.currentEventId!);
        const event = postLedgerEventRaw(raw, correctLedgerEventInput(
          orphan.currentEventId!,
          prior,
          next,
          {
            effectiveDate: toDateKey(orphan.date),
            description: orphan.comment ?? "",
            metadata: {
              ...priorMetadata,
              projectionKey: orphan.id,
              transaction: orphanSnapshot(orphan, allocations, accountId, now),
              reassignment: {
                from: "legacy-unassigned-account",
                toAccountId: accountId,
              },
            },
            recordedAt: now,
          },
        ));
        await db
          .update(transactions)
          .set({ accountId, currency: account.currency, updatedAt: now, currentEventId: event.eventId })
          .where(eq(transactions.id, orphan.id));
      }
      return orphans.length;
    });
    revalidate("/", "/accounts", "/transactions");
    return { success: true as const, data: { moved } };
  } catch (error) {
    console.error("Failed to assign orphan transactions:", error);
    return { error: (error as Error).message || "Failed to assign orphan transactions" };
  }
}
