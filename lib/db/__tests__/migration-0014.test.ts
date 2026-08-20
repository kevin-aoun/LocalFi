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

function pre0014(): Database {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const db = new SQL.Database();
  for (const entry of journal.entries) {
    if (entry.idx >= 14) break;
    apply(db, entry.tag);
  }
  return db;
}

describe("migration 0014", () => {
  it("preserves existing categories and adds a stable sortable default", () => {
    const db = pre0014();
    try {
      db.run("INSERT INTO categories (name, type, icon, color) VALUES ('Food', 'Expense', 'Wallet', '#fff')");
      db.run("INSERT INTO categories (name, type, icon, color) VALUES ('Rent', 'Expense', 'Home', '#000')");

      apply(db, "0014_category-order");

      expect(db.exec("SELECT name, display_order FROM categories ORDER BY display_order, id")[0].values)
        .toEqual([["Food", 0], ["Rent", 0]]);
      expect(
        db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name='categories_type_display_order_idx'")[0].values,
      ).toEqual([["categories_type_display_order_idx"]]);
    } finally {
      db.close();
    }
  });
});
