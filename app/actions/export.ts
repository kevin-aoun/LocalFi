"use server";

/**
 * Getting your data OUT.
 *
 * ## Why this file exists
 *
 * The whole pitch of this app is "it is your file, on your disk". Until now there
 * was no way to act on that from inside the app: no export, no backup, not even a
 * line of text telling you where the file is. A local-first app without an export
 * button is just a database you cannot read.
 *
 * Three ways out, in increasing fidelity:
 *
 * 1. **CSV of transactions** over a chosen range. The header row is the one
 *    `components/transactions/import-logic.ts` recognises, so the app can read its
 *    own export back — asserted end-to-end in
 *    `lib/__tests__/reports-csv-roundtrip.test.ts`, through the real importer.
 * 2. **JSON backup** of every table. Human-readable, and lossless: money is an
 *    exact two-decimal string that `parseAmount` reads back to the same integer
 *    cents.
 * 3. **The SQLite file itself** — `data/budget.db`. The real backup.
 *
 * ## Reading budget.db safely
 *
 * `saveDb()` rewrites the WHOLE file (temp file -> fsync -> rename), so a naive
 * read could in principle catch a half-written file. Two things make that
 * impossible here:
 *
 *   - the read runs inside `readDb(...)`, which queues on the same process-wide
 *     FIFO lock every writer uses, so no flush can be in flight while we read;
 *   - the flush is atomic anyway (`renameSync` within one filesystem), so the path
 *     always names a COMPLETE generation — either the old one or the new one,
 *     never a torn one.
 *
 * The SQLite header is then verified before the bytes are handed over, so a
 * corrupt file is refused rather than downloaded as a "backup".
 *
 * The one honest caveat, surfaced in the UI: a deprecated `getDb()`/`saveDb()`
 * caller mutates in memory first and flushes second, so a download taken in that
 * narrow window is the LAST SAVED generation, not the in-memory one. It is never
 * partial, and `savedAt` tells the user exactly which generation they got.
 *
 * Note also: `raw.export()` is deliberately NOT used to serialise the in-memory
 * image. sql.js implements it by closing and re-opening the connection, which
 * silently resets `PRAGMA foreign_keys` to OFF on the shared handle — a read has
 * no business doing that to the running app. See `flush` in lib/db/client.ts,
 * which re-applies the pragmas for exactly this reason.
 */
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { readDb, resolveDbPath } from "@/lib/db/client";
import {
  accounts,
  assetHistory,
  assets,
  budgets,
  categories,
  netWorthSnapshots,
  quickCommands,
  recurringTransactions,
  settings,
  transactions,
  visitedCountries,
} from "@/lib/db/schema";
import { isDateKey, toDateKey, todayKey, type DateKey } from "@/lib/dates";
import type { Cents } from "@/lib/money";
import {
  buildTransactionsCsv,
  centsToDecimalString,
  normalizeCurrencyCode,
  type CsvTransactionRow,
} from "@/lib/reports";

export type ExportResult<T> = { success: true; data: T } | { error: string };

/** First 16 bytes of every valid SQLite file. */
const SQLITE_MAGIC = "SQLite format 3\0";

function assertRangeKeys(fromKey: string, toKey: string): { fromKey: DateKey; toKey: DateKey } {
  if (!isDateKey(fromKey)) throw new Error(`Invalid start date: expected 'YYYY-MM-DD', got ${String(fromKey)}`);
  if (!isDateKey(toKey)) throw new Error(`Invalid end date: expected 'YYYY-MM-DD', got ${String(toKey)}`);
  if (fromKey > toKey) throw new Error(`The start date (${fromKey}) is after the end date (${toKey})`);
  return { fromKey, toKey };
}

/**
 * A money column as an exact decimal string. ONE conversion, at the file
 * boundary, done with integer arithmetic — see `centsToDecimalString`. Null stays
 * null (a category with no budget is not a budget of 0.00).
 */
function money(cents: Cents | null | undefined): string | null {
  return cents === null || cents === undefined ? null : centsToDecimalString(cents);
}

/**
 * An INSTANT (`created_at`/`updated_at`, stored as unixepoch) as ISO-8601 UTC.
 *
 * This is the one place `toISOString()` is correct: these columns are moments in
 * time, not calendar days. The house rule — never `toISOString()` on a calendar
 * date — applies to `transactions.date`, which is exported through `toDateKey`
 * below precisely because it IS a calendar day.
 */
function instant(value: Date | null | undefined): string | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

