import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";

import { resolveDbPath } from "./client";
import { tableExists, tableHasColumn } from "./migrate-additive";

const MIGRATION_ID = "0010";
const SQL_PATH = "drizzle/migrations/0010_currency-safe-holdings.sql";

function scalar(db: Database, sql: string): number {
  return Number(db.exec(sql)[0]?.values[0]?.[0] ?? 0);
}

function indexExists(db: Database, name: string): boolean {
  const statement = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1",
  );
  try {
    statement.bind([name]);
    return statement.step();
  } finally {
    statement.free();
  }
}

function tableSql(db: Database, table: string): string {
  const statement = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  );
  try {
    statement.bind([table]);
    if (!statement.step()) return "";
    return String(statement.get()[0] ?? "");
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
      return [table, scalar(db, `SELECT COUNT(*) FROM ${table}`)];
    }),
  );
}

function foreignKeyViolations(db: Database): unknown[][] {
  return db.exec("PRAGMA foreign_key_check")[0]?.values ?? [];
}

function isApplied(db: Database): boolean {
  return (
    tableHasColumn(db, "assets", "archived") &&
    tableHasColumn(db, "asset_history", "currency") &&
    tableHasColumn(db, "asset_history", "recorded_day") &&
    tableHasColumn(db, "net_worth_snapshots", "currency") &&
    indexExists(db, "asset_history_asset_day_unique")
  );
}

function assertPrerequisites(db: Database): void {
  for (const table of ["assets", "asset_history", "net_worth_snapshots"]) {
    if (!tableExists(db, table)) {
      throw new Error(`${table} is missing; apply the earlier migrations first.`);
    }
  }
}

function assertResult(db: Database): void {
  if (!isApplied(db)) throw new Error("Migration 0010 schema is incomplete");
  if (
    scalar(
      db,
      `SELECT COUNT(*) FROM (
         SELECT asset_id, recorded_day
         FROM asset_history
         GROUP BY asset_id, recorded_day
         HAVING COUNT(*) > 1
       )`,
    ) > 0
  ) {
    throw new Error("asset_history still contains duplicate holding/day rows");
  }
  if (
    scalar(
      db,
      `SELECT COUNT(*) FROM asset_history
       WHERE currency NOT GLOB '[A-Z][A-Z][A-Z]'
          OR recorded_day NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          OR date(recorded_day, '+0 days') <> recorded_day`,
    ) > 0
  ) {
    throw new Error("asset_history contains an invalid currency or calendar day");
  }
  if (
    scalar(
      db,
      `SELECT COUNT(*) FROM assets
       WHERE (use_live_price = 1 OR NULLIF(TRIM(price_symbol), '') IS NOT NULL)
         AND currency <> 'USD'`,
    ) > 0
  ) {
    throw new Error("a live-priced holding is still labelled as non-USD");
  }
  const definition = tableSql(db, "asset_history");
  for (const constraint of [
    "asset_history_currency_valid",
    "asset_history_recorded_day_valid",
  ]) {
    if (!definition.includes(constraint)) throw new Error(`${constraint} is missing`);
  }
}

function verifyPreservation(
  db: Database,
  expectedCounts: Record<string, number>,
  expectedHistoryRows: number,
  expectedForeignKeys: unknown[][],
): void {
  const actual = rowCounts(db, Object.keys(expectedCounts));
  for (const [table, count] of Object.entries(expectedCounts)) {
    const expected = table === "asset_history" ? expectedHistoryRows : count;
    if (actual[table] !== expected) {
      throw new Error(`${table} row count changed unexpectedly (${count} -> ${actual[table]})`);
    }
  }
  if (JSON.stringify(foreignKeyViolations(db)) !== JSON.stringify(expectedForeignKeys)) {
    throw new Error("Migration changed existing foreign-key violations");
  }
}

export async function migrateToCurrencySafeHoldings(
  options: { dbPath?: string; dryRun?: boolean } = {},
) {
  const dbPath = path.resolve(options.dbPath ?? resolveDbPath());
  if (!existsSync(dbPath) || statSync(dbPath).size === 0) {
    throw new Error(`No existing database at ${dbPath}`);
  }

  const SQL = await initSqlJs({
    locateFile: (file) => path.resolve(process.cwd(), "node_modules/sql.js/dist", file),
  });
  const db = new SQL.Database(readFileSync(dbPath));
  db.run("PRAGMA foreign_keys = ON");

  if (isApplied(db)) {
    assertResult(db);
    db.close();
    return { alreadyMigrated: true, backupPath: null, dbPath, preservedRows: {} };
  }

  assertPrerequisites(db);
  const tables = tableNames(db);
  const countsBefore = rowCounts(db, tables);
  const newestDailyRows = scalar(
    db,
    `SELECT COUNT(*) FROM (
       SELECT asset_id, strftime('%Y-%m-%d', recorded_at, 'unixepoch', 'localtime')
       FROM asset_history
       GROUP BY asset_id, strftime('%Y-%m-%d', recorded_at, 'unixepoch', 'localtime')
     )`,
  );
  const foreignKeysBefore = foreignKeyViolations(db);
  const sql = readFileSync(path.resolve(process.cwd(), SQL_PATH), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
  assertResult(db);
  verifyPreservation(db, countsBefore, newestDailyRows, foreignKeysBefore);
  const migratedBytes = Buffer.from(db.export());
  db.close();

  if (options.dryRun) {
    return { alreadyMigrated: false, backupPath: null, dbPath, preservedRows: countsBefore };
  }

  const backupDirectory = path.join(path.dirname(dbPath), "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDirectory, `budget.${stamp}.pre-${MIGRATION_ID}.db`);
  const temporaryPath = `${dbPath}.migration-${MIGRATION_ID}.tmp`;
  copyFileSync(dbPath, backupPath);

  try {
    writeFileSync(temporaryPath, migratedBytes);
    renameSync(temporaryPath, dbPath);
    const saved = new SQL.Database(readFileSync(dbPath));
    saved.run("PRAGMA foreign_keys = ON");
    try {
      assertResult(saved);
      verifyPreservation(saved, countsBefore, newestDailyRows, foreignKeysBefore);
    } finally {
      saved.close();
    }
  } catch (error) {
    copyFileSync(backupPath, dbPath);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }

  return { alreadyMigrated: false, backupPath, dbPath, preservedRows: countsBefore };
}

async function main() {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf("--db");
  const result = await migrateToCurrencySafeHoldings({
    dbPath: dbIndex >= 0 ? args[dbIndex + 1] : undefined,
    dryRun: args.includes("--dry-run"),
  });
  console.log(
    result.alreadyMigrated ? "Migration 0010 is already applied." : "Migration 0010 verified.",
  );
  console.log(`Database: ${result.dbPath}`);
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
  if (args.includes("--dry-run")) console.log("Dry run only; the database was not changed.");
}

if (/migrate-to-currency-safe-holdings\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("Migration 0010 failed; the database was left unchanged or restored.");
    console.error(error);
    process.exit(1);
  });
}
