
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";

import { deriveCashBalanceCents } from "@/lib/cash-balance";
import { CENTS_ONLY_COLUMNS } from "../migrate-to-cents";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "drizzle", "migrations");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta", "_journal.json");

type JournalEntry = { idx: number; tag: string };

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
let journal: { entries: JournalEntry[] };

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(PROJECT_ROOT, "node_modules/sql.js/dist", file),
  });
  journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8"));
});

function migrationSql(tag: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), "utf-8");
}

function execScript(db: Database, sql: string) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

/** Replay the journal up to and including `throughIdx`. */
function replay(throughIdx = Infinity): Database {
  const db = new SQL.Database();
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    if (entry.idx > throughIdx) break;
    execScript(db, migrationSql(entry.tag));
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
      { type: String(row[2]).toLowerCase(), notNull: Number(row[3]) === 1, dflt: row[4] },
    ]),
  );
}

function indexNames(db: Database, table: string): string[] {
  return rows(db, `PRAGMA index_list(${table})`).map((row) => String(row[1]));
}

function fkTargets(db: Database, table: string): Array<{ to: string; from: string; onDelete: string }> {
  return rows(db, `PRAGMA foreign_key_list(${table})`).map((row) => ({
    to: String(row[2]),
    from: String(row[3]),
    onDelete: String(row[6]),
  }));
}

function foreignKeyCheck(db: Database): unknown[][] {
  db.run("PRAGMA foreign_keys = ON");
  return rows(db, "PRAGMA foreign_key_check");
}

// ---------------------------------------------------------------------------
// A database shaped like the live one, on the PRE-0003 schema.
// ---------------------------------------------------------------------------

/** Category ids, names and monthly limits exactly as they are in data/budget.db. */
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

/** 1750982400 = 2025-06-27T00:00:00Z, the earliest transaction in the live file. */
const EARLIEST_DATE = 1750982400;

function seedLiveShape(db: Database) {
  // FK enforcement off: we are deliberately reproducing the referential damage
  // that already exists in the live file (two rows with category_id = 0), which
  // is precisely what 0003 has to repair. 0002 leaves the pragma ON.
  db.run("PRAGMA foreign_keys = OFF");

  for (const [id, name, type, limit] of LIVE_CATEGORIES) {
    db.run("INSERT INTO categories (id, name, type, monthly_limit_cents, icon, color) VALUES (?,?,?,?,'W','#000')", [
      id,
      name,
      type,
      limit,
    ]);
  }

  // Two income rows, two expense rows, plus the two orphans (category_id = 0).
  db.run("INSERT INTO transactions (id, date, category_id, amount_cents, comment, pending) VALUES (1,?,2,1400000,'salary',0)", [EARLIEST_DATE]);
  db.run("INSERT INTO transactions (id, date, category_id, amount_cents, comment, pending) VALUES (2,?,1,4370,'food',0)", [EARLIEST_DATE + 86400]);
  db.run("INSERT INTO transactions (id, date, category_id, amount_cents, comment, pending) VALUES (17,?,0,2400,'Bank cheque tax (2 * 1%)',0)", [1769731200]);
  db.run("INSERT INTO transactions (id, date, category_id, amount_cents, comment, pending) VALUES (40,?,0,500,'registrar certificate of enrolment spring 2026',0)", [1769817600]);
  db.run("INSERT INTO transactions (id, date, category_id, amount_cents, comment, pending) VALUES (76,?,10,532371,'gold',0)", [1776988800]);

  db.run("INSERT INTO assets (id, category, current_value_cents, currency, notes) VALUES (1,'Cash',449618,'USD','Auto-calculated')");
  db.run("INSERT INTO assets (id, category, current_value_cents, currency) VALUES (2,'Commodities',532371,'USD')");
  db.run("INSERT INTO asset_history (asset_id, value_cents, recorded_at) VALUES (2, 500000, 1750982400)");
}

// ---------------------------------------------------------------------------

