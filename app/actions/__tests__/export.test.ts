
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeDatabaseLocation,
  exportDatabaseFile,
  exportJsonBackup,
  exportTransactionsCsv,
} from "@/app/actions/export";
import { importTransactions } from "@/app/actions/import";
import {
  collectDateValues,
  detectDateOrder,
  isImportable,
  parseImportRows,
  readCsvRows,
  type ImportCategory,
} from "@/components/transactions/import-logic";
import { parseAmount } from "@/lib/money";

import {
  createDomainDb,
  execOn,
  seedAccount,
  seedBudget,
  seedCategory,
  seedTransaction,
  type DomainDb,
} from "./support/domain-fixture";

let temp: DomainDb;

const CATEGORIES: ImportCategory[] = [
  { id: 1, name: "Salary", type: "Income" },
  { id: 2, name: "Groceries", type: "Expense" },
  { id: 3, name: "Brokerage", type: "Investment" },
];

beforeEach(async () => {
  temp = await createDomainDb();

  seedAccount(temp, { id: 10, name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 250_000 });
  seedAccount(temp, { id: 11, name: "Savings", kind: "asset", type: "Savings" });
  seedCategory(temp, { id: 1, name: "Salary", type: "Income" });
  seedCategory(temp, { id: 2, name: "Groceries", type: "Expense" });
  seedCategory(temp, { id: 3, name: "Brokerage", type: "Investment" });
  seedBudget(temp, { id: 1, categoryId: 2, period: "monthly", limitCents: 60_000, effectiveFrom: "2026-01-01" });

  seedTransaction(temp, { id: 1, categoryId: 1, accountId: 10, amountCents: 512_345, dateKey: "2026-01-31", comment: "January pay" });
  seedTransaction(temp, { id: 2, categoryId: 2, accountId: 10, amountCents: 4_550, dateKey: "2026-02-01", comment: 'Coffee, "black"' });
  seedTransaction(temp, { id: 3, categoryId: 3, accountId: 10, amountCents: 200_000, dateKey: "2026-02-10", comment: null });

  seedTransaction(temp, { id: 4, categoryId: 2, accountId: 10, amountCents: 9_900, dateKey: "2026-02-11", pending: true });

  seedTransaction(temp, { id: 5, accountId: 10, transferAccountId: 11, amountCents: 100_000, dateKey: "2026-02-12" });

  seedTransaction(temp, { id: 6, categoryId: 2, accountId: 10, amountCents: 1, dateKey: "2026-03-01" });
});

afterEach(async () => {
  await temp.cleanup();
});

function ok<T>(result: { success: true; data: T } | { error: string }): T {
  if ("error" in result) throw new Error(`action failed: ${result.error}`);
  return result.data;
}

