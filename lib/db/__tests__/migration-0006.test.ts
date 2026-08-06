import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { migrateToBudgetReallocations } from "../migrate-to-budget-reallocations";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "drizzle", "migrations");
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (file) => path.join(ROOT, "node_modules/sql.js/dist", file) });
});

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function pre0006Database(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "budget-0006-"));
  temporaryDirectories.push(directory);
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const db = new SQL.Database();
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    if (entry.idx >= 6) break;
    const migration = readFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.exec(statement);
    }
  }
  db.run("INSERT INTO categories (id, name, type, icon, color) VALUES (1, 'Gifts', 'Expense', 'Gift', '#fff')");
  const file = path.join(directory, "budget.db");
  writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return file;
}

function tableExists(file: string): boolean {
  const db = new SQL.Database(readFileSync(file));
  try {
    return Boolean(
      db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='budget_reallocations'")[0],
    );
  } finally {
    db.close();
  }
}

describe("migration 0006", () => {
  it("verifies without writing during a dry run", async () => {
    const file = pre0006Database();
    const before = readFileSync(file);
    const result = await migrateToBudgetReallocations({ dbPath: file, dryRun: true });
    expect(result.alreadyMigrated).toBe(false);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(tableExists(file)).toBe(false);
  });

  it("backs up the database, preserves rows, and refuses to apply twice", async () => {
    const file = pre0006Database();
    const before = readFileSync(file);
    const result = await migrateToBudgetReallocations({ dbPath: file });
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(readFileSync(result.backupPath!).equals(before)).toBe(true);
    expect(result.preservedRows.categories).toBe(1);
    expect(tableExists(file)).toBe(true);

    const again = await migrateToBudgetReallocations({ dbPath: file });
    expect(again.alreadyMigrated).toBe(true);
    expect(again.backupPath).toBeNull();
  });
});
