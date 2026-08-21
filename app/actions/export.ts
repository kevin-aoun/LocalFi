"use server";

import { statSync } from "node:fs";

import {
  readDb,
  resolveDbPath,
  snapshotEncryptedDatabaseGeneration,
} from "@/lib/db/client";
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
  travelCities,
  transactions,
  visitedCountries,
} from "@/lib/db/schema";
import { isDateKey, toDateKey, todayKey, type DateKey } from "@/lib/dates";
import type { Cents } from "@/lib/money";
import { inspectVaultEnvelope, isVaultEnvelope } from "@/lib/vault/envelope";
import {
  buildTransactionsCsv,
  centsToDecimalString,
  normalizeCurrencyCode,
  type CsvTransactionRow,
} from "@/lib/reports";

export type ExportResult<T> = { success: true; data: T } | { error: string };

function assertRangeKeys(fromKey: string, toKey: string): { fromKey: DateKey; toKey: DateKey } {
  if (!isDateKey(fromKey)) throw new Error(`Invalid start date: expected 'YYYY-MM-DD', got ${String(fromKey)}`);
  if (!isDateKey(toKey)) throw new Error(`Invalid end date: expected 'YYYY-MM-DD', got ${String(toKey)}`);
  if (fromKey > toKey) throw new Error(`The start date (${fromKey}) is after the end date (${toKey})`);
  return { fromKey, toKey };
}


function money(cents: Cents | null | undefined): string | null {
  return cents === null || cents === undefined ? null : centsToDecimalString(cents);
}


function instant(value: Date | null | undefined): string | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}


function dayOf(value: Date): DateKey {
  return toDateKey(value);
}





export type CsvExportOptions = {

  fromKey: string;

  toKey: string;

  includePending?: boolean;

  includeTransfers?: boolean;

  currency?: string;
};

export type CsvExportData = {
  fileName: string;

  csv: string;
  rowCount: number;

  skipped: { pending: number; transfers: number; otherCurrency: number };

  currencies: string[];
};


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





export type JsonBackupData = {
  fileName: string;

  json: string;
  byteLength: number;

  counts: Record<string, number>;
};


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
      travelCheckpoints: await db.select().from(travelCities),
      visitedCountries: await db.select().from(visitedCountries),
    }));

    const payload = {
      meta: {
        app: "budget",
        kind: "data-export",
        formatVersion: 1,
        exportedAt: new Date().toISOString(),

        conventions: {
          money: "exact decimal string, e.g. \"45.50\" (parse with lib/money parseAmount)",
          calendarDays: "YYYY-MM-DD, local calendar day",
          instants: "ISO-8601 UTC",
          fx: "none applied: each row carries its own currency",
          amounts:
            "transaction amounts are MAGNITUDES; the direction comes from the category type, or from transferTo for a transfer",
        },
      },
      accounts: raw.accounts.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        type: row.type,

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
        showLedger: row.showLedger,
        idleTimeoutMinutes: row.idleTimeoutMinutes,
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
      travelCheckpoints: raw.travelCheckpoints.map((row) => ({
        id: row.id,
        countryCode: row.countryCode,
        cityName: row.cityName,
        latitude: row.latitude,
        longitude: row.longitude,
        originCityId: row.originCityId,
        visitedAt: row.visitedAt,
      })),
    };

    const json = `${JSON.stringify(payload, null, 2)}\n`;
    const counts: Record<string, number> = {};
    for (const [table, rows] of Object.entries(raw)) counts[table] = rows.length;

    return {
      success: true,
      data: {
        fileName: `budget-data-export-${todayKey()}.json`,
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





export type DatabaseLocation = {

  path: string;

  backupPath: string;
  exists: boolean;
  byteLength: number;

  savedAt: string | null;
};


export async function describeDatabaseLocation(): Promise<ExportResult<DatabaseLocation>> {
  try {
    const data = await readDb(async () => {
      const path = resolveDbPath();
      const backupPath = `${path}.bak`;
      try {
        const stat = statSync(path);
        return {
          path,
          backupPath,
          exists: stat.isFile(),
          byteLength: stat.size,
          savedAt: new Date(stat.mtimeMs).toISOString(),
        };
      } catch {
        return { path, backupPath, exists: false, byteLength: 0, savedAt: null };
      }
    });
    return { success: true, data };
  } catch (error) {
    console.error("Failed to locate the database file:", error);
    return { error: (error as Error).message || "Failed to locate the database file" };
  }
}

export type DatabaseFileData = {
  fileName: string;

  base64: string;
  byteLength: number;
};


export async function exportDatabaseFile(): Promise<ExportResult<DatabaseFileData>> {
  try {
    const snapshot = await snapshotEncryptedDatabaseGeneration();
    if (!isVaultEnvelope(snapshot.bytes)) {
      throw new Error("Database snapshot is not a LocalFi vault envelope; refusing to export it.");
    }
    await inspectVaultEnvelope(snapshot.bytes);

    const result = {
      fileName: snapshot.fileName,
      base64: Buffer.from(snapshot.bytes).toString("base64"),
      byteLength: snapshot.bytes.byteLength,
    };

    return { success: true, data: result };
  } catch (error) {
    console.error("Failed to export the encrypted database generation:", error);
    return { error: (error as Error).message || "Failed to export the encrypted database generation" };
  }
}