/** A stored transaction timestamp as the LOCAL calendar day the user entered. */
function dayOf(value: Date): DateKey {
  return toDateKey(value);
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

export type CsvExportOptions = {
  /** Inclusive 'YYYY-MM-DD'. */
  fromKey: string;
  /** Inclusive 'YYYY-MM-DD'. */
  toKey: string;
  /**
   * Pending rows are excluded by default, matching how every balance and report
   * in this app treats them.
   */
  includePending?: boolean;
  /**
   * Transfers are excluded by default: a transfer has NO category, so the
   * importer would reject the row. Include them for a complete record and accept
   * that those lines will not re-import.
   */
  includeTransfers?: boolean;
  /**
   * Restrict to accounts denominated in this currency. There is no FX in this
   * app, so a mixed-currency file has an `Amount` column in several units — the
   * `Currency` column says which, but exporting one currency at a time is safer.
   */
  currency?: string;
};

export type CsvExportData = {
  fileName: string;
  /** The complete file contents, UTF-8 with a BOM. */
  csv: string;
  rowCount: number;
  /** Rows in range that were left out, and why. */
  skipped: { pending: number; transfers: number; otherCurrency: number };
  /** Every currency that made it into the file. More than one = no FX applied. */
  currencies: string[];
};

/**
 * Transactions over a date range as a CSV the app's own importer can read back.
 *
 * `Amount` is the stored MAGNITUDE, not a signed figure: the importer takes the
 * absolute value and derives the direction from the category (that is the sign
 * rule in import-logic.ts), so magnitude + category is the only pairing that
 * round-trips exactly.
 */
export async function exportTransactionsCsv(
  options: CsvExportOptions,
): Promise<ExportResult<CsvExportData>> {
  try {
    const { fromKey, toKey } = assertRangeKeys(options.fromKey, options.toKey);
    const includePending = options.includePending === true;
    const includeTransfers = options.includeTransfers === true;
    const wantedCurrency = options.currency ? normalizeCurrencyCode(options.currency) : null;

    const { txRows, categoryRows, accountRows } = await readDb(async (db) => ({
      txRows: await db.select().from(transactions),
      categoryRows: await db.select().from(categories),
      accountRows: await db.select().from(accounts),
    }));

    const categoryById = new Map(categoryRows.map((c) => [c.id, c]));
    const accountById = new Map(accountRows.map((a) => [a.id, a]));

    const skipped = { pending: 0, transfers: 0, otherCurrency: 0 };
    const currencies = new Set<string>();
    const rows: CsvTransactionRow[] = [];

    // Chronological, then by id, so two exports of the same range are identical.
    const sorted = [...txRows].sort((a, b) => {
      const left = dayOf(a.date);
      const right = dayOf(b.date);
      return left === right ? a.id - b.id : left < right ? -1 : 1;
    });

    for (const tx of sorted) {
      const dateKey = dayOf(tx.date);
      if (dateKey < fromKey || dateKey > toKey) continue;

      const isTransfer = tx.transferAccountId !== null && tx.transferAccountId !== undefined;
      if (isTransfer && !includeTransfers) {
        skipped.transfers += 1;
        continue;
      }
      if (tx.pending && !includePending) {
        skipped.pending += 1;
        continue;
      }

      const account = tx.accountId == null ? undefined : accountById.get(tx.accountId);
      const currency = normalizeCurrencyCode(account?.currency);
      if (wantedCurrency !== null && account !== undefined && currency !== wantedCurrency) {
        skipped.otherCurrency += 1;
        continue;
      }

      const category = tx.categoryId == null ? undefined : categoryById.get(tx.categoryId);
      currencies.add(currency);
      rows.push({
        dateKey,
        categoryName: category?.name ?? "",
        categoryType: category?.type ?? "",
        amountCents: tx.amountCents,
        description: tx.comment,
        accountName: account?.name ?? "",
        pending: tx.pending === true,
        transferAccountName:
          tx.transferAccountId == null ? null : (accountById.get(tx.transferAccountId)?.name ?? `#${tx.transferAccountId}`),
        currency,
      });
    }

    return {
      success: true,
      data: {
        fileName: `budget-transactions-${fromKey}_${toKey}.csv`,
        csv: buildTransactionsCsv(rows),
        rowCount: rows.length,
        skipped,
        currencies: [...currencies].sort(),
      },
    };
  } catch (error) {
    console.error("Failed to export transactions as CSV:", error);
    return { error: (error as Error).message || "Failed to export transactions" };
  }
}

// ---------------------------------------------------------------------------
// JSON backup
// ---------------------------------------------------------------------------

export type JsonBackupData = {
  fileName: string;
  /** The complete file contents. */
  json: string;
  byteLength: number;
  /** Row count per table, so the UI can show what was actually captured. */
  counts: Record<string, number>;
};

/**
 * Every table, as readable JSON.
 *
 * Money is an exact two-decimal STRING (`"45.50"`), not raw cents, so the file
 * opens in any editor and reads like money — and `parseAmount` turns each one back
 * into the identical integer. Calendar days are 'YYYY-MM-DD'; `createdAt` /
 * `updatedAt` are instants and therefore ISO-8601 UTC.
 *
 * All tables are read inside ONE `readDb` call, i.e. under one hold of the
 * database lock, so the backup is a single consistent snapshot rather than eleven
 * queries that could straddle a write.
 */
export async function exportJsonBackup(): Promise<ExportResult<JsonBackupData>> {
  try {
    const raw = await readDb(async (db) => ({
      accounts: await db.select().from(accounts),
      categories: await db.select().from(categories),
      transactions: await db.select().from(transactions),
      budgets: await db.select().from(budgets),
      recurring: await db.select().from(recurringTransactions),
      assets: await db.select().from(assets),
      assetHistory: await db.select().from(assetHistory),
      netWorthSnapshots: await db.select().from(netWorthSnapshots),
      settings: await db.select().from(settings),
      quickCommands: await db.select().from(quickCommands),
      visitedCountries: await db.select().from(visitedCountries),
    }));

    const payload = {
      meta: {
        app: "budget",
        kind: "full-backup",
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        /**
         * Read this before trusting any number in the file:
         *  - money is a decimal string in the row's own `currency`, and NO
         *    exchange rate has been applied to anything;
         *  - `date` fields are local calendar days;
         *  - `createdAt`/`updatedAt` are instants (ISO-8601 UTC).
         */
        conventions: {
          money: "exact decimal string, e.g. \"45.50\" (parse with lib/money parseAmount)",
          calendarDays: "YYYY-MM-DD, local calendar day",
          instants: "ISO-8601 UTC",
          fx: "none applied: each row carries its own currency",
          amounts:
            "transaction amounts are MAGNITUDES; the direction comes from the category type, or from transferTo for a transfer",
        },
        sourceFile: resolveDbPath(),
      },
      accounts: raw.accounts.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        type: row.type,
        // A magnitude: for a liability this is what is OWED. See lib/cash-balance.ts.
        openingBalance: money(row.openingBalanceCents),
        currency: row.currency,
        archived: row.archived,
        createdAt: instant(row.createdAt),
        updatedAt: instant(row.updatedAt),
      })),
      categories: raw.categories.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        monthlyLimit: money(row.monthlyLimitCents),
        icon: row.icon,
        color: row.color,
        createdAt: instant(row.createdAt),
        updatedAt: instant(row.updatedAt),
      })),
      transactions: raw.transactions.map((row) => ({
        id: row.id,
        date: dayOf(row.date),
        categoryId: row.categoryId,
        accountId: row.accountId,
        transferAccountId: row.transferAccountId,
        amount: money(row.amountCents),
        comment: row.comment,
        pending: row.pending,
        recurringId: row.recurringId,
        recurringOccurrence: row.recurringOccurrence,
        createdAt: instant(row.createdAt),
        updatedAt: instant(row.updatedAt),
      })),
      budgets: raw.budgets.map((row) => ({
        id: row.id,
        categoryId: row.categoryId,
        period: row.period,
        limit: money(row.limitCents),
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        rollover: row.rollover,
        createdAt: instant(row.createdAt),
        updatedAt: instant(row.updatedAt),
      })),
      recurring: raw.recurring.map((row) => ({
        id: row.id,
        name: row.name,
        accountId: row.accountId,
        transferAccountId: row.transferAccountId,
        categoryId: row.categoryId,
        amount: money(row.amountCents),
        comment: row.comment,
        frequency: row.frequency,
        interval: row.interval,
        startDate: row.startDate,
        endDate: row.endDate,
        nextDue: row.nextDue,
        lastGenerated: row.lastGenerated,
        archived: row.archived,
        createdAt: instant(row.createdAt),
        updatedAt: instant(row.updatedAt),
      })),
      assets: raw.assets.map((row) => ({
        id: row.id,
        category: row.category,
        currentValue: money(row.currentValueCents),
        currency: row.currency,
        notes: row.notes,
        commodityType: row.commodityType,
        // A physical weight, NOT money: it stays a number.
        quantity: row.quantity,
        unit: row.unit,
        linkedTransactionIds: row.linkedTransactionIds,
        useLivePrice: row.useLivePrice,
        createdAt: instant(row.createdAt),
        updatedAt: instant(row.updatedAt),
      })),
      assetHistory: raw.assetHistory.map((row) => ({
        id: row.id,
        assetId: row.assetId,
        value: money(row.valueCents),
        recordedAt: instant(row.recordedAt),
      })),
      netWorthSnapshots: raw.netWorthSnapshots.map((row) => ({
        id: row.id,
        date: row.date,
        totalAssets: money(row.totalAssetsCents),
        totalLiabilities: money(row.totalLiabilitiesCents),
        netWorth: money(row.netWorthCents),
        createdAt: instant(row.createdAt),
        updatedAt: instant(row.updatedAt),
      })),
      settings: raw.settings.map((row) => ({
        id: row.id,
        userName: row.userName,
        accentColor: row.accentColor,
        theme: row.theme,
        createdAt: instant(row.createdAt),
        updatedAt: instant(row.updatedAt),
      })),
      quickCommands: raw.quickCommands.map((row) => ({
        id: row.id,
        command: row.command,
        categoryName: row.categoryName,
        amount: money(row.amountCents),
        comment: row.comment,
        createdAt: instant(row.createdAt),
        updatedAt: instant(row.updatedAt),
      })),
      visitedCountries: raw.visitedCountries.map((row) => ({
        id: row.id,
        countryCode: row.countryCode,
        countryName: row.countryName,
        visitedAt: row.visitedAt,
      })),
    };

    const json = `${JSON.stringify(payload, null, 2)}\n`;
    const counts: Record<string, number> = {};
    for (const [table, rows] of Object.entries(raw)) counts[table] = rows.length;

    return {
      success: true,
      data: {
        fileName: `budget-backup-${todayKey()}.json`,
        json,
        byteLength: Buffer.byteLength(json, "utf-8"),
        counts,
      },
    };
  } catch (error) {
    console.error("Failed to build the JSON backup:", error);
    return { error: (error as Error).message || "Failed to build the JSON backup" };
  }
}

