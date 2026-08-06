import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { migrateToTravelRoutes } from "../migrate-to-travel-routes";

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

function pre0008Database() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "budget-0008-"));
  temporaryDirectories.push(directory);
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const db = new SQL.Database();
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    if (entry.idx >= 8) break;
    const sql = readFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) db.exec(statement);
    }
  }
  db.run(
    "INSERT INTO visited_countries (country_code, country_name) VALUES ('DEU', 'Germany'), ('FRA', 'France')",
  );
  db.run(
    "INSERT INTO travel_checkpoints (id, country_code, city_name, latitude, longitude) VALUES (1, 'DEU', 'Munich', 48.14, 11.58), (2, 'FRA', 'Paris', 48.86, 2.35)",
  );
  const file = path.join(directory, "budget.db");
  writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return file;
}

describe("migration 0008", () => {
  it("dry-runs without changing the database", async () => {
    const file = pre0008Database();
    const before = readFileSync(file);
    await migrateToTravelRoutes({ dbPath: file, dryRun: true });
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("backs up existing cities and clears routes when an origin is deleted", async () => {
    const file = pre0008Database();
    const result = await migrateToTravelRoutes({ dbPath: file });
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
    expect(result.preservedRows.travel_checkpoints).toBe(2);

    const db = new SQL.Database(readFileSync(file));
    db.run("PRAGMA foreign_keys = ON");
    db.run("UPDATE travel_checkpoints SET origin_city_id = 1 WHERE id = 2");
    db.run("DELETE FROM travel_checkpoints WHERE id = 1");
    expect(db.exec("SELECT origin_city_id FROM travel_checkpoints WHERE id = 2")[0].values[0][0]).toBeNull();
    db.close();

    expect((await migrateToTravelRoutes({ dbPath: file })).alreadyMigrated).toBe(true);
  });
});
