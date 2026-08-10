import { readFileSync } from "node:fs";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "drizzle", "migrations");
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(ROOT, "node_modules/sql.js/dist", file),
  });
});

function runMigration(db: Database, tag: string) {
  const source = readFileSync(path.join(MIGRATIONS, `${tag}.sql`), "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

function pre0011Database(): Database {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const db = new SQL.Database();
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    if (entry.idx >= 11) break;
    runMigration(db, entry.tag);
  }
  return db;
}

describe("migration 0011", () => {
  it("preserves existing budgets and adds empty goal metadata", () => {
    const db = pre0011Database();
    try {
      db.run(
        "INSERT INTO categories (id, name, type, icon, color) VALUES (1, 'Food', 'Expense', 'Wallet', '#000')",
      );
      db.run(
        "INSERT INTO budgets (id, category_id, period, limit_cents, effective_from, effective_to, rollover) " +
          "VALUES (7, 1, 'monthly', 50000, '2026-01-01', NULL, 1)",
      );

      runMigration(db, "0011_budget-goals");

      expect(
        db.exec(
          "SELECT id, category_id, period, limit_cents, effective_from, effective_to, rollover, goal_name, goal_amount_cents FROM budgets",
        )[0].values,
      ).toEqual([[7, 1, "monthly", 50000, "2026-01-01", null, 1, null, null]]);
      expect(db.exec("PRAGMA foreign_key_check")[0]?.values ?? []).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("enforces complete positive goals on monthly rollover budgets", () => {
    const db = pre0011Database();
    try {
      db.run(
        "INSERT INTO categories (id, name, type, icon, color) VALUES (1, 'Travel', 'Expense', 'Wallet', '#000')",
      );
      runMigration(db, "0011_budget-goals");

      const insert = (period: string, rollover: number, name: string | null, amount: number | null) =>
        db.run(
          "INSERT INTO budgets (category_id, period, limit_cents, effective_from, rollover, goal_name, goal_amount_cents) VALUES (1, ?, 10000, '2026-01-01', ?, ?, ?)",
          [period, rollover, name, amount],
        );

      expect(() => insert("monthly", 1, "Emergency fund", null)).toThrow(/CHECK constraint/i);
      expect(() => insert("monthly", 1, null, 10000)).toThrow(/CHECK constraint/i);
      expect(() => insert("monthly", 1, "Emergency fund", 0)).toThrow(/CHECK constraint/i);
      expect(() => insert("monthly", 0, "Emergency fund", 10000)).toThrow(/CHECK constraint/i);
      expect(() => insert("weekly", 1, "Emergency fund", 10000)).toThrow(/CHECK constraint/i);
      expect(() => insert("monthly", 1, "   ", 10000)).toThrow(/CHECK constraint/i);

      expect(() => insert("monthly", 1, "Emergency fund", 10000)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
