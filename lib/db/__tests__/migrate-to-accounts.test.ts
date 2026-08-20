
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";

import {
  formatAccountsReport,
  migrateDatabaseToAccounts,
} from "../migrate-to-accounts";
import { CENTS_ONLY_COLUMNS } from "../migrate-to-cents";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "drizzle", "migrations");

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(PROJECT_ROOT, "node_modules/sql.js/dist", file),
  });
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function execScript(db: Database, sql: string) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

function pre0003(): Database {
  const db = new SQL.Database();
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    if (entry.idx > 2) break;
    execScript(db, readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf-8"));
  }
  return db;
}

/**
 * A database shaped like data/budget.db: 14 categories (8 with monthly limits),
 * transactions including the two `category_id = 0` orphans, 3 assets, and one
 * asset_history row so the ON DELETE CASCADE guard has something to protect.
 * The transaction amounts are chosen so the derived cash balance is exactly
 * 449618 cents, the live figure.
 */
const LIVE_CATEGORIES: Array<[number, string, string, number | null]> = [
  [1, "Food", "Expense", 5000],
  [2, "Salary", "Income", null],
  [3, "Personal Development", "Expense", 20000],
  [4, "Startups", "Expense", 10000],
  [5, "Shopping", "Expense", 10000],
  [6, "Transport", "Expense", 3000],
  [7, "Subscriptions", "Expense", 12000],
  [8, "Travel", "Expense", null],
  [9, "Entertainment", "Expense", 2000],
  [10, "Commodities", "Investment", null],
  [11, "Freelance Consulting", "Income", null],
  [12, "Allowance", "Income", null],
  [13, "Gifts", "Expense", 5000],
  [14, "Crypto", "Investment", null],
];

function makeFixture(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "budget-0003-script-"));
  dirs.push(dir);
  const file = path.join(dir, "budget.db");

  const db = pre0003();
  db.run("PRAGMA foreign_keys = OFF"); // reproduce the pre-existing orphans

  for (const [id, name, type, limit] of LIVE_CATEGORIES) {
    db.run("INSERT INTO categories (id, name, type, monthly_limit_cents, icon, color) VALUES (?,?,?,?,'W','#000')", [
      id, name, type, limit,
    ]);
  }

  // Income 1,000,000 - expenses 550,382 = 449,618 cents.
  db.run("INSERT INTO transactions (id, date, category_id, amount_cents, comment, pending) VALUES (1, 1750982400, 2, 1000000, 'salary', 0)");
  db.run("INSERT INTO transactions (id, date, category_id, amount_cents, comment, pending) VALUES (2, 1751068800, 1, 43704, 'groceries', 0)");
  db.run("INSERT INTO transactions (id, date, category_id, amount_cents, comment, pending) VALUES (3, 1751155200, 10, 506678, 'gold', 0)");
  // The two orphans: they contribute nothing to the balance, before or after.
  db.run("INSERT INTO transactions (id, date, category_id, amount_cents, comment, pending) VALUES (17, 1769731200, 0, 2400, 'Bank cheque tax (2 * 1%)', 0)");
  db.run("INSERT INTO transactions (id, date, category_id, amount_cents, comment, pending) VALUES (40, 1769817600, 0, 500, 'registrar certificate of enrolment spring 2026', 0)");

  db.run("INSERT INTO assets (id, category, current_value_cents, currency, notes) VALUES (1,'Cash',449618,'USD','Auto-calculated from transactions')");
  db.run("INSERT INTO assets (id, category, current_value_cents, currency) VALUES (2,'Commodities',532371,'USD')");
  db.run("INSERT INTO assets (id, category, current_value_cents, currency, notes) VALUES (4,'Crypto',7000,'USD','BTC + ETH')");
  db.run("INSERT INTO asset_history (asset_id, value_cents, recorded_at) VALUES (2, 500000, 1750982400)");
  db.run("INSERT INTO quick_commands (command, category_name, amount_cents, comment) VALUES ('salary','Salary',140000,'monthly')");
  db.run("INSERT INTO settings (user_name) VALUES ('Test User')");

  writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return { dir, file };
}

