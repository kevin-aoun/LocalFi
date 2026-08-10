/**
 * Migration 0004 — priced holdings (`assets.price_symbol`, `assets.priced_at`) —
 * exercised two ways, exactly like 0003:
 *
 *   1. replayed from empty (what lib/db/init.ts does for a fresh install);
 *   2. applied by lib/db/migrate-to-priced-holdings.ts to a database SHAPED LIKE
 *      THE LIVE ONE (14 categories, a 1.1376 oz live-priced gold holding, a
 *      hand-valued "BTC + ETH" row, one asset_history row, derived cash balance
 *      exactly 449618 cents).
 *
 * Everything runs in memory or in a mkdtemp directory. data/budget.db is never
 * opened, and no db:init / db:seed script is ever run.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";

import {
  formatPricedHoldingsReport,
  migrateDatabaseToPricedHoldings,
} from "../migrate-to-priced-holdings";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "drizzle", "migrations");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
const MIGRATION_TAG = "0004_priced_holdings";

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
let journal: { entries: Array<{ idx: number; tag: string }> };

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(PROJECT_ROOT, "node_modules/sql.js/dist", file),
  });
  journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8"));
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

/** Replay the journal up to and including `throughIdx` (mirrors lib/db/init.ts). */
function replay(throughIdx = Infinity): Database {
  const db = new SQL.Database();
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    if (entry.idx > throughIdx) break;
    execScript(db, readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf-8"));
  }
  return db;
}

function rows(db: Database, sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

function scalar(db: Database, sql: string): unknown {
  return rows(db, sql)[0]?.[0] ?? null;
}

function columnInfo(db: Database, table: string) {
  return new Map(
    rows(db, `PRAGMA table_info(${table})`).map((row) => [
      String(row[1]),
      { type: String(row[2]).toLowerCase(), notNull: Number(row[3]) === 1 },
    ]),
  );
}

const LIVE_CATEGORIES: Array<[number, string, string, number | null]> = [
  [1, "Food", "Expense", 5000],
  [2, "Salary", "Income", null],
  [3, "Learning", "Expense", 20000],
  [4, "Business", "Expense", 10000],
  [5, "Shopping", "Expense", 10000],
  [6, "Transport", "Expense", 3000],
  [7, "Subscriptions", "Expense", 12000],
  [8, "Travel", "Expense", null],
  [9, "Entertainment", "Expense", 2000],
  [10, "Commodities", "Investment", null],
  [11, "Contract Work", "Income", null],
  [12, "Reimbursement", "Income", null],
  [13, "Presents", "Expense", 5000],
  [14, "Crypto", "Investment", null],
];

/**
 * A post-0003, pre-0004 database with the live file's asset rows:
 *   id 1 Cash        449618  (derived from the ledger)
 *   id 2 Commodities 532371  Gold, 1.1376 oz, live pricing ON
 *   id 4 Crypto        7000  hand-valued, notes "BTC + ETH", no quantity
 * Income 1,000,000 - 43,704 - 506,678 = 449,618 cents, the live figure.
 */
function makeFixture(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "budget-0004-"));
  dirs.push(dir);
  const file = path.join(dir, "budget.db");

  const db = replay(3);
  db.run("PRAGMA foreign_keys = OFF");

  for (const [id, name, type, limit] of LIVE_CATEGORIES) {
    db.run(
      "INSERT INTO categories (id, name, type, monthly_limit_cents, icon, color) VALUES (?,?,?,?,'W','#000')",
      [id, name, type, limit],
    );
  }

  db.run(
    "INSERT INTO transactions (id, date, category_id, account_id, amount_cents, comment, pending) VALUES (1, 1750982400, 2, 1, 1000000, 'salary', 0)",
  );
  db.run(
    "INSERT INTO transactions (id, date, category_id, account_id, amount_cents, comment, pending) VALUES (2, 1751068800, 1, 1, 43704, 'groceries', 0)",
  );
  db.run(
    "INSERT INTO transactions (id, date, category_id, account_id, amount_cents, comment, pending) VALUES (3, 1751155200, 10, 1, 506678, 'gold', 0)",
  );

  db.run(
    "INSERT INTO assets (id, category, current_value_cents, currency, notes) VALUES (1,'Cash',449618,'USD','Auto-calculated from transactions')",
  );
  db.run(
    "INSERT INTO assets (id, category, current_value_cents, currency, commodity_type, quantity, unit, linked_transaction_ids, use_live_price) VALUES (2,'Commodities',532371,'USD','Gold',1.1376,'oz','[null,7]',1)",
  );
  db.run(
    "INSERT INTO assets (id, category, current_value_cents, currency, notes) VALUES (4,'Crypto',7000,'USD','BTC + ETH')",
  );
  db.run("INSERT INTO asset_history (asset_id, value_cents, recorded_at) VALUES (2, 500000, 1750982400)");
  db.run(
    "INSERT INTO quick_commands (command, category_name, amount_cents, comment) VALUES ('salary','Salary',140000,'monthly')",
  );
  db.run("INSERT INTO settings (user_name) VALUES ('Test User')");

  writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return { dir, file };
}

