"use server";

/**
 * Accounts, per-account balances, net worth, and net-worth history.
 *
 * The balance arithmetic is NOT here — it is in lib/cash-balance.ts, the single
 * source of the rule. These actions only load rows, hand them to it, and persist
 * the result.
 */
import { and, asc, desc, eq, gte, lte, isNull, or } from "drizzle-orm";
import { revalidate } from "@/lib/revalidate";

import { readDb, withDb } from "@/lib/db/client";
import {
  accountKindForType,
  accountKinds,
  accountTypes,
  accounts,
  assetHistory,
  assets,
  categories,
  netWorthSnapshots,
  transactions,
  type Account,
  type AccountKind,
  type AccountType,
} from "@/lib/db/schema";
import {
  deriveAccountBalances,
  deriveNetWorth,
  type AccountBalance,
  type NetWorth,
} from "@/lib/cash-balance";
import { annotateStandaloneAssets } from "@/lib/assets/standalone";
import { fromDateKey, isDateKey, toDateKey, todayKey, type DateKey } from "@/lib/dates";
import { parseAmount, type Cents } from "@/lib/money";
import type { AcquisitionTransaction } from "@/lib/assets/acquisition";
import { refreshLivePricedAssets } from "./crypto";

/**
 * Ledger rows reduced to calendar days, for the acquisition rule.
 *
 * `toDateKey` on a local Date — never `toISOString()`, which converts to UTC
 * first and shifts the day for anyone not on UTC. A purchase dated the 30th must
 * stay the 30th in Beirut and in Honolulu.
 */
function toAcquisitionLedger(
  rows: readonly (typeof transactions.$inferSelect)[],
): AcquisitionTransaction[] {
  return rows.map((tx) => ({
    id: tx.id,
    dateKey: toDateKey(tx.date instanceof Date ? tx.date : new Date(Number(tx.date) * 1000)),
    amountCents: tx.amountCents,
    categoryId: tx.categoryId,
    transferAccountId: tx.transferAccountId,
    pending: tx.pending,
    comment: tx.comment,
  }));
}

export type ActionResult<T> = { success: true; data: T } | { error: string };

type LivePriceRefresh = Awaited<ReturnType<typeof refreshLivePricedAssets>>;

export type NetWorthPriceRefresh =
  | ({ ok: true } & LivePriceRefresh)
  | { ok: false; error: string };

/** An account row plus its derived balance — what an accounts page renders. */
export type AccountWithBalance = Account & {
  /** Net-worth contribution: positive = owned, negative = owed. */
  balanceCents: Cents;
  /** Signed ledger activity since inception, excluding the opening balance. */
  activityCents: Cents;
  /** For a liability, how much is still owed. 0 for assets and paid-off debts. */
  owedCents: Cents;
};

export type NetWorthView = NetWorth & {
  /** The day this was computed for, as a local calendar day. */
  dateKey: DateKey;
};

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

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

/**
 * `kind` may be supplied explicitly, but it must agree with `type` for every type
 * whose side of the balance sheet is not ambiguous. Only "Other" may be either.
 * Getting this wrong is how a mortgage ends up inflating net worth.
 */
function resolveKind(type: AccountType, requested: string | null): AccountKind {
  const implied = accountKindForType[type];
  if (requested === null) return implied;
  if (!(accountKinds as readonly string[]).includes(requested)) {
    throw new Error(`Invalid account kind: ${requested}. Expected 'asset' or 'liability'`);
  }
  const kind = requested as AccountKind;
  if (type !== "Other" && kind !== implied) {
    throw new Error(`An account of type ${type} must have kind '${implied}', not '${kind}'`);
  }
  return kind;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Every account, oldest first. Archived accounts are excluded by default. */
export async function getAccounts(options?: { includeArchived?: boolean }): Promise<Account[]> {
  const includeArchived = options?.includeArchived === true;
  return readDb((db) => {
    const query = db.select().from(accounts);
    return includeArchived
      ? query.orderBy(asc(accounts.id))
      : query.where(eq(accounts.archived, false)).orderBy(asc(accounts.id));
  });
}

/**
 * The id new transactions should default to: the oldest non-archived asset
 * account. Null when the user has no accounts at all.
 */
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

/** Every account with its derived balance. Includes archived accounts by default
 * because hiding an account that still holds money would change net worth. */
export async function getAccountBalances(options?: {
  includeArchived?: boolean;
}): Promise<AccountWithBalance[]> {
  const includeArchived = options?.includeArchived !== false;
  const { rows, balances } = await readDb(async (db) => {
    const rows = await db.select().from(accounts).orderBy(asc(accounts.id));
    const txs = await db.select().from(transactions);
    const cats = await db.select().from(categories);
    return { rows, balances: deriveAccountBalances(rows, txs, cats) };
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
      };
    });
}