// ---------------------------------------------------------------------------
// The database file itself
// ---------------------------------------------------------------------------

export type DatabaseLocation = {
  /** Absolute path to the live database. */
  path: string;
  /** Previous generation, kept by every atomic save in lib/db/client.ts. */
  backupPath: string;
  exists: boolean;
  byteLength: number;
  /** When the file was last written, as an instant. Null when it does not exist. */
  savedAt: string | null;
};

/**
 * Where the user's data actually lives — so the answer to "how do I back this up?"
 * is a path they can copy, not a support thread.
 */
export async function describeDatabaseLocation(): Promise<ExportResult<DatabaseLocation>> {
  try {
    const path = resolveDbPath();
    const backupPath = `${path}.bak`;
    try {
      const stat = statSync(path);
      return {
        success: true,
        data: {
          path,
          backupPath,
          exists: stat.isFile(),
          byteLength: stat.size,
          savedAt: new Date(stat.mtimeMs).toISOString(),
        },
      };
    } catch {
      return { success: true, data: { path, backupPath, exists: false, byteLength: 0, savedAt: null } };
    }
  } catch (error) {
    console.error("Failed to locate the database file:", error);
    return { error: (error as Error).message || "Failed to locate the database file" };
  }
}

export type DatabaseFileData = {
  fileName: string;
  /** The complete file, base64-encoded for transport through a server action. */
  base64: string;
  byteLength: number;
  path: string;
  /** Which generation this is — see the note about the last-saved caveat. */
  savedAt: string | null;
};