function open(file: string): Database {
  return new SQL.Database(readFileSync(file));
}

async function migrate(file: string, extra: Record<string, unknown> = {}) {
  return migrateDatabaseToPricedHoldings({
    dbPath: file,
    backupDir: path.join(path.dirname(file), "backups"),
    migrationSqlPath: path.join(MIGRATIONS_DIR, `${MIGRATION_TAG}.sql`),
    expectedCashBalanceCents: 449618,
    expectedCounts: { transactions: 3, categories: 14, assets: 3 },
    ...extra,
  });
}

// --------------------------------------------------------------------------

describe("0004 — journal integrity", () => {
  it("is registered at idx 4 with a matching .sql and snapshot", () => {
    const entry = journal.entries.find((e) => e.idx === 4);
    expect(entry).toBeDefined();
    expect(entry!.tag).toBe(MIGRATION_TAG);
    expect(existsSync(path.join(MIGRATIONS_DIR, `${MIGRATION_TAG}.sql`))).toBe(true);
    expect(existsSync(path.join(MIGRATIONS_DIR, "meta", "0004_snapshot.json"))).toBe(true);
  });

  it("chains its snapshot onto 0003's", () => {
    const previous = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, "meta", "0003_snapshot.json"), "utf-8"),
    );
    const snapshot = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, "meta", "0004_snapshot.json"), "utf-8"),
    );
    expect(snapshot.prevId).toBe(previous.id);
    expect(snapshot.tables.assets.columns.price_symbol).toMatchObject({
      name: "price_symbol",
      type: "text",
      notNull: false,
    });
    expect(snapshot.tables.assets.columns.priced_at).toMatchObject({
      name: "priced_at",
      type: "integer",
      notNull: false,
    });
  });
});

describe("0004 — schema after replaying from empty", () => {
  it("adds price_symbol and priced_at, both nullable", () => {
    const db = replay();
    try {
      const columns = columnInfo(db, "assets");
      expect(columns.get("price_symbol")).toEqual({ type: "text", notNull: false });
      expect(columns.get("priced_at")).toEqual({ type: "integer", notNull: false });
    } finally {
      db.close();
    }
  });

  it("keeps every pre-existing assets column, including commodity_type", () => {
    const before = columnInfo(replay(3), "assets");
    const after = columnInfo(replay(4), "assets");
    for (const [name, spec] of before) {
      expect(after.get(name), `assets.${name} changed`).toEqual(spec);
    }
  });

  it("keeps quantity a real — a coin count and a troy-ounce weight are not money", () => {
    const db = replay();
    try {
      expect(columnInfo(db, "assets").get("quantity")!.type).toBe("real");
      db.run(
        "INSERT INTO assets (category, current_value_cents, price_symbol, quantity, unit) VALUES ('Crypto', 408590, 'BTC', 0.0345, 'coins')",
      );
      expect(scalar(db, "SELECT quantity FROM assets")).toBe(0.0345);
    } finally {
      db.close();
    }
  });

  it("leaves no rebuild scaffolding and does not disturb asset_history's cascade", () => {
    const db = replay();
    try {
      const tables = rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) =>
        String(r[0]),
      );
      expect(tables.filter((t) => t.startsWith("__new"))).toEqual([]);
      const fks = rows(db, "PRAGMA foreign_key_list(asset_history)");
      expect(fks.map((r) => String(r[2]))).toContain("assets");
      expect(fks.map((r) => String(r[6]))).toContain("CASCADE");
    } finally {
      db.close();
    }
  });

  it("accepts both a metal and a coin holding, and rejects nothing that used to work", () => {
    const db = replay();
    try {
      db.run("PRAGMA foreign_keys = ON");
      // The legacy shape: commodity_type + oz, no symbol.
      db.run(
        "INSERT INTO assets (category, current_value_cents, commodity_type, quantity, unit, use_live_price) VALUES ('Commodities', 532371, 'Gold', 1.1376, 'oz', 1)",
      );
      // The generalized shape.
      db.run(
        "INSERT INTO assets (category, current_value_cents, price_symbol, quantity, unit, use_live_price, priced_at) VALUES ('Crypto', 408590, 'BTC', 0.0345, 'coins', 1, 1785000000)",
      );
      expect(rows(db, "SELECT category, price_symbol, quantity, unit FROM assets ORDER BY id")).toEqual([
        ["Commodities", null, 1.1376, "oz"],
        ["Crypto", "BTC", 0.0345, "coins"],
      ]);
    } finally {
      db.close();
    }
  });
});