/**
 * Net worth right now: asset accounts + unassigned ledger + standalone assets,
 * minus liability accounts.
 *
 * The derived "Cash" asset row is excluded from the standalone side, because it
 * is computed from the same ledger the accounts are computed from — counting both
 * would double the user's cash.
 */
export async function getNetWorth(): Promise<NetWorthView> {
  // Read the day ONCE, here, and pass it down. Nothing deeper reads the clock,
  // so the whole computation is one consistent calendar day even if it straddles
  // local midnight — and `npm run test:tz` can pin the behaviour.
  const dateKey = todayKey();
  const result = await readDb(async (db) => {
    const accountRows = await db.select().from(accounts);
    const txs = await db.select().from(transactions);
    const cats = await db.select().from(categories);
    const assetRows = await db.select().from(assets);
    // Acquisition-aware: an asset bought AFTER today contributes 0 and is
    // reported in `notYetAcquired`, and an asset no transaction backs is counted
    // but named in `unbackedAssetsCents`. For today's figure this is identical
    // to the cent — everything owned was bought in the past — which is precisely
    // why it is asserted in the tests rather than assumed.
    const { standaloneAssets } = annotateStandaloneAssets(
      assetRows,
      toAcquisitionLedger(txs),
      cats,
    );
    return deriveNetWorth({
      accounts: accountRows,
      transactions: txs,
      categories: cats,
      standaloneAssets,
      asOfKey: dateKey,
    });
  });
  return { ...result, dateKey };
}

/** Net-worth history, oldest first, optionally bounded by calendar day. */
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

