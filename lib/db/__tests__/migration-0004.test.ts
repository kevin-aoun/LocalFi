
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";


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

function migrate(file: string): Database {
  const db = open(file);
  execScript(db, readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION_TAG}.sql`), "utf-8"));
  return db;
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
  function counts(db: Database) {
    return Object.fromEntries(
      ["transactions", "categories", "assets", "asset_history"].map((table) => [
        table,
        Number(scalar(db, `SELECT COUNT(*) FROM ${table}`)),
      ]),
    );
  }

  it("backfills the gold row onto XAU while keeping commodity_type", () => {
    const db = migrate(makeFixture().file);
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

  it("preserves every row count, money total and foreign key", () => {
    const { file } = makeFixture();
    const before = open(file);
    const db = migrate(file);
    try {
      expect(counts(db)).toEqual(counts(before));
      expect(counts(db)).toEqual({ transactions: 3, categories: 14, assets: 3, asset_history: 1 });
      expect(scalar(db, "SELECT SUM(amount_cents) FROM transactions")).toBe(
        scalar(before, "SELECT SUM(amount_cents) FROM transactions"),
      );
      expect(scalar(db, "SELECT SUM(current_value_cents) FROM assets")).toBe(449618 + 532371 + 7000);
      expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      before.close();
      db.close();
    }
  });
});
