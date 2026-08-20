
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

export type MoneyColumnSpec = {
  table: string;

  oldColumn: string;

  newColumn: string;

  notNull: boolean;
};

export const MONEY_COLUMNS: MoneyColumnSpec[] = [
  { table: "transactions", oldColumn: "amount", newColumn: "amount_cents", notNull: true },
  { table: "assets", oldColumn: "current_value", newColumn: "current_value_cents", notNull: true },
  { table: "asset_history", oldColumn: "value", newColumn: "value_cents", notNull: true },
  { table: "categories", oldColumn: "monthly_limit", newColumn: "monthly_limit_cents", notNull: false },
  { table: "quick_commands", oldColumn: "amount", newColumn: "amount_cents", notNull: true },
];

export type CentsColumnSpec = {
  table: string;
  column: string;
  notNull: boolean;

  since: string;
};

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


export type ColumnReport = {
  table: string;
  oldColumn: string;
  newColumn: string;
  rowCountBefore: number;
  rowCountAfter: number;

  valueCountBefore: number;
  nullCountBefore: number;
  nullCountAfter: number;

  sumExpectedCents: Cents;

  sumActualCents: Cents;

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

  foreignKeyViolations: unknown[][];

  foreignKeyViolationsBefore: unknown[][];
  bytesBefore: number;
  bytesAfter: number;
};

export type MigrateOptions = {
  dbPath: string;
  backupDir: string;

  dryRun?: boolean;

  migrationSqlPath?: string;

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


function foreignKeyCheck(db: Database): unknown[][] {
  db.run("PRAGMA foreign_keys = ON");
  return db.exec("PRAGMA foreign_key_check")[0]?.values ?? [];
}


function fkKey(row: unknown[]): string {
  return row.map((cell) => String(cell)).join("|");
}


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



    const fkBefore = foreignKeyCheck(db);


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



      const sqlPath = path.isAbsolute(migrationSqlPath)
        ? migrationSqlPath
        : path.resolve(process.cwd(), migrationSqlPath);
      if (!existsSync(sqlPath)) {
        throw new Error(`Migration SQL not found at ${sqlPath}`);
      }
      db.run("PRAGMA foreign_keys = OFF");
      execScript(db, readFileSync(sqlPath, "utf-8"));
      db.run("PRAGMA foreign_keys = ON");



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


      const fkViolations = foreignKeyCheck(db);
      const knownBefore = new Set(fkBefore.map(fkKey));
      const introduced = fkViolations.filter((row) => !knownBefore.has(fkKey(row)));
      if (introduced.length > 0) {
        throw new Error(
          `PRAGMA foreign_key_check reported ${introduced.length} NEW violation(s) ` +
            `introduced by the rebuild: ${JSON.stringify(introduced)}`,
        );
      }


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


if (/migrate-to-cents\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("");
    console.error("MIGRATION FAILED: the database was left unchanged (or restored).");
    console.error(error);
    process.exit(1);
  });
}