describe("0003 — journal integrity", () => {
  it("is registered at idx 3 with a matching .sql and snapshot", () => {
    const entry = journal.entries.find((e) => e.idx === 3);
    expect(entry?.tag).toBe("0003_accounts_and_budget_periods");
    expect(() => migrationSql(entry!.tag)).not.toThrow();
    const snapshot = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, "meta", "0003_snapshot.json"), "utf-8"),
    );
    const previous = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, "meta", "0002_snapshot.json"), "utf-8"),
    );
    expect(snapshot.prevId).toBe(previous.id);
  });

  it("brackets its table rebuild with PRAGMA foreign_keys OFF ... ON", () => {
    const sql = migrationSql("0003_accounts_and_budget_periods");
    expect(sql.indexOf("PRAGMA foreign_keys=OFF")).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf("PRAGMA foreign_keys=ON")).toBeGreaterThan(sql.indexOf("DROP TABLE `transactions`"));
  });
});

describe("0003 — schema after replaying from empty", () => {
  it("creates every new table and leaves no rebuild scaffolding", () => {
    const db = replay();
    try {
      const tables = rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r[0]));
      for (const table of ["accounts", "budgets", "recurring_transactions", "net_worth_snapshots"]) {
        expect(tables).toContain(table);
      }
      expect(tables.filter((t) => t.startsWith("__new"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("gives accounts the documented columns, with money as integer cents", () => {
    const db = replay();
    try {
      const cols = columnInfo(db, "accounts");
      expect(cols.get("kind")).toMatchObject({ type: "text", notNull: true });
      expect(cols.get("type")).toMatchObject({ type: "text", notNull: true });
      expect(cols.get("opening_balance_cents")).toMatchObject({ type: "integer", notNull: true });
      // PRAGMA table_info reports defaults as SQL text.
      expect(String(cols.get("opening_balance_cents")!.dflt)).toBe("0");
      expect(cols.get("currency")).toMatchObject({ type: "text", notNull: true });
      expect(cols.get("archived")).toMatchObject({ type: "integer", notNull: true });
      expect(indexNames(db, "accounts")).toContain("accounts_name_unique");
    } finally {
      db.close();
    }
  });

  it("seeds exactly one default account", () => {
    const db = replay();
    try {
      expect(rows(db, "SELECT id, name, kind, type, opening_balance_cents FROM accounts")).toEqual([
        [1, "Main", "asset", "Checking", 0],
      ]);
    } finally {
      db.close();
    }
  });

  it("rejects an account whose kind is neither asset nor liability", () => {
    const db = replay();
    try {
      expect(() =>
        db.run("INSERT INTO accounts (name, kind, type) VALUES ('Bad', 'equity', 'Other')"),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it("accepts a liability account", () => {
    const db = replay();
    try {
      db.run(
        "INSERT INTO accounts (name, kind, type, opening_balance_cents) VALUES ('Amex', 'liability', 'CreditCard', 50000)",
      );
      expect(scalar(db, "SELECT opening_balance_cents FROM accounts WHERE name='Amex'")).toBe(50000);
    } finally {
      db.close();
    }
  });

  it("makes transactions.category_id NULLABLE and adds the account columns", () => {
    const db = replay();
    try {
      const cols = columnInfo(db, "transactions");
      expect(cols.get("category_id")!.notNull).toBe(false);
      expect(cols.get("account_id")).toMatchObject({ type: "integer", notNull: false });
      expect(cols.get("transfer_account_id")).toMatchObject({ type: "integer", notNull: false });
      expect(cols.get("recurring_id")).toMatchObject({ type: "integer", notNull: false });
      expect(cols.get("recurring_occurrence")).toMatchObject({ type: "text", notNull: false });
      // amount_cents stays NOT NULL integer.
      expect(cols.get("amount_cents")).toMatchObject({ type: "integer", notNull: true });
    } finally {
      db.close();
    }
  });

  it("wires the transaction foreign keys", () => {
    const db = replay();
    try {
      const fks = fkTargets(db, "transactions");
      expect(fks.map((f) => `${f.from}->${f.to}`).sort()).toEqual([
        "account_id->accounts",
        "category_id->categories",
        "current_event_id->ledger_events",
        "instrument_id->instruments",
        "recurring_id->recurring_transactions",
        "transfer_account_id->accounts",
      ]);
      expect(fks.find((f) => f.from === "recurring_id")!.onDelete).toBe("SET NULL");
    } finally {
      db.close();
    }
  });

  it("accepts a transfer row with no category", () => {
    const db = replay();
    try {
      db.run("PRAGMA foreign_keys = ON");
      db.run("INSERT INTO accounts (id, name, kind, type) VALUES (2, 'Savings', 'asset', 'Savings')");
      db.run(
        "INSERT INTO transactions (date, category_id, account_id, transfer_account_id, amount_cents) VALUES (0, NULL, 1, 2, 25000)",
      );
      expect(rows(db, "SELECT account_id, transfer_account_id, category_id FROM transactions")).toEqual([
        [1, 2, null],
      ]);
    } finally {
      db.close();
    }
  });

  it("refuses a transfer to the same account", () => {
    const db = replay();
    try {
      expect(() =>
        db.run(
          "INSERT INTO transactions (date, account_id, transfer_account_id, amount_cents) VALUES (0, 1, 1, 100)",
        ),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it("makes double-posting a recurring occurrence structurally impossible", () => {
    const db = replay();
    try {
      db.run("PRAGMA foreign_keys = ON");
      db.run(
        "INSERT INTO recurring_transactions (id, name, account_id, amount_cents, frequency, start_date) VALUES (1, 'Rent', 1, 120000, 'monthly', '2026-01-01')",
      );
      db.run(
        "INSERT INTO transactions (date, account_id, amount_cents, recurring_id, recurring_occurrence) VALUES (0, 1, 120000, 1, '2026-01-01')",
      );
      expect(() =>
        db.run(
          "INSERT INTO transactions (date, account_id, amount_cents, recurring_id, recurring_occurrence) VALUES (0, 1, 120000, 1, '2026-01-01')",
        ),
      ).toThrow(/UNIQUE/i);
      // A different occurrence of the same template is fine.
      db.run(
        "INSERT INTO transactions (date, account_id, amount_cents, recurring_id, recurring_occurrence) VALUES (0, 1, 120000, 1, '2026-02-01')",
      );
      expect(scalar(db, "SELECT COUNT(*) FROM transactions")).toBe(2);
    } finally {
      db.close();
    }
  });

  it("leaves hand-entered rows alone: many NULL recurring_id rows coexist", () => {
    const db = replay();
    try {
      db.run("PRAGMA foreign_keys = ON");
      db.run("INSERT INTO categories (id, name, type, icon, color) VALUES (1,'Food','Expense','W','#000')");
      for (let i = 0; i < 5; i++) {
        db.run("INSERT INTO transactions (date, category_id, account_id, amount_cents) VALUES (0, 1, 1, 100)");
      }
      expect(scalar(db, "SELECT COUNT(*) FROM transactions")).toBe(5);
    } finally {
      db.close();
    }
  });

  it("gives budgets a period, a window and a rollover flag", () => {
    const db = replay();
    try {
      const cols = columnInfo(db, "budgets");
      expect(cols.get("period")).toMatchObject({ type: "text", notNull: true });
      expect(cols.get("limit_cents")).toMatchObject({ type: "integer", notNull: true });
      expect(cols.get("effective_from")).toMatchObject({ type: "text", notNull: true });
      expect(cols.get("effective_to")).toMatchObject({ type: "text", notNull: false });
      expect(cols.get("rollover")).toMatchObject({ type: "integer", notNull: true });
      expect(fkTargets(db, "budgets")[0]).toMatchObject({ to: "categories", onDelete: "CASCADE" });
    } finally {
      db.close();
    }
  });

  it("rejects an unknown budget period and an inverted window", () => {
    const db = replay();
    try {
      db.run("INSERT INTO categories (id, name, type, icon, color) VALUES (1,'Food','Expense','W','#000')");
      expect(() =>
        db.run(
          "INSERT INTO budgets (category_id, period, limit_cents, effective_from) VALUES (1,'fortnightly',100,'2026-01-01')",
        ),
      ).toThrow(/CHECK/i);
      expect(() =>
        db.run(
          "INSERT INTO budgets (category_id, period, limit_cents, effective_from, effective_to) VALUES (1,'monthly',100,'2026-03-01','2026-01-01')",
        ),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it("lets an INCOME category have a budget target", () => {
    const db = replay();
    try {
      db.run("INSERT INTO categories (id, name, type, icon, color) VALUES (1,'Salary','Income','W','#000')");
      db.run(
        "INSERT INTO budgets (category_id, period, limit_cents, effective_from, rollover) VALUES (1,'monthly',400000,'2026-01-01',0)",
      );
      expect(scalar(db, "SELECT limit_cents FROM budgets")).toBe(400000);
    } finally {
      db.close();
    }
  });

  it("constrains the recurrence frequency and interval", () => {
    const db = replay();
    try {
      expect(() =>
        db.run(
          "INSERT INTO recurring_transactions (name, amount_cents, frequency, start_date) VALUES ('x',1,'hourly','2026-01-01')",
        ),
      ).toThrow(/CHECK/i);
      expect(() =>
        db.run(
          "INSERT INTO recurring_transactions (name, amount_cents, frequency, interval, start_date) VALUES ('x',1,'monthly',0,'2026-01-01')",
        ),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it("stores every money column added by 0003 as integer cents", () => {
    const db = replay();
    try {
      // The inventory lives in migrate-to-cents.ts alongside MONEY_COLUMNS, so
      // "which columns hold money?" has one answer in one place.
      expect(CENTS_ONLY_COLUMNS.length).toBeGreaterThan(0);
      for (const spec of CENTS_ONLY_COLUMNS) {
        const column = columnInfo(db, spec.table).get(spec.column);
        expect(column, `${spec.table}.${spec.column} missing`).toBeDefined();
        expect(column!.type).toBe("integer");
        expect(column!.notNull).toBe(spec.notNull);
      }
    } finally {
      db.close();
    }
  });

  it("makes one net-worth snapshot per day, enforced by the database", () => {
    const db = replay();
    try {
      db.run(
        "INSERT INTO net_worth_snapshots (date, total_assets_cents, total_liabilities_cents, net_worth_cents) VALUES ('2026-07-28', 1000, 400, 600)",
      );
      expect(() =>
        db.run(
          "INSERT INTO net_worth_snapshots (date, total_assets_cents, total_liabilities_cents, net_worth_cents) VALUES ('2026-07-28', 1, 1, 0)",
        ),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });
});

describe("0003 — applied to a live-shaped database", () => {
  function migrated(): Database {
    const db = replay(2);
    seedLiveShape(db);
    execScript(db, migrationSql("0003_accounts_and_budget_periods"));
    return db;
  }

  it("preserves every row", () => {
    const before = replay(2);
    seedLiveShape(before);
    const counts = {
      transactions: scalar(before, "SELECT COUNT(*) FROM transactions"),
      categories: scalar(before, "SELECT COUNT(*) FROM categories"),
      assets: scalar(before, "SELECT COUNT(*) FROM assets"),
      assetHistory: scalar(before, "SELECT COUNT(*) FROM asset_history"),
    };
    before.close();

    const db = migrated();
    try {
      expect(scalar(db, "SELECT COUNT(*) FROM transactions")).toBe(counts.transactions);
      expect(scalar(db, "SELECT COUNT(*) FROM categories")).toBe(counts.categories);
      expect(scalar(db, "SELECT COUNT(*) FROM assets")).toBe(counts.assets);
      // The asset_history CASCADE must not have fired during the rebuild.
      expect(scalar(db, "SELECT COUNT(*) FROM asset_history")).toBe(counts.assetHistory);
      expect(counts.assetHistory).toBe(1);
    } finally {
      db.close();
    }
  });

  it("repairs the two category_id = 0 orphans to NULL, amounts untouched", () => {
    const db = migrated();
    try {
      expect(rows(db, "SELECT id, category_id, amount_cents, comment FROM transactions WHERE id IN (17, 40) ORDER BY id")).toEqual([
        [17, null, 2400, "Bank cheque tax (2 * 1%)"],
        [40, null, 500, "registrar certificate of enrolment spring 2026"],
      ]);
    } finally {
      db.close();
    }
  });

  it("clears the pre-existing foreign-key violations and introduces none", () => {
    const before = replay(2);
    seedLiveShape(before);
    const violationsBefore = foreignKeyCheck(before);
    before.close();
    expect(violationsBefore).toHaveLength(2); // the two orphans

    const db = migrated();
    try {
      expect(foreignKeyCheck(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps every other transaction on its original category", () => {
    const db = migrated();
    try {
      expect(rows(db, "SELECT id, category_id FROM transactions WHERE id NOT IN (17,40) ORDER BY id")).toEqual([
        [1, 2],
        [2, 1],
        [76, 10],
      ]);
    } finally {
      db.close();
    }
  });

  it("points every existing transaction at the seeded default account", () => {
    const db = migrated();
    try {
      expect(scalar(db, "SELECT COUNT(*) FROM transactions WHERE account_id = 1")).toBe(
        scalar(db, "SELECT COUNT(*) FROM transactions"),
      );
      expect(scalar(db, "SELECT COUNT(*) FROM transactions WHERE transfer_account_id IS NOT NULL")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("does not change the derived cash balance", () => {
    const before = replay(2);
    seedLiveShape(before);
    const readLedger = (db: Database) =>
      rows(db, "SELECT category_id, amount_cents, pending FROM transactions").map((r) => ({
        categoryId: r[0] === null ? null : Number(r[0]),
        amountCents: Number(r[1]),
        pending: Number(r[2]) === 1,
      }));
    const readCategories = (db: Database) =>
      rows(db, "SELECT id, type FROM categories").map((r) => ({ id: Number(r[0]), type: String(r[1]) }));

    const cashBefore = deriveCashBalanceCents(readLedger(before), readCategories(before));
    before.close();

    const db = migrated();
    try {
      const cashAfter = deriveCashBalanceCents(readLedger(db), readCategories(db));
      expect(cashAfter).toBe(cashBefore);
      // 1400000 income - 4370 food - 532371 commodities; the two orphans contribute nothing.
      expect(cashAfter).toBe(1400000 - 4370 - 532371);
    } finally {
      db.close();
    }
  });

  it("copies the 8 non-null monthly limits into budgets, preserving the amounts", () => {
    const db = migrated();
    try {
      const budgets = rows(db, "SELECT category_id, period, limit_cents, effective_to, rollover FROM budgets ORDER BY category_id");
      expect(budgets).toEqual([
        [1, "monthly", 5000, null, 0],
        [3, "monthly", 20000, null, 0],
        [4, "monthly", 10000, null, 0],
        [5, "monthly", 10000, null, 0],
        [6, "monthly", 3000, null, 0],
        [7, "monthly", 12000, null, 0],
        [9, "monthly", 2000, null, 0],
        [13, "monthly", 5000, null, 0],
      ]);
    } finally {
      db.close();
    }
  });

  it("dates the migrated budgets from the month of the earliest transaction", () => {
    const db = migrated();
    try {
      // 1750982400 = 2025-06-27
      expect(rows(db, "SELECT DISTINCT effective_from FROM budgets")).toEqual([["2025-06-01"]]);
    } finally {
      db.close();
    }
  });

  it("leaves categories.monthly_limit_cents in place so the legacy path still works", () => {
    const db = migrated();
    try {
      expect(scalar(db, "SELECT COUNT(*) FROM categories WHERE monthly_limit_cents IS NOT NULL")).toBe(8);
      expect(scalar(db, "SELECT monthly_limit_cents FROM categories WHERE id = 1")).toBe(5000);
    } finally {
      db.close();
    }
  });

  it("keeps the autoincrement high-water mark so a new transaction cannot reuse an id", () => {
    const db = migrated();
    try {
      db.run("PRAGMA foreign_keys = ON");
      db.run("INSERT INTO transactions (date, category_id, account_id, amount_cents) VALUES (0, 1, 1, 999)");
      expect(Number(scalar(db, "SELECT MAX(id) FROM transactions"))).toBeGreaterThan(76);
    } finally {
      db.close();
    }
  });

  it("inserts no accounts beyond the default and no snapshots or templates", () => {
    const db = migrated();
    try {
      expect(scalar(db, "SELECT COUNT(*) FROM accounts")).toBe(1);
      expect(scalar(db, "SELECT COUNT(*) FROM net_worth_snapshots")).toBe(0);
      expect(scalar(db, "SELECT COUNT(*) FROM recurring_transactions")).toBe(0);
    } finally {
      db.close();
    }
  });
});
