/**
 * One-shot conversion of an existing budget database from `real` (float64)
 * money columns to integer minor units ("cents").
 *
 *   bun x tsx lib/db/migrate-to-cents.ts [--db <path>] [--dry-run]
 *
 * Safety properties, in order of importance:
 *
 *  1. A byte-for-byte backup of the PRE-migration file is written to
 *     data/backups/budget.<timestamp>.db before anything is modified.
 *  2. All conversion happens on an in-memory copy. Nothing is written to the
 *     live path until every assertion has passed.
 *  3. Cents are computed in JS with `Math.round(value * 100)` — correct for
 *     values that originated as human-entered two-decimal amounts — and each
 *     result is asserted to be a safe integer.
 *  4. Conservation is verified per column: `sum(round(old * 100))` must equal
 *     `sum(new_cents)`, and row counts must be unchanged. The written file is
 *     re-opened and re-verified from disk.
 *  5. `PRAGMA foreign_key_check` must return zero rows after the rebuild.
 *  6. If ANY of that fails, the backup is copied back over the live file and the
 *     script throws.
 *  7. Running it twice is refused: an already-converted schema is detected and
 *     the file is left untouched.
 *
 * The table rebuild itself is migration 0002 (drizzle/migrations/
 * 0002_money_to_cents.sql), so the DDL has a single source of truth. That SQL
 * seeds the new columns with SQLite's own ROUND(); this script then overwrites
 * every converted value with the JS-computed cents, so the result never depends
 * on SQLite's and JavaScript's rounding agreeing.
 *
 * This script deliberately opens its own sql.js handle instead of going through
 * lib/db/client.ts: it must control the foreign_keys pragma across a table
 * rebuild, and it must not disturb the process-cached connection.
 */
import initSqlJs, { type Database } from "sql.js";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { sumCents, type Cents } from "@/lib/money";

/** One money column to convert. */
export type MoneyColumnSpec = {
  table: string;
  /** The float column as it exists before conversion. */
  oldColumn: string;
  /** The integer-cents column it becomes. */
  newColumn: string;
  /** False for `categories.monthly_limit`, which is nullable. */
  notNull: boolean;
};

/**
 * Every money column in the schema. `assets.quantity` is absent on purpose: it
 * is a physical weight in troy ounces or grams, not money.
 */
export const MONEY_COLUMNS: MoneyColumnSpec[] = [
  { table: "transactions", oldColumn: "amount", newColumn: "amount_cents", notNull: true },
  { table: "assets", oldColumn: "current_value", newColumn: "current_value_cents", notNull: true },
  { table: "asset_history", oldColumn: "value", newColumn: "value_cents", notNull: true },
  { table: "categories", oldColumn: "monthly_limit", newColumn: "monthly_limit_cents", notNull: false },
  { table: "quick_commands", oldColumn: "amount", newColumn: "amount_cents", notNull: true },
];

/** A money column that has ALWAYS been integer cents — nothing to convert. */
export type CentsColumnSpec = {
  table: string;
  column: string;
  notNull: boolean;
  /** The migration that introduced it. */
  since: string;
};

/**
 * Money columns born AFTER the float era, listed so the inventory of every money
 * column in this codebase lives in ONE place.
 *
 * These are deliberately NOT in `MONEY_COLUMNS`: that list drives the float ->
 * cents conversion and every entry must have a `real` ancestor to read from.
 * These columns never held a float, so converting them is meaningless — but
 * forgetting they exist is how the next "are all money columns integers?" audit
 * misses four of them. Asserted by lib/db/__tests__/migration-0003.test.ts.
 */
export const CENTS_ONLY_COLUMNS: CentsColumnSpec[] = [
  { table: "accounts", column: "opening_balance_cents", notNull: true, since: "0003" },
  { table: "budgets", column: "limit_cents", notNull: true, since: "0003" },
  { table: "recurring_transactions", column: "amount_cents", notNull: true, since: "0003" },
  { table: "net_worth_snapshots", column: "total_assets_cents", notNull: true, since: "0003" },
  { table: "net_worth_snapshots", column: "total_liabilities_cents", notNull: true, since: "0003" },
  { table: "net_worth_snapshots", column: "net_worth_cents", notNull: true, since: "0003" },
];

