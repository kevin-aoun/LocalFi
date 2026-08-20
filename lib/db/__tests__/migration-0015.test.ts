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

function apply(db: Database, tag: string) {
  const source = readFileSync(path.join(MIGRATIONS, `${tag}.sql`), "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

function pre0015(): Database {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const db = new SQL.Database();
  for (const entry of journal.entries) {
    if (entry.idx >= 15) break;
    apply(db, entry.tag);
  }
  return db;
}

describe("migration 0015", () => {
  it("preserves existing budgets and adds stable sortable metadata", () => {
    const db = pre0015();
    try {
      db.run("INSERT INTO categories (name, type, icon, color) VALUES ('Food', 'Expense', 'Wallet', '#fff')");
      db.run("INSERT INTO budgets (category_id, period, limit_cents, effective_from) VALUES (1, 'monthly', 10000, '2026-01-01')");

      apply(db, "0015_budget-order");

      expect(db.exec("SELECT limit_cents, display_order FROM budgets")[0].values)
        .toEqual([[10000, 0]]);
      expect(
        db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name='budgets_display_order_idx'")[0].values,
      ).toEqual([["budgets_display_order_idx"]]);
    } finally {
      db.close();
    }
  });
});
