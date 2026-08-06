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

export type AdditiveMigration = {
  id: string;
  sqlPath: string;
  isApplied: (db: Database) => boolean;
  assertPrerequisites: (db: Database) => void;
  assertResult: (db: Database) => void;
};

export function tableExists(db: Database, name: string) {
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

export function tableHasColumn(db: Database, table: string, column: string) {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
  return (db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).some(
    (row) => String(row[1]) === column,
  );
}

function tableNames(db: Database) {
  return (
    db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )[0]?.values ?? []
  ).map((row) => String(row[0]));
}

function rowCounts(db: Database, tables: readonly string[]) {
  return Object.fromEntries(
    tables.map((table) => {
      if (!/^[a-z_]+$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
      return [table, Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] ?? 0)];
    }),
  );
}

function foreignKeyViolations(db: Database) {
  return db.exec("PRAGMA foreign_key_check")[0]?.values ?? [];
}

function verifyPreserved(
  db: Database,
  expectedCounts: Record<string, number>,
  expectedForeignKeys: unknown[][],
) {
  if (JSON.stringify(rowCounts(db, Object.keys(expectedCounts))) !== JSON.stringify(expectedCounts)) {
    throw new Error("Migration changed existing row counts");
  }
  if (JSON.stringify(foreignKeyViolations(db)) !== JSON.stringify(expectedForeignKeys)) {
    throw new Error("Migration changed existing foreign-key violations");
  }
}

export async function applyAdditiveMigration(
  migration: AdditiveMigration,
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

  if (migration.isApplied(db)) {
    migration.assertResult(db);
    db.close();
    return { alreadyMigrated: true, backupPath: null, dbPath, preservedRows: {} };
  }

  migration.assertPrerequisites(db);
  const countsBefore = rowCounts(db, tableNames(db));
  const foreignKeysBefore = foreignKeyViolations(db);
  const sql = readFileSync(path.resolve(process.cwd(), migration.sqlPath), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
  migration.assertResult(db);
  verifyPreserved(db, countsBefore, foreignKeysBefore);
  const migratedBytes = Buffer.from(db.export());
  db.close();

  if (options.dryRun) {
    return { alreadyMigrated: false, backupPath: null, dbPath, preservedRows: countsBefore };
  }

  const backupDirectory = path.join(path.dirname(dbPath), "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDirectory, `budget.${stamp}.pre-${migration.id}.db`);
  const temporaryPath = `${dbPath}.migration-${migration.id}.tmp`;
  copyFileSync(dbPath, backupPath);

  try {
    writeFileSync(temporaryPath, migratedBytes);
    renameSync(temporaryPath, dbPath);
    const saved = new SQL.Database(readFileSync(dbPath));
    saved.run("PRAGMA foreign_keys = ON");
    try {
      migration.assertResult(saved);
      verifyPreserved(saved, countsBefore, foreignKeysBefore);
    } finally {
      saved.close();
    }
  } catch (error) {
    copyFileSync(backupPath, dbPath);
    throw error;
  }

  return { alreadyMigrated: false, backupPath, dbPath, preservedRows: countsBefore };
}
