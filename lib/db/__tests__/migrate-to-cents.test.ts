
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";

import {
  MONEY_COLUMNS,
  migrateDatabaseToCents,
  toCents,
} from "../migrate-to-cents";
import { sumCents } from "@/lib/money";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "drizzle", "migrations");

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeEach(async () => {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(PROJECT_ROOT, "node_modules/sql.js/dist", file),
  });
});

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "budget-cents-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function execScript(db: Database, sql: string) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

function buildFixture(
  file: string,
  rows: {
    categories?: { id: number; name: string; type: string; monthlyLimit: number | null }[];
    transactions?: { id: number; categoryId: number; amount: number; pending?: boolean }[];
    assets?: { id: number; category: string; currentValue: number; currency?: string }[];
    assetHistory?: { id: number; assetId: number; value: number }[];
    quickCommands?: { id: number; command: string; amount: number }[];
  },
) {
  const db = new SQL.Database();
  for (const tag of ["0000_acoustic_natasha_romanoff", "0001_natural_the_santerians"]) {
    execScript(db, readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), "utf-8"));
  }

  for (const c of rows.categories ?? []) {
    db.run(
      "INSERT INTO categories (id, name, type, monthly_limit, icon, color) VALUES (?, ?, ?, ?, 'Wallet', '#000000')",
      [c.id, c.name, c.type, c.monthlyLimit],
    );
  }
  for (const t of rows.transactions ?? []) {
    db.run(
      "INSERT INTO transactions (id, date, category_id, amount, comment, pending) VALUES (?, 0, ?, ?, 'x', ?)",
      [t.id, t.categoryId, t.amount, t.pending ? 1 : 0],
    );
  }
  for (const a of rows.assets ?? []) {
    db.run(
      "INSERT INTO assets (id, category, current_value, currency) VALUES (?, ?, ?, ?)",
      [a.id, a.category, a.currentValue, a.currency ?? "USD"],
    );
  }
  for (const h of rows.assetHistory ?? []) {
    db.run("INSERT INTO asset_history (id, asset_id, value) VALUES (?, ?, ?)", [
      h.id,
      h.assetId,
      h.value,
    ]);
  }
  for (const q of rows.quickCommands ?? []) {
    db.run(
      "INSERT INTO quick_commands (id, command, category_name, amount, comment) VALUES (?, ?, 'Salary', ?, 'c')",
      [q.id, q.command, q.amount],
    );
  }

  writeFileSync(file, Buffer.from(db.export()));
  db.close();
}

function openFile(file: string): Database {
  return new SQL.Database(readFileSync(file));
}

function selectRows(db: Database, sql: string): unknown[][] {
  const result = db.exec(sql);
  return result[0]?.values ?? [];
}

/** The fixture the task description calls for: awkward decimals, NULL, negatives. */
const AWKWARD_FIXTURE = {
  categories: [
    { id: 1, name: "Salary", type: "Income", monthlyLimit: null },
    { id: 2, name: "Food", type: "Expense", monthlyLimit: 50 },
    { id: 3, name: "Odd", type: "Expense", monthlyLimit: 0.1 },
    { id: 4, name: "Big", type: "Expense", monthlyLimit: 1234.56 },
    { id: 5, name: "Savings", type: "Investment", monthlyLimit: 0.7 },
  ],
  transactions: [
    { id: 1, categoryId: 1, amount: 5000 },
    { id: 2, categoryId: 2, amount: 0.1 },
    { id: 3, categoryId: 2, amount: 0.7 },
    { id: 4, categoryId: 2, amount: 120.5 },
    { id: 5, categoryId: 4, amount: 1234.56 },
    { id: 6, categoryId: 2, amount: -45.0 },
    { id: 7, categoryId: 2, amount: 0 },
    { id: 8, categoryId: 5, amount: 0.7, pending: true },
  ],
  assets: [
    { id: 1, category: "Cash", currentValue: 4496.18 },
    { id: 2, category: "Commodities", currentValue: 5323.7086272 },
    { id: 3, category: "Crypto", currentValue: -0.01, currency: "EUR" },
  ],
  assetHistory: [
    { id: 1, assetId: 1, value: 0.7 },
    { id: 2, assetId: 1, value: 0.1 },
    { id: 3, assetId: 2, value: 5000 },
  ],
  quickCommands: [
    { id: 1, command: "salary", amount: 1400 },
    { id: 2, command: "tiny", amount: 0.05 },
  ],
};