describe("0004 — applied to a live-shaped database", () => {
  it("backfills the gold row onto XAU while keeping commodity_type", async () => {
    const { file } = makeFixture();
    const result = await migrate(file);

    expect(result.backfilled).toEqual([{ id: 2, commodityType: "Gold", priceSymbol: "XAU" }]);

    const db = open(file);
    try {
      expect(
        rows(
          db,
          "SELECT id, category, commodity_type, price_symbol, quantity, unit, current_value_cents, use_live_price FROM assets ORDER BY id",
        ),
      ).toEqual([
        [1, "Cash", null, null, null, null, 449618, 0],
        [2, "Commodities", "Gold", "XAU", 1.1376, "oz", 532371, 1],
        [4, "Crypto", null, null, null, null, 7000, 0],
      ]);
    } finally {
      db.close();
    }
  });

  it("preserves every row count, including asset_history", async () => {
    const { file } = makeFixture();
    const result = await migrate(file);

    expect(result.alreadyMigrated).toBe(false);
    expect(result.countsAfter).toEqual(result.countsBefore);
    expect(result.countsBefore).toMatchObject({
      transactions: 3,
      categories: 14,
      assets: 3,
      asset_history: 1,
    });
  });

  it("conserves the ledger total and the derived cash balance ($4,496.18)", async () => {
    const { file } = makeFixture();
    const result = await migrate(file);

    expect(result.cashBalanceBefore).toBe(449618);
    expect(result.cashBalanceAfter).toBe(449618);
    expect(result.sumAmountsAfter).toBe(result.sumAmountsBefore);
    expect(result.assetTotalAfter).toBe(result.assetTotalBefore);
    expect(result.assetTotalAfter).toBe(449618 + 532371 + 7000);
  });

  it("introduces no foreign-key violations", async () => {
    const { file } = makeFixture();
    const result = await migrate(file);
    expect(result.foreignKeyViolationsBefore).toEqual([]);
    expect(result.foreignKeyViolationsAfter).toEqual([]);
  });

  it("writes a timestamped backup BEFORE touching the database", async () => {
    const { file } = makeFixture();
    const original = readFileSync(file);
    const result = await migrate(file);

    expect(result.backupPath).toMatch(/backups[/\\]budget\..*\.pre-0004\.db$/);
    expect(readFileSync(result.backupPath!)).toEqual(original);
    expect(readdirSync(path.join(path.dirname(file), "backups"))).toHaveLength(1);
  });

  it("reports the hand-valued BTC + ETH row as still needing a quantity", async () => {
    const { file } = makeFixture();
    const result = await migrate(file);
    expect(result.unmigratableRows).toEqual([
      { id: 4, category: "Crypto", notes: "BTC + ETH", currentValueCents: 7000 },
    ]);
  });

  it("prints a before/after report naming the balance and the FK result", async () => {
    const { file } = makeFixture();
    const report = formatPricedHoldingsReport(await migrate(file));

    expect(report).toContain("$4,496.18");
    expect(report).toContain("PRAGMA foreign_key_check");
    expect(report).toMatch(/Gold\s*->\s*XAU/);
    expect(report).toMatch(/assets\s+3\s+3/);
  });

  it("refuses to run twice and writes nothing the second time", async () => {
    const { file } = makeFixture();
    await migrate(file);
    const after = readFileSync(file);

    const second = await migrate(file);
    expect(second.alreadyMigrated).toBe(true);
    expect(second.backupPath).toBeNull();
    expect(readFileSync(file)).toEqual(after);
    expect(readdirSync(path.join(path.dirname(file), "backups"))).toHaveLength(1);
    expect(formatPricedHoldingsReport(second)).toMatch(/already migrated/i);
  });

  it("changes nothing on a dry run", async () => {
    const { file } = makeFixture();
    const original = readFileSync(file);
    const result = await migrate(file, { dryRun: true });

    expect(result.alreadyMigrated).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(readFileSync(file)).toEqual(original);
    expect(existsSync(path.join(path.dirname(file), "backups"))).toBe(false);
  });
});

