/**
 * Safely apply migration 0006 to an existing sql.js database.
 *
 *   node node_modules/tsx/dist/cli.mjs lib/db/migrate-to-budget-reallocations.ts --dry-run
 *   node node_modules/tsx/dist/cli.mjs lib/db/migrate-to-budget-reallocations.ts [--db <path>]
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";

import { resolveDbPath } from "./client";

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  "drizzle/migrations/0006_budget_reallocations.sql",
);

type MigrationResult = {
  alreadyMigrated: boolean;
  backupPath: string | null;
  dbPath: string;
  preservedRows: Record<string, number>;
};

function tableNames(db: Database): string[] {
  const result = db.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )[0];
  return (result?.values ?? []).map((row) => String(row[0]));
}

function hasTable(db: Database, name: string): boolean {
  const statement = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  );
  try {
    statement.bind([name]);
    return statement.step();
  } finally {
    statement.free();
  }
}

function rowCounts(db: Database, tables: readonly string[]): Record<string, number> {
  return Object.fromEntries(
    tables.map((table) => {
      if (!/^[a-z_]+$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
      const result = db.exec(`SELECT COUNT(*) FROM ${table}`)[0];
      return [table, Number(result?.values[0]?.[0] ?? 0)];
    }),
  );
}

function foreignKeyViolations(db: Database): unknown[][] {
  return db.exec("PRAGMA foreign_key_check")[0]?.values ?? [];
}

function assertMigrated(db: Database, expectedCounts: Record<string, number>, expectedFks: unknown[][]) {
  if (!hasTable(db, "budget_reallocations")) {
    throw new Error("budget_reallocations was not created");
  }
  const columns = new Set(
    (db.exec("PRAGMA table_info(budget_reallocations)")[0]?.values ?? []).map((row) => String(row[1])),
  );
  for (const required of [
    "month",
    "from_category_id",
    "to_category_id",
    "amount_cents",
    "input_mode",
    "input_value",
  ]) {
    if (!columns.has(required)) throw new Error(`budget_reallocations.${required} is missing`);
  }

  const actualCounts = rowCounts(db, Object.keys(expectedCounts));
  if (JSON.stringify(actualCounts) !== JSON.stringify(expectedCounts)) {
    throw new Error(`Existing row counts changed: ${JSON.stringify({ expectedCounts, actualCounts })}`);
  }
  const actualFks = foreignKeyViolations(db);
  if (JSON.stringify(actualFks) !== JSON.stringify(expectedFks)) {
    throw new Error("Migration changed the database's foreign-key violations");
  }
}

export async function migrateToBudgetReallocations(options: {
  dbPath?: string;
  dryRun?: boolean;
} = {}): Promise<MigrationResult> {
  const dbPath = path.resolve(options.dbPath ?? resolveDbPath());
  if (!existsSync(dbPath) || statSync(dbPath).size === 0) {
    throw new Error(`No existing database at ${dbPath}`);
  }

  const SQL = await initSqlJs({
    locateFile: (file) => path.resolve(process.cwd(), "node_modules/sql.js/dist", file),
  });
  const originalBytes = readFileSync(dbPath);
  const db = new SQL.Database(originalBytes);
  db.run("PRAGMA foreign_keys = ON");

  if (hasTable(db, "budget_reallocations")) {
    db.close();
    return { alreadyMigrated: true, backupPath: null, dbPath, preservedRows: {} };
  }
  if (!hasTable(db, "categories") || !hasTable(db, "budgets")) {
    db.close();
    throw new Error("This database predates budget periods; apply migration 0003 first.");
  }

  const existingTables = tableNames(db);
  const countsBefore = rowCounts(db, existingTables);
  const fksBefore = foreignKeyViolations(db);
  const migration = readFileSync(MIGRATION_PATH, "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
  assertMigrated(db, countsBefore, fksBefore);
  const migratedBytes = Buffer.from(db.export());
  db.close();

  if (options.dryRun) {
    return { alreadyMigrated: false, backupPath: null, dbPath, preservedRows: countsBefore };
  }

  const backupDir = path.join(path.dirname(dbPath), "backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `budget.${stamp}.pre-0006.db`);
  const temporaryPath = `${dbPath}.migration-0006.tmp`;
  copyFileSync(dbPath, backupPath);

  try {
    writeFileSync(temporaryPath, migratedBytes);
    renameSync(temporaryPath, dbPath);
    const saved = new SQL.Database(readFileSync(dbPath));
    saved.run("PRAGMA foreign_keys = ON");
    try {
      assertMigrated(saved, countsBefore, fksBefore);
    } finally {
      saved.close();
    }
  } catch (error) {
    copyFileSync(backupPath, dbPath);
    throw error;
  }

  return { alreadyMigrated: false, backupPath, dbPath, preservedRows: countsBefore };
}

async function main() {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf("--db");
  const result = await migrateToBudgetReallocations({
    dbPath: dbIndex >= 0 ? args[dbIndex + 1] : undefined,
    dryRun: args.includes("--dry-run"),
  });
  console.log(result.alreadyMigrated ? "Migration 0006 is already applied." : "Migration 0006 verified.");
  console.log(`Database: ${result.dbPath}`);
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
  if (args.includes("--dry-run")) console.log("Dry run only; the database was not changed.");
}

if (/migrate-to-budget-reallocations\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("Migration 0006 failed; the database was left unchanged or restored.");
    console.error(error);
    process.exit(1);
  });
}
