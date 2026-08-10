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

function pre0013(): Database {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const db = new SQL.Database();
  for (const entry of journal.entries) {
    if (entry.idx >= 13) break;
    apply(db, entry.tag);
  }
  return db;
}

describe("migration 0013", () => {
  it("adds an off-by-default preference to an existing settings row", () => {
    const db = pre0013();
    try {
      db.run(
        "INSERT INTO settings (user_name, accent_color, theme) VALUES ('Owner', 'default', 'dark')",
      );
      apply(db, "0013_ledger-explorer");

      expect(db.exec("SELECT user_name, theme, show_ledger FROM settings")[0].values).toEqual([
        ["Owner", "dark", 0],
      ]);
    } finally {
      db.close();
    }
  });

  it("defaults fresh settings rows off and round-trips an explicit opt-in", () => {
    const db = pre0013();
    try {
      apply(db, "0013_ledger-explorer");
      db.run("INSERT INTO settings DEFAULT VALUES");
      expect(db.exec("SELECT show_ledger FROM settings")[0].values).toEqual([[0]]);
      db.run("UPDATE settings SET show_ledger = 1");
      expect(db.exec("SELECT show_ledger FROM settings")[0].values).toEqual([[1]]);
    } finally {
      db.close();
    }
  });
});