describe("exportTransactionsCsv", () => {
  it("exports the range, excluding pending rows and transfers by default", async () => {
    const data = ok(await exportTransactionsCsv({ fromKey: "2026-01-01", toKey: "2026-02-28" }));

    expect(data.rowCount).toBe(3);
    expect(data.skipped).toEqual({ pending: 1, transfers: 1, otherCurrency: 0 });
    expect(data.fileName).toBe("budget-transactions-2026-01-01_2026-02-28.csv");
    expect(data.currencies).toEqual(["USD"]);
  });

  it("ROUND-TRIPS through the app's own importer: date, category and amount survive", async () => {
    const data = ok(await exportTransactionsCsv({ fromKey: "2026-01-01", toKey: "2026-02-28" }));

    const rows = readCsvRows(data.csv);
    expect(detectDateOrder(collectDateValues(rows)).evidence).not.toBe("conflict");
    const parsed = parseImportRows(rows, CATEGORIES, { dayFirst: false });

    for (const row of parsed) {
      expect(row.problems).toEqual([]);
      expect(isImportable(row)).toBe(true);
    }
    expect(parsed.map((r) => r.date)).toEqual(["2026-01-31", "2026-02-01", "2026-02-10"]);
    expect(parsed.map((r) => r.categoryId)).toEqual([1, 2, 3]);
    expect(parsed.map((r) => r.amountCents)).toEqual([512_345, 4_550, 200_000]);
    expect(parsed.map((r) => r.suggestedType)).toEqual(["Income", "Expense", "Investment"]);
    expect(parsed[1].comment).toBe('Coffee, "black"');
  });

  it("exports an event-backed imported projection through the existing CSV contract", async () => {
    expect(
      await importTransactions(
        [{ date: "2026-02-20", categoryId: 2, amount: "12.34", comment: "Event backed" }],
        { accountId: 10 },
      ),
    ).toMatchObject({ success: true, inserted: 1 });

    const data = ok(await exportTransactionsCsv({ fromKey: "2026-02-20", toKey: "2026-02-20" }));
    expect(data.rowCount).toBe(1);
    const [parsed] = parseImportRows(readCsvRows(data.csv), CATEGORIES, { dayFirst: false });
    expect(parsed).toMatchObject({
      date: "2026-02-20",
      categoryId: 2,
      amountCents: 1234,
      comment: "Event backed",
      problems: [],
    });
  });

  it("includes pending rows and transfers on request", async () => {
    const data = ok(
      await exportTransactionsCsv({
        fromKey: "2026-01-01",
        toKey: "2026-02-28",
        includePending: true,
        includeTransfers: true,
      }),
    );
    expect(data.rowCount).toBe(5);
    expect(data.skipped).toEqual({ pending: 0, transfers: 0, otherCurrency: 0 });
    // A transfer names its destination account and carries no category, which is
    // exactly why it cannot be re-imported — the file says so rather than pretending.
    expect(data.csv).toContain("Savings");
  });

  it("writes amounts as decimal strings that parse back to the same cents", async () => {
    const data = ok(await exportTransactionsCsv({ fromKey: "2026-01-01", toKey: "2026-02-28" }));
    const amounts = readCsvRows(data.csv).map((row) => row.Amount);
    expect(amounts.map((a) => parseAmount(a as string | number))).toEqual([512_345, 4_550, 200_000]);
  });

  it("filters by currency when asked, rather than mixing units under one column", async () => {
    seedAccount(temp, { id: 12, name: "Beirut", kind: "asset", type: "Cash" });
    // Give that account a different currency: no FX anywhere in this app.
    const { execOn } = await import("./support/domain-fixture");
    execOn(temp, (db) => db.run("UPDATE accounts SET currency = 'LBP' WHERE id = 12"));
    seedTransaction(temp, { id: 7, categoryId: 2, accountId: 12, amountCents: 30_000, dateKey: "2026-02-05" });

    const all = ok(await exportTransactionsCsv({ fromKey: "2026-01-01", toKey: "2026-02-28" }));
    expect(all.currencies).toEqual(["LBP", "USD"]);

    const usdOnly = ok(
      await exportTransactionsCsv({ fromKey: "2026-01-01", toKey: "2026-02-28", currency: "usd" }),
    );
    expect(usdOnly.currencies).toEqual(["USD"]);
    expect(usdOnly.skipped.otherCurrency).toBe(1);
  });

  it("refuses an inverted or malformed range instead of exporting nothing quietly", async () => {
    const inverted = await exportTransactionsCsv({ fromKey: "2026-03-01", toKey: "2026-01-01" });
    expect("error" in inverted && inverted.error).toMatch(/after the end date/i);

    const malformed = await exportTransactionsCsv({ fromKey: "2026-3-1", toKey: "2026-01-01" });
    expect("error" in malformed && malformed.error).toMatch(/YYYY-MM-DD/);
  });
});

