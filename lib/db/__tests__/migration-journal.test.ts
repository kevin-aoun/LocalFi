/**
 * Replays every migration in journal order — exactly what lib/db/init.ts does —
 * and asserts the resulting schema is the cents schema the Drizzle definitions
 * describe. This is what keeps a freshly initialised database and a converted
 * one from drifting apart.
 *
 * Runs entirely in memory: no file in data/ is read or written.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";

import { MONEY_COLUMNS } from "../migrate-to-cents";

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

/** Mirrors the replay loop in lib/db/init.ts. */
function replayJournal(): Database {
  const db = new SQL.Database();
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  for (const entry of entries) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf-8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) db.exec(statement);
    }
  }
  return db;
}

function columnInfo(db: Database, table: string): Map<string, { type: string; notNull: boolean }> {
  const rows = db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? [];
  return new Map(
    rows.map((row) => [
      String(row[1]),
      { type: String(row[2]).toLowerCase(), notNull: Number(row[3]) === 1 },
    ]),
  );
}

describe("migration journal", () => {
  it("is contiguous, ordered, and every tag has a .sql file", () => {
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
    for (const entry of entries) {
      expect(() =>
        readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf-8"),
      ).not.toThrow();
    }
  });

  it("includes the money-to-cents migration", () => {
    expect(journal.entries.map((e) => e.tag)).toContain("0002_money_to_cents");
  });

  it("has a snapshot for every entry", () => {
    for (const entry of journal.entries) {
      const idx = String(entry.idx).padStart(4, "0");
      expect(() =>
        readFileSync(path.join(MIGRATIONS_DIR, "meta", `${idx}_snapshot.json`), "utf-8"),
      ).not.toThrow();
    }
  });

  it("chains snapshot prevId -> id in journal order", () => {
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    let previousId: string | null = null;
    for (const entry of entries) {
      const idx = String(entry.idx).padStart(4, "0");
      const snapshot = JSON.parse(
        readFileSync(path.join(MIGRATIONS_DIR, "meta", `${idx}_snapshot.json`), "utf-8"),
      );
      if (previousId !== null) expect(snapshot.prevId).toBe(previousId);
      previousId = snapshot.id;
    }
  });

  it("replays cleanly from empty", () => {
    const db = replayJournal();
    try {
      const tables = (
        db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? []
      ).map((row) => String(row[0]));
      for (const table of [
        "categories",
        "transactions",
        "assets",
        "asset_history",
        "quick_commands",
        "settings",
        "visited_countries",
      ]) {
        expect(tables).toContain(table);
      }
      // No leftover scaffolding from the table-rebuild dance.
      expect(tables.filter((t) => t.startsWith("__new"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("ends with integer cents columns and no float money columns", () => {
    const db = replayJournal();
    try {
      for (const spec of MONEY_COLUMNS) {
        const columns = columnInfo(db, spec.table);
        expect(columns.has(spec.oldColumn)).toBe(false);
        const column = columns.get(spec.newColumn);
        expect(column, `${spec.table}.${spec.newColumn} missing`).toBeDefined();
        expect(column!.type).toBe("integer");
        expect(column!.notNull).toBe(spec.notNull);
      }
    } finally {
      db.close();
    }
  });

  it("keeps assets.quantity a real", () => {
    const db = replayJournal();
    try {
      expect(columnInfo(db, "assets").get("quantity")!.type).toBe("real");
    } finally {
      db.close();
    }
  });

  it("keeps the categories.name unique index and the FKs", () => {
    const db = replayJournal();
    try {
      const indexes = (
        db.exec("SELECT name FROM sqlite_master WHERE type='index'")[0]?.values ?? []
      ).map((row) => String(row[0]));
      expect(indexes).toContain("categories_name_unique");

      const txFks = db.exec("PRAGMA foreign_key_list(transactions)")[0]?.values ?? [];
      expect(txFks.map((row) => String(row[2]))).toContain("categories");
      const historyFks = db.exec("PRAGMA foreign_key_list(asset_history)")[0]?.values ?? [];
      expect(historyFks.map((row) => String(row[2]))).toContain("assets");
    } finally {
      db.close();
    }
  });

  it("accepts integer cents and the Drizzle column names on insert", () => {
    const db = replayJournal();
    try {
      db.run("PRAGMA foreign_keys = ON");
      db.run(
        "INSERT INTO categories (name, type, monthly_limit_cents, icon, color) VALUES ('Food', 'Expense', 5000, 'W', '#000')",
      );
      db.run(
        "INSERT INTO transactions (date, category_id, amount_cents, comment) VALUES (0, 1, 123456, 'x')",
      );
      db.run("INSERT INTO assets (category, current_value_cents) VALUES ('Cash', 449618)");
      db.run("INSERT INTO asset_history (asset_id, value_cents) VALUES (1, 70)");
      db.run(
        "INSERT INTO quick_commands (command, category_name, amount_cents, comment) VALUES ('salary', 'Salary', 140000, 'c')",
      );

      expect(db.exec("SELECT amount_cents FROM transactions")[0].values).toEqual([[123456]]);
      expect(db.exec("SELECT current_value_cents FROM assets")[0].values).toEqual([[449618]]);
      // NOT NULL is really enforced on the money columns.
      expect(() =>
        db.run("INSERT INTO assets (category, current_value_cents) VALUES ('Cash', NULL)"),
      ).toThrow(/NOT NULL/i);
      // ...but a category may still have no limit.
      db.run("INSERT INTO categories (name, type, icon, color) VALUES ('NoLimit', 'Expense', 'W', '#000')");
      expect(
        db.exec("SELECT monthly_limit_cents FROM categories WHERE name = 'NoLimit'")[0].values,
      ).toEqual([[null]]);
    } finally {
      db.close();
    }
  });
});