/**
 * The live `budget.db`, in full, as a download.
 *
 * Read under the database lock so no flush can be in flight, then header-checked
 * before it is handed over: a file that is not a SQLite database is refused rather
 * than delivered as a "backup" the user would only discover was junk on the day
 * they needed it.
 */
export async function exportDatabaseFile(): Promise<ExportResult<DatabaseFileData>> {
  try {
    const result = await readDb(async () => {
      const path = resolveDbPath();
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error(`${path} is not a regular file`);

      const buffer = await readFile(path);
      if (buffer.length < 512) {
        throw new Error(`${path} is only ${buffer.length} bytes, which is not a usable database`);
      }
      if (buffer.subarray(0, SQLITE_MAGIC.length).toString("binary") !== SQLITE_MAGIC) {
        throw new Error(`${path} is not a valid SQLite database (bad header): refusing to hand it over as a backup`);
      }

      return {
        fileName: `budget-${todayKey()}.db`,
        base64: buffer.toString("base64"),
        byteLength: buffer.length,
        path,
        savedAt: new Date(stat.mtimeMs).toISOString(),
      };
    });

    return { success: true, data: result };
  } catch (error) {
    console.error("Failed to read the database file:", error);
    return { error: (error as Error).message || "Failed to read the database file" };
  }
}