describe("exportJsonBackup", () => {
  it("captures every table, with a row count per table", async () => {
    const data = ok(await exportJsonBackup());
    expect(data.fileName).toMatch(/^budget-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(data.counts).toMatchObject({
      // 2 seeded + 'Main', which the 0003 migration creates.
      accounts: 3,
      categories: 3,
      transactions: 6,
      budgets: 1,
    });
    // Pending rows and transfers ARE in the backup: a backup is not a report.
    expect(data.counts.transactions).toBe(6);
    expect(Object.keys(data.counts).sort()).toEqual([
      "accounts",
      "assetHistory",
      "assets",
      "budgets",
      "categories",
      "netWorthSnapshots",
      "quickCommands",
      "recurring",
      "settings",
      "transactions",
      "travelCheckpoints",
      "visitedCountries",
    ]);
  });

  it("writes money as an exact decimal string that parseAmount reads back", async () => {
    const backup = JSON.parse(ok(await exportJsonBackup()).json);

    expect(backup.meta.conventions.fx).toMatch(/none applied/i);
    const checking = backup.accounts.find((a: { id: number }) => a.id === 10);
    expect(checking.openingBalance).toBe("2500.00");
    expect(parseAmount(checking.openingBalance)).toBe(250_000);

    const tx = backup.transactions.find((t: { id: number }) => t.id === 2);
    expect(tx.amount).toBe("45.50");
    expect(parseAmount(tx.amount)).toBe(4_550);
    expect(backup.budgets[0].limit).toBe("600.00");
    // "no limit" must stay null, not become 0.00.
    expect(backup.categories[0].monthlyLimit).toBeNull();
  });

  it("writes transaction dates as LOCAL calendar days, not UTC instants", async () => {
    const backup = JSON.parse(ok(await exportJsonBackup()).json);
    const dates = backup.transactions
      .map((t: { date: string }) => t.date)
      .sort();
    expect(dates).toEqual([
      "2026-01-31",
      "2026-02-01",
      "2026-02-10",
      "2026-02-11",
      "2026-02-12",
      "2026-03-01",
    ]);
    for (const date of dates) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps the transfer leg and the pending flag, so the backup is complete", async () => {
    const backup = JSON.parse(ok(await exportJsonBackup()).json);
    const transfer = backup.transactions.find((t: { id: number }) => t.id === 5);
    expect(transfer.transferAccountId).toBe(11);
    expect(transfer.categoryId).toBeNull();
    const pending = backup.transactions.find((t: { id: number }) => t.id === 4);
    expect(pending.pending).toBe(true);
  });

  it("is valid JSON and reports its own byte length", async () => {
    const data = ok(await exportJsonBackup());
    expect(() => JSON.parse(data.json)).not.toThrow();
    expect(data.byteLength).toBe(Buffer.byteLength(data.json, "utf-8"));
  });

  it("includes the persisted Ledger explorer preference", async () => {
    execOn(temp, (db) => {
      db.run(
        "INSERT INTO settings (user_name, accent_color, theme, show_ledger) VALUES ('Owner', 'default', 'system', 1)",
      );
    });
    const backup = JSON.parse(ok(await exportJsonBackup()).json);
    expect(backup.settings).toEqual([
      expect.objectContaining({ userName: "Owner", showLedger: true }),
    ]);
  });
});

describe("exportDatabaseFile / describeDatabaseLocation", () => {
  it("tells the user exactly where their file is", async () => {
    const data = ok(await describeDatabaseLocation());
    expect(data.path).toBe(temp.file);
    expect(data.backupPath).toBe(`${temp.file}.bak`);
    expect(data.exists).toBe(true);
    expect(data.byteLength).toBeGreaterThan(512);
  });

  it("hands over a COMPLETE, valid SQLite image", async () => {
    const data = ok(await exportDatabaseFile());
    const bytes = Buffer.from(data.base64, "base64");

    expect(bytes.length).toBe(data.byteLength);
    expect(bytes.subarray(0, 16).toString("binary")).toBe("SQLite format 3\0");
    expect(data.fileName).toMatch(/^budget-\d{4}-\d{2}-\d{2}\.db$/);
    expect(data.path).toBe(temp.file);
  });

  it("the downloaded image is a usable database, not just plausible bytes", async () => {
    const data = ok(await exportDatabaseFile());
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs({
      locateFile: (file: string) => `${process.cwd()}/node_modules/sql.js/dist/${file}`,
    });
    const handle = new SQL.Database(Buffer.from(data.base64, "base64"));
    try {
      const rows = handle.exec("SELECT COUNT(*) FROM transactions");
      expect(Number(rows[0].values[0][0])).toBe(6);
    } finally {
      handle.close();
    }
  });

  it("refuses a file that is not a SQLite database rather than calling it a backup", async () => {
    const { writeFileSync } = await import("node:fs");
    const { closeDb } = await import("@/lib/db/client");
    await closeDb();
    writeFileSync(temp.file, Buffer.alloc(1024, 0x41)); // 1KB of "A"

    const result = await exportDatabaseFile();
    expect("error" in result && result.error).toMatch(/not a valid SQLite database/i);
  });
});