const MIGRATION_SQL_PATH = path.join(
  "drizzle",
  "migrations",
  "0002_money_to_cents.sql",
);

/**
 * Float dollars -> integer cents, or NULL -> NULL.
 *
 * `Math.round(value * 100)` is the right rule here and only here: these values
 * were all written by this app from a two-decimal human input (or, for a
 * live-priced commodity, from a computed dollar figure whose sub-cent tail is
 * noise). Throws if the input is not finite or the result is not exactly
 * representable, so a bad row stops the migration instead of corrupting a total.
 */
export function toCents(value: number | null | undefined, label: string): Cents | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}: expected a finite number, got ${String(value)}`);
  }
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(
      `${label}: ${value} does not convert to a safe integer number of cents (got ${cents})`,
    );
  }
  return cents === 0 ? 0 : cents;
}

/** Per-column before/after figures for the conservation report. */
export type ColumnReport = {
  table: string;
  oldColumn: string;
  newColumn: string;
  rowCountBefore: number;
  rowCountAfter: number;
  /** Non-null money values seen before conversion. */
  valueCountBefore: number;
  nullCountBefore: number;
  nullCountAfter: number;
  /** sum(round(old * 100)) computed in JS from the pre-migration rows. */
  sumExpectedCents: Cents;
  /** sum(new_cents) read back from the converted database. */
  sumActualCents: Cents;
  /** The float sum of the old column, for the report only. Never used to decide. */
  sumBeforeFloat: number;
  minCents: Cents | null;
  maxCents: Cents | null;
};

export type ConversionReport = {
  dbPath: string;
  columns: ColumnReport[];
};

export type MigrateResult = {
  alreadyMigrated: boolean;
  backupPath: string | null;
  report: ConversionReport;
  /**
   * `PRAGMA foreign_key_check` rows AFTER the rebuild. Compared against the
   * pre-migration set rather than required to be empty: this database already
   * contains orphaned rows (transactions with `category_id = 0`) that predate
   * the conversion, and silently "fixing" them is not this script's job.
   */
  foreignKeyViolations: unknown[][];
  /** The same check run BEFORE the rebuild, for the report. */
  foreignKeyViolationsBefore: unknown[][];
  bytesBefore: number;
  bytesAfter: number;
};

export type MigrateOptions = {
  dbPath: string;
  backupDir: string;
  /** Verify and report, but never write the database or a backup. */
  dryRun?: boolean;
  /** Absolute or cwd-relative path to 0002_money_to_cents.sql. */
  migrationSqlPath?: string;
  /** Test seam: mutate the freshly-rebuilt database to prove verification bites. */
  corruptForTest?: (db: Database) => void;
  log?: (message: string) => void;
};

type PreRow = { id: number; value: number | null; cents: Cents | null };

async function loadSqlJs() {
  return initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules/sql.js/dist", file),
  });
}

function tableColumns(db: Database, table: string): string[] {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return (result[0]?.values ?? []).map((row) => String(row[1]));
}

function scalar(db: Database, sql: string): unknown {
  const result = db.exec(sql);
  return result[0]?.values?.[0]?.[0] ?? null;
}

function rowCount(db: Database, table: string): number {
  return Number(scalar(db, `SELECT COUNT(*) FROM ${table}`) ?? 0);
}

/**
 * Decides whether `db` still has float money columns, already has cents, or is
 * in an unrecognisable half-state (which we refuse to touch).
 */
function detectState(db: Database): "float" | "cents" {
  const existingTables = new Set(
    (db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? []).map((row) =>
      String(row[0]),
    ),
  );

  const missing = MONEY_COLUMNS.filter((spec) => !existingTables.has(spec.table));
  if (missing.length > 0) {
    throw new Error(
      `Not a budget database: missing table(s) ${missing.map((s) => s.table).join(", ")}`,
    );
  }

  const withOld: string[] = [];
  const withNew: string[] = [];
  for (const spec of MONEY_COLUMNS) {
    const columns = tableColumns(db, spec.table);
    if (columns.includes(spec.oldColumn)) withOld.push(`${spec.table}.${spec.oldColumn}`);
    if (columns.includes(spec.newColumn)) withNew.push(`${spec.table}.${spec.newColumn}`);
  }

  if (withNew.length === MONEY_COLUMNS.length && withOld.length === 0) return "cents";
  if (withOld.length === MONEY_COLUMNS.length && withNew.length === 0) return "float";

  throw new Error(
    "Refusing to run: the database is in a half-converted state. " +
      `float columns present: [${withOld.join(", ")}]; ` +
      `cents columns present: [${withNew.join(", ")}]. ` +
      "Restore a backup from data/backups/ and re-run.",
  );
}

/** Reads every money value, pairing it with the cents it must become. */
function readPreRows(db: Database, spec: MoneyColumnSpec): PreRow[] {
  const result = db.exec(
    `SELECT id, ${spec.oldColumn} FROM ${spec.table} ORDER BY id`,
  );
  const rows = result[0]?.values ?? [];
  return rows.map((row) => {
    const id = Number(row[0]);
    const raw = row[1];
    const value = raw === null || raw === undefined ? null : Number(raw);
    if (value === null && spec.notNull) {
      throw new Error(
        `${spec.table}.${spec.oldColumn} is NOT NULL but row id=${id} holds NULL`,
      );
    }
    return { id, value, cents: toCents(value, `${spec.table}.${spec.oldColumn} (id=${id})`) };
  });
}

function execScript(db: Database, sql: string) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

/** `PRAGMA foreign_key_check` rows, with FK enforcement temporarily on. */
function foreignKeyCheck(db: Database): unknown[][] {
  db.run("PRAGMA foreign_keys = ON");
  return db.exec("PRAGMA foreign_key_check")[0]?.values ?? [];
}

/** Stable key for comparing a foreign_key_check row before/after the rebuild. */
function fkKey(row: unknown[]): string {
  return row.map((cell) => String(cell)).join("|");
}

/**
 * Converts the database at `options.dbPath` in place, with a backup and full
 * verification. Idempotent: a second run reports `alreadyMigrated` and writes
 * nothing.
 */
export async function migrateDatabaseToCents(options: MigrateOptions): Promise<MigrateResult> {
  const {
    dbPath,
    backupDir,
    dryRun = false,
    migrationSqlPath = MIGRATION_SQL_PATH,
    corruptForTest,
    log = () => {},
  } = options;

  if (!existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}`);
  }
  const bytesBefore = statSync(dbPath).size;
  if (bytesBefore === 0) {
    throw new Error(`Database at ${dbPath} is empty (0 bytes); nothing to convert`);
  }

  const SQL = await loadSqlJs();
  const originalBytes = readFileSync(dbPath);
  let db = new SQL.Database(originalBytes);

  try {
    if (detectState(db) === "cents") {
      log("Already converted: every money column is integer cents. Nothing to do.");
      return {
        alreadyMigrated: true,
        backupPath: null,
        report: { dbPath, columns: [] },
        foreignKeyViolations: [],
        foreignKeyViolationsBefore: [],
        bytesBefore,
        bytesAfter: bytesBefore,
      };
    }

    // Record pre-existing referential damage so the rebuild is judged against
    // it rather than against an idealised empty set.
    const fkBefore = foreignKeyCheck(db);

    // ---- 1. Snapshot the pre-migration state, and decide every target value.
    const plans = MONEY_COLUMNS.map((spec) => {
      const rows = readPreRows(db, spec);
      const cents = rows.map((r) => r.cents).filter((c): c is Cents => c !== null);
      return {
        spec,
        rows,
        rowCountBefore: rowCount(db, spec.table),
        nullCountBefore: rows.filter((r) => r.cents === null).length,
        sumExpectedCents: sumCents(cents),
        sumBeforeFloat: rows.reduce((sum, r) => sum + (r.value ?? 0), 0),
        minCents: cents.length ? cents.reduce((a, b) => (b < a ? b : a)) : null,
        maxCents: cents.length ? cents.reduce((a, b) => (b > a ? b : a)) : null,
      };
    });

    // ---- 2. Back up the ORIGINAL bytes before anything else.
    let backupPath: string | null = null;
    if (!dryRun) {
      mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = path.join(backupDir, `budget.${stamp}.db`);
      writeFileSync(backupPath, originalBytes);
      log(`Backup written: ${backupPath} (${originalBytes.length} bytes)`);
    }

    const restore = () => {
      if (backupPath && existsSync(backupPath)) {
        copyFileSync(backupPath, dbPath);
        log(`RESTORED ${dbPath} from ${backupPath}`);
      }
    };

    try {
      // ---- 3. Rebuild the tables. FKs must be OFF for the drop/rename dance:
      // transactions -> categories and asset_history -> assets ON DELETE CASCADE
      // would otherwise fail or cascade real rows away.
      const sqlPath = path.isAbsolute(migrationSqlPath)
        ? migrationSqlPath
        : path.resolve(process.cwd(), migrationSqlPath);
      if (!existsSync(sqlPath)) {
        throw new Error(`Migration SQL not found at ${sqlPath}`);
      }
      db.run("PRAGMA foreign_keys = OFF");
      execScript(db, readFileSync(sqlPath, "utf-8"));
      db.run("PRAGMA foreign_keys = ON");

      // ---- 4. Overwrite every converted value with the JS-computed cents, so
      // the result cannot depend on SQLite's ROUND matching Math.round.
      for (const plan of plans) {
        const { spec } = plan;
        const update = db.prepare(
          `UPDATE ${spec.table} SET ${spec.newColumn} = ? WHERE id = ?`,
        );
        try {
          for (const row of plan.rows) {
            update.run([row.cents as number | null, row.id]);
          }
        } finally {
          update.free();
        }
      }

      if (corruptForTest) corruptForTest(db);

      // ---- 5. The rebuild must not introduce any NEW referential damage.
      const fkViolations = foreignKeyCheck(db);
      const knownBefore = new Set(fkBefore.map(fkKey));
      const introduced = fkViolations.filter((row) => !knownBefore.has(fkKey(row)));
      if (introduced.length > 0) {
        throw new Error(
          `PRAGMA foreign_key_check reported ${introduced.length} NEW violation(s) ` +
            `introduced by the rebuild: ${JSON.stringify(introduced)}`,
        );
      }

      // ---- 6. Verify in memory, then write, then verify again from disk.
      const verify = (target: Database, phase: string): ColumnReport[] =>
        plans.map((plan) => {
          const { spec } = plan;
          const columns = tableColumns(target, spec.table);
          if (columns.includes(spec.oldColumn)) {
            throw new Error(`${phase}: ${spec.table}.${spec.oldColumn} still exists`);
          }
          if (!columns.includes(spec.newColumn)) {
            throw new Error(`${phase}: ${spec.table}.${spec.newColumn} was not created`);
          }

          const rowCountAfter = rowCount(target, spec.table);
          if (rowCountAfter !== plan.rowCountBefore) {
            throw new Error(
              `${phase}: ${spec.table} row count changed: ` +
                `${plan.rowCountBefore} before, ${rowCountAfter} after`,
            );
          }

          const after = target.exec(
            `SELECT id, ${spec.newColumn}, typeof(${spec.newColumn}) FROM ${spec.table} ORDER BY id`,
          )[0]?.values ?? [];
          if (after.length !== plan.rows.length) {
            throw new Error(
              `${phase}: ${spec.table} returned ${after.length} rows, expected ${plan.rows.length}`,
            );
          }

          const actual: Cents[] = [];
          let nullCountAfter = 0;
          for (let i = 0; i < after.length; i++) {
            const [rawId, rawCents, rawType] = after[i];
            const expected = plan.rows[i];
            const id = Number(rawId);
            if (id !== expected.id) {
              throw new Error(
                `${phase}: ${spec.table} row order/ids changed at index ${i}: ` +
                  `expected id=${expected.id}, got id=${id}`,
              );
            }
            if (rawCents === null || rawCents === undefined) {
              nullCountAfter++;
              if (expected.cents !== null) {
                throw new Error(
                  `${phase}: ${spec.table}.${spec.newColumn} id=${id} is NULL, ` +
                    `expected ${expected.cents}`,
                );
              }
              continue;
            }
            if (rawType !== "integer") {
              throw new Error(
                `${phase}: ${spec.table}.${spec.newColumn} id=${id} is stored as ` +
                  `${String(rawType)}, not integer`,
              );
            }
            const cents = Number(rawCents);
            if (cents !== expected.cents) {
              throw new Error(
                `${phase}: value mismatch in ${spec.table}.${spec.newColumn} id=${id}: ` +
                  `expected ${expected.cents}, found ${cents}`,
              );
            }
            actual.push(cents);
          }

          const sumActualCents = sumCents(actual);
          if (sumActualCents !== plan.sumExpectedCents) {
            throw new Error(
              `${phase}: ${spec.table}.${spec.newColumn} total not conserved: ` +
                `sum(round(old*100))=${plan.sumExpectedCents}, sum(new_cents)=${sumActualCents}`,
            );
          }
          if (nullCountAfter !== plan.nullCountBefore) {
            throw new Error(
              `${phase}: ${spec.table}.${spec.newColumn} NULL count changed: ` +
                `${plan.nullCountBefore} before, ${nullCountAfter} after`,
            );
          }

          return {
            table: spec.table,
            oldColumn: spec.oldColumn,
            newColumn: spec.newColumn,
            rowCountBefore: plan.rowCountBefore,
            rowCountAfter,
            valueCountBefore: plan.rows.length - plan.nullCountBefore,
            nullCountBefore: plan.nullCountBefore,
            nullCountAfter,
            sumExpectedCents: plan.sumExpectedCents,
            sumActualCents,
            sumBeforeFloat: plan.sumBeforeFloat,
            minCents: plan.minCents,
            maxCents: plan.maxCents,
          };
        });

      verify(db, "in-memory check");

      const converted = Buffer.from(db.export());
      // sql.js's export() closes and re-opens the connection, which resets
      // connection-scoped pragmas; put foreign_keys back for anything that
      // keeps using this handle.
      db.run("PRAGMA foreign_keys = ON");

      if (dryRun) {
        log("Dry run: verified but nothing written.");
        return {
          alreadyMigrated: false,
          backupPath,
          report: { dbPath, columns: verify(db, "dry-run recheck") },
          foreignKeyViolations: fkViolations,
          foreignKeyViolationsBefore: fkBefore,
          bytesBefore,
          bytesAfter: converted.length,
        };
      }

      writeFileSync(dbPath, converted);

      // Re-open what actually landed on disk and verify that, not the memory copy.
      db.close();
      db = new SQL.Database(readFileSync(dbPath));
      const columns = verify(db, "post-write check");
      const fkAfterWrite = foreignKeyCheck(db);
      const introducedAfterWrite = fkAfterWrite.filter((row) => !knownBefore.has(fkKey(row)));
      if (introducedAfterWrite.length > 0) {
        throw new Error(
          `PRAGMA foreign_key_check on the written file reported ` +
            `${introducedAfterWrite.length} NEW violation(s)`,
        );
      }

      return {
        alreadyMigrated: false,
        backupPath,
        report: { dbPath, columns },
        foreignKeyViolations: fkAfterWrite,
        foreignKeyViolationsBefore: fkBefore,
        bytesBefore,
        bytesAfter: converted.length,
      };
    } catch (error) {
      restore();
      throw error;
    }
  } finally {
    db.close();
  }
}

