import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { toDateKey } from "../../dates";
import { migrateToLedgerSemantics } from "../migrate-to-ledger-semantics";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "drizzle", "migrations");
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (file) => path.join(ROOT, "node_modules/sql.js/dist", file) });
});

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function pre0009Database(options?: { mixedTransfer?: boolean }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "budget-0009-"));
  temporaryDirectories.push(directory);
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const db = new SQL.Database();
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    if (entry.idx >= 9) break;
    const sql = readFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) db.exec(statement);
    }
  }

  db.run("UPDATE accounts SET created_at = strftime('%s', '2020-02-03T12:00:00Z') WHERE id = 1");
  db.run(
    "INSERT INTO accounts (id, name, kind, type, opening_balance_cents, currency, archived, created_at) " +
      "VALUES (2, 'Savings', 'asset', 'Savings', -5000, ?, 0, strftime('%s', '2021-04-05T23:00:00Z'))",
    [options?.mixedTransfer ? "EUR" : "USD"],
  );
  db.run(
    "INSERT INTO categories (id, name, type, icon, color) VALUES " +
      "(1, 'Salary', 'Income', 'Wallet', '#0f0'), (2, 'Food', 'Expense', 'Wallet', '#f00')",
  );
  db.run(
    "INSERT INTO transactions (id, date, category_id, account_id, amount_cents) VALUES " +
      "(1, 1, 1, 1, 10000), (2, 2, 2, 1, -2500)",
  );
  db.run(
    "INSERT INTO transactions (id, date, category_id, account_id, transfer_account_id, amount_cents) " +
      "VALUES (3, 3, NULL, 1, 2, -3000)",
  );

  const file = path.join(directory, "budget.db");
  writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return file;
}

describe("migration 0009", () => {
  it.each([
    ["Pacific/Kiritimati", "2021-04-06"],
    ["Pacific/Niue", "2021-04-05"],
  ])("backfills opening dates as local calendar keys in %s", async (timezone, expectedDate) => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = timezone;
    try {
      const file = pre0009Database();
      await migrateToLedgerSemantics({ dbPath: file });
      const db = new SQL.Database(readFileSync(file));
      try {
        expect(
          db.exec("SELECT opening_balance_date FROM accounts WHERE id = 2")[0].values,
        ).toEqual([[expectedDate]]);
      } finally {
        db.close();
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("backfills immutable semantics and opening dates while preserving signed effects", async () => {
    const file = pre0009Database();
    const result = await migrateToLedgerSemantics({ dbPath: file });
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
    expect(result.preservedRows.transactions).toBe(3);

    const db = new SQL.Database(readFileSync(file));
    expect(db.exec("SELECT id, opening_balance_cents, opening_balance_date FROM accounts ORDER BY id")[0].values)
      .toEqual([
        [1, 0, toDateKey(new Date("2020-02-03T12:00:00Z"))],
        [2, 5000, toDateKey(new Date("2021-04-05T23:00:00Z"))],
      ]);
    expect(
      db.exec(
        "SELECT id, account_id, transfer_account_id, amount_cents, direction, currency FROM transactions ORDER BY id",
      )[0].values,
    ).toEqual([
      [1, 1, null, 10000, "inflow", "USD"],
      [2, 1, null, 2500, "inflow", "USD"],
      [3, 2, 1, 3000, "transfer", "USD"],
    ]);

    expect(() =>
      db.run(
        "INSERT INTO transactions (date, category_id, account_id, amount_cents, direction, currency) VALUES (4, 2, 1, -1, 'outflow', 'USD')",
      ),
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      db.run(
        "INSERT INTO transactions (date, category_id, account_id, amount_cents, direction, currency) VALUES (4, 2, 1, 1.5, 'outflow', 'USD')",
      ),
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      db.run(
        "INSERT INTO transactions (date, category_id, account_id, amount_cents, direction, currency) VALUES (4, 2, 1, 1, 'sideways', 'USD')",
      ),
    ).toThrow(/CHECK constraint/i);
    expect(() => db.run("UPDATE transactions SET direction = 'legacy' WHERE id = 1")).toThrow(
      /insert-only/i,
    );
    expect(() => db.run("UPDATE accounts SET opening_balance_cents = -1 WHERE id = 1")).toThrow(
      /CHECK constraint/i,
    );
    expect(() => db.run("UPDATE accounts SET opening_balance_cents = 1.5 WHERE id = 1")).toThrow(
      /CHECK constraint/i,
    );
    expect(() => db.run("UPDATE accounts SET currency = 'EUR' WHERE id = 1")).toThrow(
      /currency is immutable/i,
    );
    db.run(
      "INSERT INTO accounts (id, name, kind, type, opening_balance_cents, opening_balance_date, currency, archived) " +
        "VALUES (4, 'Euro', 'asset', 'Checking', 0, '2020-01-01', 'EUR', 0)",
    );
    expect(() =>
      db.run(
        "INSERT INTO transactions (date, category_id, account_id, transfer_account_id, amount_cents, direction, currency) " +
          "VALUES (5, NULL, 1, 4, 100, 'transfer', 'USD')",
      ),
    ).toThrow(/cross-currency/i);
    db.close();

    expect((await migrateToLedgerSemantics({ dbPath: file })).alreadyMigrated).toBe(true);
  });

  it("dry-runs without changing the database", async () => {
    const file = pre0009Database();
    const before = readFileSync(file);
    await migrateToLedgerSemantics({ dbPath: file, dryRun: true });
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("refuses an existing cross-currency transfer instead of inventing FX", async () => {
    const file = pre0009Database({ mixedTransfer: true });
    const before = readFileSync(file);
    await expect(migrateToLedgerSemantics({ dbPath: file })).rejects.toThrow(/cross-currency/i);
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});
