/** Safely add city checkpoints to an existing LocalFi database. */
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

const MIGRATION_PATH = path.resolve(process.cwd(), "drizzle/migrations/0007_travel_checkpoints.sql");

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

function tableNames(db: Database): string[] {
  return (
    db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )[0]?.values ?? []
  ).map((row) => String(row[0]));
}

function rowCounts(db: Database, tables: readonly string[]): Record<string, number> {
  return Object.fromEntries(
    tables.map((table) => {
      if (!/^[a-z_]+$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
      return [table, Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] ?? 0)];
    }),
  );
}

function foreignKeyViolations(db: Database): unknown[][] {
  return db.exec("PRAGMA foreign_key_check")[0]?.values ?? [];
}

function assertMigrated(
  db: Database,
  expectedCounts: Record<string, number>,
  expectedForeignKeys: unknown[][],
) {
  if (!hasTable(db, "travel_checkpoints")) throw new Error("travel_checkpoints was not created");
  const columns = new Set(
    (db.exec("PRAGMA table_info(travel_checkpoints)")[0]?.values ?? []).map((row) => String(row[1])),
  );
  for (const column of ["country_code", "city_name", "latitude", "longitude", "visited_at"]) {
    if (!columns.has(column)) throw new Error(`travel_checkpoints.${column} is missing`);
  }
  if (JSON.stringify(rowCounts(db, Object.keys(expectedCounts))) !== JSON.stringify(expectedCounts)) {
    throw new Error("Migration changed existing row counts");
  }
  if (JSON.stringify(foreignKeyViolations(db)) !== JSON.stringify(expectedForeignKeys)) {
    throw new Error("Migration changed existing foreign-key violations");
  }
}

export async function migrateToTravelCheckpoints(options: {
  dbPath?: string;
  dryRun?: boolean;
} = {}) {
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

  if (hasTable(db, "travel_checkpoints")) {
    db.close();
    return { alreadyMigrated: true, backupPath: null, dbPath, preservedRows: {} };
  }
  if (!hasTable(db, "visited_countries")) {
    db.close();
    throw new Error("visited_countries is missing; initialize the base schema first.");
  }

  const existingTables = tableNames(db);
  const countsBefore = rowCounts(db, existingTables);
  const foreignKeysBefore = foreignKeyViolations(db);
  for (const statement of readFileSync(MIGRATION_PATH, "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
  assertMigrated(db, countsBefore, foreignKeysBefore);
  const migratedBytes = Buffer.from(db.export());
  db.close();

  if (options.dryRun) {
    return { alreadyMigrated: false, backupPath: null, dbPath, preservedRows: countsBefore };
  }

  const backupDirectory = path.join(path.dirname(dbPath), "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDirectory, `budget.${stamp}.pre-0007.db`);
  const temporaryPath = `${dbPath}.migration-0007.tmp`;
  copyFileSync(dbPath, backupPath);

  try {
    writeFileSync(temporaryPath, migratedBytes);
    renameSync(temporaryPath, dbPath);
    const saved = new SQL.Database(readFileSync(dbPath));
    saved.run("PRAGMA foreign_keys = ON");
    try {
      assertMigrated(saved, countsBefore, foreignKeysBefore);
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
  const result = await migrateToTravelCheckpoints({
    dbPath: dbIndex >= 0 ? args[dbIndex + 1] : undefined,
    dryRun: args.includes("--dry-run"),
  });
  console.log(result.alreadyMigrated ? "Migration 0007 is already applied." : "Migration 0007 verified.");
  console.log(`Database: ${result.dbPath}`);
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
  if (args.includes("--dry-run")) console.log("Dry run only; the database was not changed.");
}

if (/migrate-to-travel-checkpoints\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("Migration 0007 failed; the database was left unchanged or restored.");
    console.error(error);
    process.exit(1);
  });
}