/** Renders the before/after conservation report as a fixed-width table. */
export function formatReport(result: MigrateResult): string {
  if (result.alreadyMigrated) {
    return "Already converted to integer cents: no changes made.";
  }

  const lines: string[] = [];
  lines.push(`Database: ${result.report.dbPath}`);
  lines.push(`Size:     ${result.bytesBefore} bytes -> ${result.bytesAfter} bytes`);
  lines.push("");
  const header = [
    "column".padEnd(52),
    "rows".padStart(6),
    "values".padStart(7),
    "nulls".padStart(6),
    "sum(round(old*100))".padStart(21),
    "sum(new_cents)".padStart(16),
    "conserved".padStart(10),
  ].join(" ");
  lines.push(header);
  lines.push("-".repeat(header.length));

  for (const column of result.report.columns) {
    const name = `${column.table}.${column.oldColumn} -> ${column.newColumn}`;
    lines.push(
      [
        name.padEnd(52),
        `${column.rowCountBefore}/${column.rowCountAfter}`.padStart(6),
        String(column.valueCountBefore).padStart(7),
        `${column.nullCountBefore}/${column.nullCountAfter}`.padStart(6),
        String(column.sumExpectedCents).padStart(21),
        String(column.sumActualCents).padStart(16),
        (column.sumExpectedCents === column.sumActualCents ? "YES" : "NO").padStart(10),
      ].join(" "),
    );
  }

  lines.push("");
  lines.push("Detail (float sum before -> exact cents after):");
  for (const column of result.report.columns) {
    lines.push(
      `  ${`${column.table}.${column.newColumn}`.padEnd(36)} ` +
        `float ${column.sumBeforeFloat} -> ${column.sumActualCents} cents ` +
        `(min ${column.minCents ?? "-"}, max ${column.maxCents ?? "-"})`,
    );
  }
  lines.push("");
  lines.push(
    `PRAGMA foreign_key_check: ${result.foreignKeyViolationsBefore.length} pre-existing ` +
      `violation(s) before, ${result.foreignKeyViolations.length} after (0 introduced).`,
  );
  if (result.foreignKeyViolations.length > 0) {
    lines.push(
      "  pre-existing orphans, left exactly as they were: " +
        JSON.stringify(result.foreignKeyViolations),
    );
  }

  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const dbFlag = argv.indexOf("--db");
  const dbPath = path.resolve(
    dbFlag >= 0 && argv[dbFlag + 1]
      ? argv[dbFlag + 1]
      : process.env.BUDGET_DB_PATH || path.join("data", "budget.db"),
  );
  const backupDir = path.resolve(path.dirname(dbPath), "backups");
  const dryRun = argv.includes("--dry-run");

  console.log(`Converting money columns to integer cents`);
  console.log(`  database: ${dbPath}`);
  console.log(`  backups:  ${backupDir}`);
  console.log(`  dry run:  ${dryRun}`);
  console.log("");

  const result = await migrateDatabaseToCents({
    dbPath,
    backupDir,
    dryRun,
    log: (message) => console.log(message),
  });

  console.log("");
  console.log(formatReport(result));
  console.log("");
  if (result.alreadyMigrated) {
    console.log("Nothing to do.");
  } else if (dryRun) {
    console.log("Dry run: conversion verified, nothing written.");
  } else {
    console.log("Conversion verified and saved.");
  }
}

// Only run when invoked directly (`tsx lib/db/migrate-to-cents.ts`), never on import.
if (/migrate-to-cents\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("");
    console.error("MIGRATION FAILED: the database was left unchanged (or restored).");
    console.error(error);
    process.exit(1);
  });
}