function open(file: string): Database {
  return new SQL.Database(readFileSync(file));
}

function scalar(db: Database, sql: string): unknown {
  return db.exec(sql)[0]?.values?.[0]?.[0] ?? null;
}

async function migrate(file: string, extra: Record<string, unknown> = {}) {
  return migrateDatabaseToAccounts({
    dbPath: file,
    backupDir: path.join(path.dirname(file), "backups"),
    migrationSqlPath: path.join(MIGRATIONS_DIR, "0003_accounts_and_budget_periods.sql"),
    expectedCashBalanceCents: 449618,
    expectedCounts: { transactions: 5, categories: 14, assets: 3 },
    ...extra,
  });
}

describe("migrateDatabaseToAccounts — happy path", () => {
  it("preserves row counts, the total and the derived cash balance", async () => {
    const { file } = makeFixture();
    const result = await migrate(file);

    expect(result.alreadyMigrated).toBe(false);
    expect(result.countsAfter).toEqual(result.countsBefore);
    expect(result.sumAmountsAfter).toBe(result.sumAmountsBefore);
    expect(result.cashBalanceBefore).toBe(449618);
    expect(result.cashBalanceAfter).toBe(449618);
  });

  it("protects asset_history from the ON DELETE CASCADE during the rebuild", async () => {
    const { file } = makeFixture();
    const result = await migrate(file);
    expect(result.countsBefore.asset_history).toBe(1);
    expect(result.countsAfter.asset_history).toBe(1);
  });

  it("repairs the orphans to NULL, preserving their amounts", async () => {
    const { file } = makeFixture();
    const result = await migrate(file);

    expect(result.repairedRows).toEqual([
      { id: 17, previousCategoryId: 0, amountCents: 2400, comment: "Bank cheque tax (2 * 1%)" },
      { id: 40, previousCategoryId: 0, amountCents: 500, comment: "registrar certificate of enrolment spring 2026" },
    ]);

    const db = open(file);
    try {
      expect(db.exec("SELECT id, category_id, amount_cents FROM transactions WHERE id IN (17,40) ORDER BY id")[0].values).toEqual([
        [17, null, 2400],
        [40, null, 500],
      ]);
    } finally {
      db.close();
    }
  });

  it("clears the pre-existing foreign-key violations and introduces none", async () => {
    const { file } = makeFixture();
    const result = await migrate(file);
    expect(result.foreignKeyViolationsBefore).toHaveLength(2);
    expect(result.foreignKeyViolationsAfter).toEqual([]);
  });

  it("seeds one default account and attaches every transaction to it", async () => {
    const { file } = makeFixture();
    const result = await migrate(file);
    expect(result.defaultAccount).toEqual({ id: 1, name: "Main", kind: "asset", type: "Checking" });
    expect(result.transactionsOnDefaultAccount).toBe(5);
  });

  it("copies all 8 legacy monthly limits into budgets and keeps the legacy column", async () => {
    const { file } = makeFixture();
    const result = await migrate(file);

    expect(result.legacyLimits).toHaveLength(8);
    expect(result.migratedBudgets.map((b) => [b.categoryId, b.limitCents])).toEqual([
      [1, 5000], [3, 20000], [4, 10000], [5, 10000], [6, 3000], [7, 12000], [9, 2000], [13, 5000],
    ]);
    expect(new Set(result.migratedBudgets.map((b) => b.effectiveFrom))).toEqual(new Set(["2025-06-01"]));

    const db = open(file);
    try {
      expect(Number(scalar(db, "SELECT COUNT(*) FROM categories WHERE monthly_limit_cents IS NOT NULL"))).toBe(8);
    } finally {
      db.close();
    }
  });

  it("declares every new money column as an integer NOT NULL column", async () => {
    const { file } = makeFixture();
    await migrate(file);
    const db = open(file);
    try {
      for (const spec of CENTS_ONLY_COLUMNS) {
        const info = db.exec(`PRAGMA table_info(${spec.table})`)[0].values.find((r) => String(r[1]) === spec.column);
        expect(info, `${spec.table}.${spec.column} missing`).toBeDefined();
        expect(String(info![2]).toLowerCase()).toBe("integer");
        expect(Number(info![3]) === 1).toBe(spec.notNull);
      }
    } finally {
      db.close();
    }
  });

  it("writes a timestamped backup BEFORE touching the file", async () => {
    const { file } = makeFixture();
    const before = readFileSync(file);
    const result = await migrate(file);

    expect(result.backupPath).toBeTruthy();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(readFileSync(result.backupPath!).equals(before)).toBe(true);
    expect(path.basename(result.backupPath!)).toMatch(/^budget\..*\.pre-0003\.db$/);
  });

  it("refuses to run twice", async () => {
    const { file } = makeFixture();
    await migrate(file);
    const bytes = readFileSync(file);

    const second = await migrate(file, {
      expectedCashBalanceCents: undefined,
      expectedCounts: undefined,
    });
    expect(second.alreadyMigrated).toBe(true);
    expect(second.backupPath).toBeNull();
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it("writes nothing in dry-run mode", async () => {
    const { file } = makeFixture();
    const before = readFileSync(file);
    const result = await migrate(file, { dryRun: true });

    expect(result.alreadyMigrated).toBe(false);
    expect(result.cashBalanceAfter).toBe(449618);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(existsSync(path.join(path.dirname(file), "backups"))).toBe(false);
  });

  it("produces a report naming the repair and the assertions", async () => {
    const { file } = makeFixture();
    const report = formatAccountsReport(await migrate(file));
    expect(report).toContain("449618");
    expect(report).toContain("$4,496.18");
    expect(report).toContain("category_id 0 -> NULL");
    expect(report).toContain("conserved");
    expect(report).toContain("2 violation(s) before, 0 after");
  });
});

describe("migrateDatabaseToAccounts — verification bites", () => {
  /** Run a migration whose in-memory result has been sabotaged. */
  async function sabotage(corrupt: (db: Database) => void) {
    const { file } = makeFixture();
    const before = readFileSync(file);
    const error = await migrate(file, { corruptForTest: corrupt }).then(
      () => null,
      (e: Error) => e,
    );
    return { file, before, error };
  }

  it("restores the backup when a transaction amount was altered", async () => {
    const { file, before, error } = await sabotage((db) => {
      db.run("UPDATE transactions SET amount_cents = amount_cents + 1 WHERE id = 1");
    });
    expect(error?.message).toMatch(/amount changed/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("restores the backup when a row was deleted", async () => {
    const { file, before, error } = await sabotage((db) => {
      db.run("DELETE FROM transactions WHERE id = 3");
    });
    expect(error?.message).toMatch(/row count changed/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("restores the backup when asset_history was cascaded away", async () => {
    const { file, before, error } = await sabotage((db) => {
      db.run("DELETE FROM asset_history");
    });
    expect(error?.message).toMatch(/asset_history row count changed/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("restores the backup when a good category was NULLed out", async () => {
    const { file, before, error } = await sabotage((db) => {
      db.run("UPDATE transactions SET category_id = NULL WHERE id = 2");
    });
    expect(error?.message).toMatch(/category changed/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("restores the backup when the cash balance moved", async () => {
    const { file, before, error } = await sabotage((db) => {
      // Attach an orphan to a real Expense category: totals unchanged, but the
      // derived cash balance drops by 24.00 — exactly the mistake NOT to make.
      db.run("UPDATE transactions SET category_id = 1 WHERE id = 17");
    });
    expect(error?.message).toMatch(/cash balance changed|should now be NULL/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("restores the backup when a transaction was left off the default account", async () => {
    const { file, before, error } = await sabotage((db) => {
      db.run("UPDATE transactions SET account_id = NULL WHERE id = 1");
    });
    expect(error?.message).toMatch(/on the default account/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("restores the backup when a budget row went missing", async () => {
    const { file, before, error } = await sabotage((db) => {
      db.run("DELETE FROM budgets WHERE category_id = 1");
    });
    expect(error?.message).toMatch(/legacy monthly limit/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("restores the backup when a migrated budget amount is wrong", async () => {
    const { file, before, error } = await sabotage((db) => {
      db.run("UPDATE budgets SET limit_cents = 1 WHERE category_id = 1");
    });
    expect(error?.message).toMatch(/expected 5000/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("restores the backup when the legacy column was cleared", async () => {
    const { file, before, error } = await sabotage((db) => {
      db.run("UPDATE categories SET monthly_limit_cents = NULL WHERE id = 1");
    });
    expect(error?.message).toMatch(/monthly_limit_cents was modified/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("restores the backup when a NEW foreign-key violation appears", async () => {
    const { file, before, error } = await sabotage((db) => {
      db.run("PRAGMA foreign_keys = OFF");
      db.run("UPDATE transactions SET account_id = 999 WHERE id = 2");
    });
    // Either the account check or the FK check catches it; both must restore.
    expect(error).toBeTruthy();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("restores the backup when a transfer was invented", async () => {
    const { file, before, error } = await sabotage((db) => {
      db.run("UPDATE transactions SET transfer_account_id = 1, account_id = NULL WHERE id = 2");
    });
    expect(error).toBeTruthy();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("keeps exactly one backup per failed run, so the original is always recoverable", async () => {
    const { file } = await sabotage((db) => {
      db.run("DELETE FROM transactions WHERE id = 3");
    });
    const backups = readdirSync(path.join(path.dirname(file), "backups"));
    expect(backups).toHaveLength(1);
  });
});

describe("migrateDatabaseToAccounts — pre-flight refusals", () => {
  it("refuses a database whose row counts do not match expectations", async () => {
    const { file } = makeFixture();
    const before = readFileSync(file);
    await expect(migrate(file, { expectedCounts: { transactions: 71 } })).rejects.toThrow(
      /expected 71 row\(s\) in transactions, found 5/,
    );
    expect(readFileSync(file).equals(before)).toBe(true);
    // Nothing was backed up, because nothing was attempted.
    expect(existsSync(path.join(path.dirname(file), "backups"))).toBe(false);
  });

  it("refuses a database whose cash balance does not match expectations", async () => {
    const { file } = makeFixture();
    await expect(migrate(file, { expectedCashBalanceCents: 1 })).rejects.toThrow(
      /cash balance is 449618 cents, expected 1/,
    );
  });

  it("refuses a database that still has float money columns", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "budget-0003-float-"));
    dirs.push(dir);
    const file = path.join(dir, "budget.db");
    const db = new SQL.Database();
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
      if (entry.idx > 1) break;
      execScript(db, readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf-8"));
    }
    writeFileSync(file, Buffer.from(db.export()));
    db.close();

    await expect(
      migrateDatabaseToAccounts({
        dbPath: file,
        backupDir: path.join(dir, "backups"),
        migrationSqlPath: path.join(MIGRATIONS_DIR, "0003_accounts_and_budget_periods.sql"),
      }),
    ).rejects.toThrow(/migration 0002.*first/i);
  });

  it("refuses a half-migrated database", async () => {
    const { file } = makeFixture();
    const db = open(file);
    db.run("CREATE TABLE accounts (id integer PRIMARY KEY)");
    writeFileSync(file, Buffer.from(db.export()));
    db.close();

    await expect(migrate(file)).rejects.toThrow(/half-migrated/);
  });

  it("refuses a missing and an empty file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "budget-0003-missing-"));
    dirs.push(dir);
    await expect(
      migrateDatabaseToAccounts({ dbPath: path.join(dir, "nope.db"), backupDir: dir }),
    ).rejects.toThrow(/not found/);

    const empty = path.join(dir, "empty.db");
    writeFileSync(empty, "");
    await expect(migrateDatabaseToAccounts({ dbPath: empty, backupDir: dir })).rejects.toThrow(/empty/);
  });
});