describe("0004 — verification bites, and every failure restores the backup", () => {
  it("restores when a row disappears", async () => {
    const { file } = makeFixture();
    const original = readFileSync(file);

    await expect(
      migrate(file, { corruptForTest: (db: Database) => db.run("DELETE FROM assets WHERE id = 4") }),
    ).rejects.toThrow(/assets row count changed/i);

    expect(readFileSync(file)).toEqual(original);
  });

  it("restores when an asset value is altered", async () => {
    const { file } = makeFixture();
    const original = readFileSync(file);

    await expect(
      migrate(file, {
        corruptForTest: (db: Database) =>
          db.run("UPDATE assets SET current_value_cents = 0 WHERE id = 2"),
      }),
    ).rejects.toThrow(/current_value_cents/i);

    expect(readFileSync(file)).toEqual(original);
  });

  it("restores when the backfill points a metal at the wrong symbol", async () => {
    const { file } = makeFixture();
    const original = readFileSync(file);

    await expect(
      migrate(file, {
        corruptForTest: (db: Database) => db.run("UPDATE assets SET price_symbol = 'BTC' WHERE id = 2"),
      }),
    ).rejects.toThrow(/price_symbol/i);

    expect(readFileSync(file)).toEqual(original);
  });

  it("restores when a quantity is rounded away", async () => {
    const { file } = makeFixture();
    const original = readFileSync(file);

    await expect(
      migrate(file, {
        corruptForTest: (db: Database) => db.run("UPDATE assets SET quantity = 1.14 WHERE id = 2"),
      }),
    ).rejects.toThrow(/quantity/i);

    expect(readFileSync(file)).toEqual(original);
  });

  it("restores when a transaction amount moves by a single cent", async () => {
    const { file } = makeFixture();
    const original = readFileSync(file);

    await expect(
      migrate(file, {
        corruptForTest: (db: Database) =>
          db.run("UPDATE transactions SET amount_cents = amount_cents + 1 WHERE id = 1"),
      }),
    ).rejects.toThrow(/transaction 1 changed/i);

    expect(readFileSync(file)).toEqual(original);
  });

  it("restores when the derived cash balance moves without the ledger changing", async () => {
    const { file } = makeFixture();
    const original = readFileSync(file);

    // Flipping Salary from Income to Expense leaves every transaction row
    // untouched but swings the derived balance by $20,000 — the balance
    // assertion is the only thing that can catch this.
    await expect(
      migrate(file, {
        corruptForTest: (db: Database) =>
          db.run("UPDATE categories SET type = 'Expense' WHERE id = 2"),
      }),
    ).rejects.toThrow(/derived cash balance changed/i);

    expect(readFileSync(file)).toEqual(original);
  });

  it("refuses a database whose figures do not match the expectation", async () => {
    const { file } = makeFixture();
    const original = readFileSync(file);

    await expect(migrate(file, { expectedCashBalanceCents: 1 })).rejects.toThrow(/Pre-flight/i);
    await expect(migrate(file, { expectedCounts: { assets: 99 } })).rejects.toThrow(/Pre-flight/i);

    expect(readFileSync(file)).toEqual(original);
    expect(existsSync(path.join(path.dirname(file), "backups"))).toBe(false);
  });

  it("refuses a database that has not had 0003 applied yet", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "budget-0004-old-"));
    dirs.push(dir);
    const file = path.join(dir, "budget.db");
    const db = replay(2);
    writeFileSync(file, Buffer.from(db.export()));
    db.close();

    await expect(
      migrateDatabaseToPricedHoldings({
        dbPath: file,
        backupDir: path.join(dir, "backups"),
        migrationSqlPath: path.join(MIGRATIONS_DIR, `${MIGRATION_TAG}.sql`),
      }),
    ).rejects.toThrow(/0003/);
  });
});