/** The most recent snapshot, or null when history is empty. */
export async function getLatestNetWorthSnapshot() {
  const rows = await readDb((db) =>
    db.select().from(netWorthSnapshots).orderBy(desc(netWorthSnapshots.date)).limit(1),
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create an account.
 *
 * Fields: name, type, kind (optional — derived from type), openingBalance
 * (a decimal string, parsed to exact cents), currency, archived.
 *
 * `openingBalance` is a MAGNITUDE: for a liability it is how much is OWED. See
 * the sign convention in lib/cash-balance.ts.
 */
export async function createAccount(formData: FormData): Promise<ActionResult<Account>> {
  try {
    const name = str(formData, "name");
    if (!name) return { error: "An account needs a name" };
    const type = parseType(str(formData, "type"));
    const kind = resolveKind(type, str(formData, "kind"));
    const openingRaw = str(formData, "openingBalance");
    const openingBalanceCents = openingRaw === null ? 0 : parseAmount(openingRaw);

    const account = await withDb(async (db) => {
      const [row] = await db
        .insert(accounts)
        .values({
          name,
          kind,
          type,
          openingBalanceCents,
          currency: str(formData, "currency") ?? "USD",
          archived: formData.get("archived") === "true",
        })
        .returning();
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

/** Update an account. Only the fields present in `formData` are changed. */
export async function updateAccount(id: number, formData: FormData): Promise<ActionResult<Account>> {
  try {
    const account = await withDb(async (db) => {
      const [existing] = await db.select().from(accounts).where(eq(accounts.id, id));
      if (!existing) throw new Error(`No account with id ${id}`);

      const type = formData.has("type") ? parseType(str(formData, "type")) : existing.type;
      const kind = formData.has("kind") || formData.has("type")
        ? resolveKind(type, formData.has("kind") ? str(formData, "kind") : null)
        : existing.kind;
      const openingRaw = str(formData, "openingBalance");

      const [row] = await db
        .update(accounts)
        .set({
          name: str(formData, "name") ?? existing.name,
          type,
          kind,
          openingBalanceCents:
            openingRaw === null ? existing.openingBalanceCents : parseAmount(openingRaw),
          currency: str(formData, "currency") ?? existing.currency,
          archived: formData.has("archived")
            ? formData.get("archived") === "true"
            : existing.archived,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, id))
        .returning();
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

/** Archive (or un-archive) an account. History is preserved either way. */
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

/**
 * Delete an account, but ONLY when nothing references it.
 *
 * An account with transactions is never deleted: doing so would either violate
 * the foreign key or (worse, if enforcement were off) orphan real financial
 * history. Archive it instead.
 */
export async function deleteAccount(id: number): Promise<ActionResult<{ id: number }>> {
  try {
    await withDb(async (db) => {
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
      await db.delete(accounts).where(eq(accounts.id, id));
    });
    revalidate("/", "/accounts");
    return { success: true, data: { id } };
  } catch (error) {
    console.error("Failed to delete account:", error);
    return { error: (error as Error).message || "Failed to delete account" };
  }
}

/**
 * Record today's net worth — IDEMPOTENTLY.
 *
 * `net_worth_snapshots.date` is UNIQUE per calendar day, so re-running this any
 * number of times on the same day UPDATES that day's row instead of appending a
 * duplicate. Without that, a chart would double-count every day the user happened
 * to open the app twice.
 *
 * Pass `dateKey` to backfill or to snapshot a specific day (the figures are still
 * "as of now" — this does not reconstruct a historical balance).
 */
export async function snapshotNetWorth(options?: { dateKey?: DateKey }) {
  try {
    const dateKey = options?.dateKey ?? todayKey();
    if (!isDateKey(dateKey)) throw new Error(`Invalid dateKey: ${String(dateKey)}`);
    // A snapshot records TODAY's derived figures. Filing them under a future day
    // would plot a net worth that was never true on that date, and the chart
    // reads snapshots as history — so refuse rather than fabricate a data point.
    if (dateKey > todayKey()) {
      return { error: `Cannot snapshot a future date (${dateKey}); today is ${todayKey()}.` };
    }

    const snapshot = await withDb(async (db) => {
      const accountRows = await db.select().from(accounts);
      const txs = await db.select().from(transactions);
      const cats = await db.select().from(categories);
      const assetRows = await db.select().from(assets);

      // Same acquisition gate as getNetWorth, so a snapshot and the headline
      // figure it snapshots cannot be computed by two different rules.
      const { standaloneAssets, acquisitions } = annotateStandaloneAssets(
        assetRows,
        toAcquisitionLedger(txs),
        cats,
      );
      const worth = deriveNetWorth({
        accounts: accountRows,
        transactions: txs,
        categories: cats,
        standaloneAssets,
        asOfKey: dateKey,
      });

      const values = {
        date: dateKey,
        totalAssetsCents: worth.totalAssetsCents,
        totalLiabilitiesCents: worth.totalLiabilitiesCents,
        netWorthCents: worth.netWorthCents,
        // These figures are MEASURED from the live ledger, so the row is
        // 'recorded' even when it overwrites a reconstruction. Without this,
        // a day that lib/history estimated first and this function measured
        // second would keep the 'reconstructed' label and its stale note —
        // an estimate flag on real data, which is the one direction of error
        // the column exists to prevent.
        source: "recorded" as const,
        sourceNote: null,
        updatedAt: new Date(),
      };

      // `asset_history` is the holding-level child ledger of this daily net-worth
      // row. Replace this day's values inside the SAME transaction so repeated
      // snapshots are idempotent and the aggregate can never land without its
      // breakdown. Cash is excluded for the same double-counting reason as above.
      const recordedAt = fromDateKey(dateKey);
      await db.delete(assetHistory).where(eq(assetHistory.recordedAt, recordedAt));
      const holdingRows = assetRows
        .filter((asset) => asset.category !== "Cash")
        .filter((asset) => {
          const acquiredOn = acquisitions.get(asset.id)?.acquiredOn;
          return acquiredOn === undefined || acquiredOn <= dateKey;
        })
        .map((asset) => ({
          assetId: asset.id,
          valueCents: asset.currentValueCents,
          recordedAt,
        }));
      if (holdingRows.length > 0) await db.insert(assetHistory).values(holdingRows);

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

/**
 * Refresh every live-priced holding, then record today's newest values.
 *
 * DECISION: DEC-002 — every manual and scheduled current-day recording calls
 * this orchestrator; `snapshotNetWorth` remains the network-free persistence
 * primitive for explicit historical dates.
 */
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

/** Delete one day's snapshot. */
export async function deleteNetWorthSnapshot(dateKey: DateKey) {
  try {
    if (!isDateKey(dateKey)) throw new Error(`Invalid dateKey: ${String(dateKey)}`);
    await withDb(async (db) => {
      await db.delete(netWorthSnapshots).where(eq(netWorthSnapshots.date, dateKey));
      await db.delete(assetHistory).where(eq(assetHistory.recordedAt, fromDateKey(dateKey)));
    });
    revalidate("/", "/accounts");
    return { success: true as const, data: { dateKey } };
  } catch (error) {
    console.error("Failed to delete snapshot:", error);
    return { error: (error as Error).message || "Failed to delete snapshot" };
  }
}

/**
 * Attach every account-less transaction to `accountId`. Useful once, right after
 * the user creates their first real account, to empty the "unassigned" bucket.
 */
export async function assignOrphanTransactions(accountId: number) {
  try {
    const moved = await withDb(async (db) => {
      const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
      if (!account) throw new Error(`No account with id ${accountId}`);
      const orphans = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(isNull(transactions.accountId));
      if (orphans.length > 0) {
        await db
          .update(transactions)
          .set({ accountId, updatedAt: new Date() })
          .where(isNull(transactions.accountId));
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