describe("toCents", () => {
  it("converts human-entered two-decimal floats exactly", () => {
    expect(toCents(0.1, "t")).toBe(10);
    expect(toCents(0.7, "t")).toBe(70);
    expect(toCents(120.5, "t")).toBe(12050);
    expect(toCents(1234.56, "t")).toBe(123456);
    expect(toCents(5000, "t")).toBe(500000);
    expect(toCents(-45.0, "t")).toBe(-4500);
    expect(toCents(0, "t")).toBe(0);
    expect(toCents(0.05, "t")).toBe(5);
  });

  it("passes NULL through untouched", () => {
    expect(toCents(null, "t")).toBeNull();
  });

  it("rounds a computed sub-cent value to the nearest cent", () => {
    // A live-priced commodity value: not human-entered, so it has sub-cent digits.
    expect(toCents(5323.7086272, "t")).toBe(532371);
  });

  it("throws rather than silently losing precision on unsafe input", () => {
    expect(() => toCents(Number.MAX_SAFE_INTEGER, "amount")).toThrow(/amount/);
    expect(() => toCents(Number.NaN, "amount")).toThrow(/amount/);
    expect(() => toCents(Number.POSITIVE_INFINITY, "amount")).toThrow(/amount/);
  });
});

describe("migrateDatabaseToCents", () => {
  it("converts every money column exactly and conserves totals and row counts", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    buildFixture(file, AWKWARD_FIXTURE);

    const result = await migrateDatabaseToCents({
      dbPath: file,
      backupDir: path.join(dir, "backups"),
    });

    expect(result.alreadyMigrated).toBe(false);

    const db = openFile(file);
    try {
      expect(selectRows(db, "SELECT id, amount_cents FROM transactions ORDER BY id")).toEqual([
        [1, 500000],
        [2, 10],
        [3, 70],
        [4, 12050],
        [5, 123456],
        [6, -4500],
        [7, 0],
        [8, 70],
      ]);
      expect(
        selectRows(db, "SELECT id, monthly_limit_cents FROM categories ORDER BY id"),
      ).toEqual([
        [1, null],
        [2, 5000],
        [3, 10],
        [4, 123456],
        [5, 70],
      ]);
      expect(
        selectRows(db, "SELECT id, current_value_cents FROM assets ORDER BY id"),
      ).toEqual([
        [1, 449618],
        [2, 532371],
        [3, -1],
      ]);
      expect(selectRows(db, "SELECT id, value_cents FROM asset_history ORDER BY id")).toEqual([
        [1, 70],
        [2, 10],
        [3, 500000],
      ]);
      expect(selectRows(db, "SELECT id, amount_cents FROM quick_commands ORDER BY id")).toEqual([
        [1, 140000],
        [2, 5],
      ]);

      // Every converted value must be stored as an INTEGER, not a float.
      for (const spec of MONEY_COLUMNS) {
        const types = selectRows(
          db,
          `SELECT DISTINCT typeof(${spec.newColumn}) FROM ${spec.table}`,
        ).map((row) => row[0]);
        for (const t of types) expect(["integer", "null"]).toContain(t);
      }
    } finally {
      db.close();
    }

    // Row counts unchanged, and sum(round(old*100)) === sum(new_cents) per column.
    for (const column of result.report.columns) {
      expect(column.rowCountAfter).toBe(column.rowCountBefore);
      expect(column.sumExpectedCents).toBe(column.sumActualCents);
    }
  });

  it("preserves NULL monthly_limit as NULL rather than zero", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    buildFixture(file, {
      categories: [
        { id: 1, name: "NoLimit", type: "Expense", monthlyLimit: null },
        { id: 2, name: "Zero", type: "Expense", monthlyLimit: 0 },
      ],
    });

    await migrateDatabaseToCents({ dbPath: file, backupDir: path.join(dir, "backups") });

    const db = openFile(file);
    try {
      expect(
        selectRows(db, "SELECT id, monthly_limit_cents, typeof(monthly_limit_cents) FROM categories ORDER BY id"),
      ).toEqual([
        [1, null, "null"],
        [2, 0, "integer"],
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps assets.quantity as a real, because it is a weight and not money", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    buildFixture(file, { assets: [{ id: 1, category: "Commodities", currentValue: 100 }] });

    const before = openFile(file);
    before.run("UPDATE assets SET quantity = 1.1376, unit = 'oz' WHERE id = 1");
    writeFileSync(file, Buffer.from(before.export()));
    before.close();

    await migrateDatabaseToCents({ dbPath: file, backupDir: path.join(dir, "backups") });

    const db = openFile(file);
    try {
      expect(selectRows(db, "SELECT quantity, typeof(quantity) FROM assets")).toEqual([
        [1.1376, "real"],
      ]);
    } finally {
      db.close();
    }
  });

  it("writes a timestamped backup before touching the database", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    const backupDir = path.join(dir, "backups");
    buildFixture(file, AWKWARD_FIXTURE);
    const originalBytes = readFileSync(file);

    const result = await migrateDatabaseToCents({ dbPath: file, backupDir });

    expect(existsSync(result.backupPath!)).toBe(true);
    expect(path.dirname(result.backupPath!)).toBe(backupDir);
    expect(path.basename(result.backupPath!)).toMatch(/^budget\..+\.db$/);
    // The backup is a byte-for-byte copy of the PRE-migration file.
    expect(readFileSync(result.backupPath!).equals(originalBytes)).toBe(true);
    // ...and the live file really did change.
    expect(readFileSync(file).equals(originalBytes)).toBe(false);
  });

  it("leaves other backups in the directory alone", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    const backupDir = path.join(dir, "backups");
    buildFixture(file, AWKWARD_FIXTURE);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, "budget.pre-refactor.db"), "sentinel");

    await migrateDatabaseToCents({ dbPath: file, backupDir });

    expect(readFileSync(path.join(backupDir, "budget.pre-refactor.db"), "utf-8")).toBe("sentinel");
    expect(readdirSync(backupDir).length).toBe(2);
  });

  it("refuses to run twice and does not touch the data on the second run", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    const backupDir = path.join(dir, "backups");
    buildFixture(file, AWKWARD_FIXTURE);

    await migrateDatabaseToCents({ dbPath: file, backupDir });
    const afterFirst = readFileSync(file);

    const second = await migrateDatabaseToCents({ dbPath: file, backupDir });

    expect(second.alreadyMigrated).toBe(true);
    expect(second.backupPath).toBeNull();
    expect(readFileSync(file).equals(afterFirst)).toBe(true);
    expect(readdirSync(backupDir).length).toBe(1);
  });

  it("reports a clean PRAGMA foreign_key_check and keeps referencing rows", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    buildFixture(file, AWKWARD_FIXTURE);

    const result = await migrateDatabaseToCents({
      dbPath: file,
      backupDir: path.join(dir, "backups"),
    });

    expect(result.foreignKeyViolationsBefore).toEqual([]);
    expect(result.foreignKeyViolations).toEqual([]);

    const db = openFile(file);
    try {
      // asset_history is ON DELETE CASCADE from assets: a careless rebuild of
      // `assets` would have cascade-deleted these rows.
      expect(selectRows(db, "SELECT COUNT(*) FROM asset_history")[0][0]).toBe(3);
      expect(selectRows(db, "SELECT COUNT(*) FROM transactions")[0][0]).toBe(8);
      expect(selectRows(db, "PRAGMA foreign_key_check").length).toBe(0);
    } finally {
      db.close();
    }
  });

  it("carries pre-existing orphan rows through untouched instead of failing", async () => {
    // The real database has two transactions with category_id = 0, orphaned by
    // a category deletion long before this refactor. The conversion must not
    // fail on them, must not delete them, and must not invent a category.
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    buildFixture(file, {
      categories: [{ id: 1, name: "Food", type: "Expense", monthlyLimit: 50 }],
      transactions: [
        { id: 1, categoryId: 1, amount: 10.9 },
        { id: 17, categoryId: 0, amount: 24 },
        { id: 40, categoryId: 0, amount: 5 },
      ],
    });

    const result = await migrateDatabaseToCents({
      dbPath: file,
      backupDir: path.join(dir, "backups"),
    });

    expect(result.foreignKeyViolationsBefore.length).toBe(2);
    // Same violations after: none introduced, none silently repaired.
    expect(result.foreignKeyViolations.length).toBe(2);

    const db = openFile(file);
    try {
      expect(selectRows(db, "SELECT id, category_id, amount_cents FROM transactions ORDER BY id")).toEqual([
        [1, 1, 1090],
        [17, 0, 2400],
        [40, 0, 500],
      ]);
    } finally {
      db.close();
    }
  });

  it("fails and restores if the rebuild would introduce a NEW orphan", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    buildFixture(file, AWKWARD_FIXTURE);
    const originalBytes = readFileSync(file);

    await expect(
      migrateDatabaseToCents({
        dbPath: file,
        backupDir: path.join(dir, "backups"),
        // Sneak the orphan past live enforcement so the post-rebuild
        // foreign_key_check is what has to catch it.
        corruptForTest: (db) => {
          db.run("PRAGMA foreign_keys = OFF");
          db.run("UPDATE transactions SET category_id = 4242 WHERE id = 1");
        },
      }),
    ).rejects.toThrow(/NEW violation/);

    expect(readFileSync(file).equals(originalBytes)).toBe(true);
  });

  it("fails and restores if live FK enforcement rejects a change outright", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    buildFixture(file, AWKWARD_FIXTURE);
    const originalBytes = readFileSync(file);

    await expect(
      migrateDatabaseToCents({
        dbPath: file,
        backupDir: path.join(dir, "backups"),
        corruptForTest: (db) =>
          db.run("UPDATE transactions SET category_id = 4242 WHERE id = 1"),
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    expect(readFileSync(file).equals(originalBytes)).toBe(true);
  });

  it("restores the backup and throws if conservation cannot be verified", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    const backupDir = path.join(dir, "backups");
    buildFixture(file, AWKWARD_FIXTURE);
    const originalBytes = readFileSync(file);

    await expect(
      migrateDatabaseToCents({
        dbPath: file,
        backupDir,
        // Simulate a conversion bug: drop a cent from one row after the copy.
        corruptForTest: (db) => db.run("UPDATE transactions SET amount_cents = amount_cents - 1 WHERE id = 2"),
      }),
    ).rejects.toThrow(/conserv|mismatch/i);

    // The user's data is intact, byte for byte.
    expect(readFileSync(file).equals(originalBytes)).toBe(true);
  });

  it("preserves ids, comments, dates, pending flags and currency", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    buildFixture(file, AWKWARD_FIXTURE);

    await migrateDatabaseToCents({ dbPath: file, backupDir: path.join(dir, "backups") });

    const db = openFile(file);
    try {
      expect(selectRows(db, "SELECT id, comment, pending FROM transactions ORDER BY id")).toEqual([
        [1, "x", 0],
        [2, "x", 0],
        [3, "x", 0],
        [4, "x", 0],
        [5, "x", 0],
        [6, "x", 0],
        [7, "x", 0],
        [8, "x", 1],
      ]);
      expect(selectRows(db, "SELECT id, currency FROM assets ORDER BY id")).toEqual([
        [1, "USD"],
        [2, "USD"],
        [3, "EUR"],
      ]);
      expect(selectRows(db, "SELECT id, name FROM categories ORDER BY id").length).toBe(5);
    } finally {
      db.close();
    }
  });

  it("keeps the unique index on categories.name after the table rebuild", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    buildFixture(file, AWKWARD_FIXTURE);

    await migrateDatabaseToCents({ dbPath: file, backupDir: path.join(dir, "backups") });

    const db = openFile(file);
    try {
      expect(() =>
        db.run(
          "INSERT INTO categories (name, type, icon, color) VALUES ('Food', 'Expense', 'W', '#000')",
        ),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it("conserves the exact total across a ledger whose float sum drifts", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");

    // 100 rows of 0.10 and 100 rows of 0.70: exactly $80.00, but float64 says
    // 80.00000000000016 — the drift this whole refactor exists to remove.
    const transactions = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: i + 1, categoryId: 1, amount: 0.1 })),
      ...Array.from({ length: 100 }, (_, i) => ({ id: i + 101, categoryId: 1, amount: 0.7 })),
    ];
    buildFixture(file, {
      categories: [{ id: 1, name: "Food", type: "Expense", monthlyLimit: null }],
      transactions,
    });

    const floatSum = transactions.reduce((sum, t) => sum + t.amount, 0);
    expect(floatSum).not.toBe(80);

    const result = await migrateDatabaseToCents({
      dbPath: file,
      backupDir: path.join(dir, "backups"),
    });

    const column = result.report.columns.find((c) => c.table === "transactions")!;
    expect(column.rowCountAfter).toBe(200);
    expect(column.sumActualCents).toBe(8000);
    expect(column.sumExpectedCents).toBe(8000);

    const db = openFile(file);
    try {
      const cents = selectRows(db, "SELECT amount_cents FROM transactions").map(
        (row) => row[0] as number,
      );
      expect(sumCents(cents)).toBe(8000);
    } finally {
      db.close();
    }
  });

  it("refuses a database that has no money tables at all", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "budget.db");
    const db = new SQL.Database();
    db.run("CREATE TABLE unrelated (id integer)");
    writeFileSync(file, Buffer.from(db.export()));
    db.close();

    await expect(
      migrateDatabaseToCents({ dbPath: file, backupDir: path.join(dir, "backups") }),
    ).rejects.toThrow(/table/i);
  });

  it("refuses a missing database file", async () => {
    const dir = makeTempDir();
    await expect(
      migrateDatabaseToCents({
        dbPath: path.join(dir, "nope.db"),
        backupDir: path.join(dir, "backups"),
      }),
    ).rejects.toThrow(/not found|does not exist/i);
  });
});
