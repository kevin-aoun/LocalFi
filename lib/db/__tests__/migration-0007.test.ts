import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { migrateToTravelCheckpoints } from "../migrate-to-travel-checkpoints";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "drizzle", "migrations");
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (file) => path.join(ROOT, "node_modules/sql.js/dist", file) });
});

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function pre0007Database() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "budget-0007-"));
  temporaryDirectories.push(directory);
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const db = new SQL.Database();
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    if (entry.idx >= 7) break;
    const sql = readFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) db.exec(statement);
    }
  }
  db.run("INSERT INTO visited_countries (country_code, country_name) VALUES ('LBN', 'Lebanon')");
  const file = path.join(directory, "budget.db");
  writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return file;
}

describe("migration 0007", () => {
  it("dry-runs without changing the database", async () => {
    const file = pre0007Database();
    const before = readFileSync(file);
    await migrateToTravelCheckpoints({ dbPath: file, dryRun: true });
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("backs up, preserves existing rows, and cascades country deletion", async () => {
    const file = pre0007Database();
    const result = await migrateToTravelCheckpoints({ dbPath: file });
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
    expect(result.preservedRows.visited_countries).toBe(1);

    const db = new SQL.Database(readFileSync(file));
    db.run("PRAGMA foreign_keys = ON");
    db.run(
      "INSERT INTO travel_checkpoints (country_code, city_name, latitude, longitude) VALUES ('LBN', 'Beirut', 33.8938, 35.5018)",
    );
    db.run("DELETE FROM visited_countries WHERE country_code = 'LBN'");
    expect(db.exec("SELECT COUNT(*) FROM travel_checkpoints")[0].values[0][0]).toBe(0);
    db.close();

    expect((await migrateToTravelCheckpoints({ dbPath: file })).alreadyMigrated).toBe(true);
  });
});
