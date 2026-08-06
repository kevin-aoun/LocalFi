/**
 * One-shot application of migration 0005 (`net_worth_snapshots.source`,
 * `.source_note`) to an existing budget database.
 *
 * The default target holds the owner's REAL financial history, so this follows
 * the house pattern set by lib/db/migrate-to-cents.ts and
 * lib/db/migrate-to-priced-holdings.ts: its job is not to migrate — 0005's SQL
 * does that — but to REFUSE to leave a damaged file behind.
 *
 *  1. A byte-for-byte backup of the PRE-migration file lands in
 *     data/backups/budget.<timestamp>.pre-0005.db before anything is modified.
 *  2. All work happens on an in-memory copy; nothing is written until every
 *     assertion passes, and what lands on disk is re-opened and verified again.
 *  3. Row counts must be unchanged for every table.
 *  4. Every pre-existing snapshot row must come out byte-identical in its three
 *     money columns AND labelled `source = 'recorded'`. Those rows WERE measured;
 *     0005 must not turn a single one of them into an estimate.
 *  5. On any failure the backup is copied back and the error is rethrown.
 *  6. Running it twice is a reported no-op, not an error.
 *
 * ⚠ SINGLE WRITER. lib/db/client.ts keeps the whole database in memory and
 * flushes the file wholesale, so a running app (the Docker stack points at
 * ./data) can overwrite anything this changes underneath it. STOP THE STACK
 * before pointing this at the live file.
 */
import initSqlJs, { type Database } from "sql.js";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Cents } from "@/lib/money";

export const MIGRATION_0005_SQL_PATH = path.join(
  "drizzle",
  "migrations",
  "0005_reconstructed_net_worth.sql",
);

const PRESERVED_TABLES = [
  "transactions",
  "categories",
  "assets",
  "asset_history",
  "accounts",
  "budgets",
  "recurring_transactions",
  "net_worth_snapshots",
  "quick_commands",
  "settings",
  "visited_countries",
] as const;

const NEW_COLUMNS = [
  { column: "source", type: "text", notNull: true },
  { column: "source_note", type: "text", notNull: false },
] as const;

export type SnapshotRow = {
  id: number;
  date: string;
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
};

export type Migrate0005Result = {
  alreadyMigrated: boolean;
  dbPath: string;
  backupPath: string | null;
  countsBefore: Record<string, number>;
  countsAfter: Record<string, number>;
  snapshotsBefore: SnapshotRow[];
  /** Rows the ALTER labelled 'recorded' — i.e. every row that already existed. */
  labelledRecorded: number;
};

export type Migrate0005Options = {
  dbPath: string;
  backupDir: string;
  dryRun?: boolean;
  migrationSqlPath?: string;
  /** Test seam: damage the migrated image to prove the verification bites. */
  corruptForTest?: (db: Database) => void;
  log?: (message: string) => void;
};

function rows(db: Database, sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

function scalar(db: Database, sql: string): unknown {
  return rows(db, sql)[0]?.[0] ?? null;
}

function tableNames(db: Database): Set<string> {
  return new Set(rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r[0])));
}

function columnNames(db: Database, table: string): Set<string> {
  return new Set(rows(db, `PRAGMA table_info(${table})`).map((r) => String(r[1])));
}

function columnSpec(db: Database, table: string, column: string) {
  const row = rows(db, `PRAGMA table_info(${table})`).find((r) => String(r[1]) === column);
  return row ? { type: String(row[2]).toLowerCase(), notNull: Number(row[3]) === 1 } : null;
}

function counts(db: Database): Record<string, number> {
  const present = tableNames(db);
  const out: Record<string, number> = {};
  for (const table of PRESERVED_TABLES) {
    if (present.has(table)) out[table] = Number(scalar(db, `SELECT COUNT(*) FROM ${table}`) ?? 0);
  }
  return out;
}

function readSnapshots(db: Database): SnapshotRow[] {
  return rows(
    db,
    `SELECT id, date, total_assets_cents, total_liabilities_cents, net_worth_cents
     FROM net_worth_snapshots ORDER BY id`,
  ).map((r) => ({
    id: Number(r[0]),
    date: String(r[1]),
    totalAssetsCents: Number(r[2]),
    totalLiabilitiesCents: Number(r[3]),
    netWorthCents: Number(r[4]),
  }));
}

function execScript(db: Database, sql: string) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

/** pre-0005 | post-0005, refusing a half-applied state. */
export function detect0005State(db: Database): "pre-0005" | "post-0005" {
  if (!tableNames(db).has("net_worth_snapshots")) {
    throw new Error(
      "This database has no net_worth_snapshots table. Apply migration 0003 (accounts and " +
        "net-worth history) before 0005.",
    );
  }
  const present = NEW_COLUMNS.filter((spec) => columnNames(db, "net_worth_snapshots").has(spec.column));
  if (present.length === 0) return "pre-0005";
  if (present.length === NEW_COLUMNS.length) return "post-0005";
  throw new Error(
    "Refusing to run: net_worth_snapshots is half-migrated (" +
      `present: ${present.map((p) => p.column).join(", ")}). Restore a backup from data/backups/ and re-run.`,
  );
}

export async function migrateDatabaseTo0005(options: Migrate0005Options): Promise<Migrate0005Result> {
  const {
    dbPath,
    backupDir,
    dryRun = false,
    migrationSqlPath = MIGRATION_0005_SQL_PATH,
    corruptForTest,
    log = () => {},
  } = options;

  if (!existsSync(dbPath)) throw new Error(`Database not found at ${dbPath}`);
  if (statSync(dbPath).size === 0) throw new Error(`Database at ${dbPath} is empty (0 bytes)`);

  const SQL = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules/sql.js/dist", file),
  });
  const originalBytes = readFileSync(dbPath);
  let db = new SQL.Database(originalBytes);

  try {
    if (detect0005State(db) === "post-0005") {
      log("Already migrated: net_worth_snapshots.source and .source_note both exist.");
      const now = counts(db);
      return {
        alreadyMigrated: true,
        dbPath,
        backupPath: null,
        countsBefore: now,
        countsAfter: now,
        snapshotsBefore: readSnapshots(db),
        labelledRecorded: Number(
          scalar(db, "SELECT COUNT(*) FROM net_worth_snapshots WHERE source = 'recorded'") ?? 0,
        ),
      };
    }

    const countsBefore = counts(db);
    const snapshotsBefore = readSnapshots(db);

    let backupPath: string | null = null;
    if (!dryRun) {
      mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = path.join(backupDir, `budget.${stamp}.pre-0005.db`);
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
      if (!existsSync(sqlPath)) throw new Error(`Migration SQL not found at ${sqlPath}`);

      db.run("PRAGMA foreign_keys = OFF");
      execScript(db, readFileSync(sqlPath, "utf-8"));
      db.run("PRAGMA foreign_keys = ON");

      if (corruptForTest) corruptForTest(db);

      const verify = (target: Database, phase: string) => {
        for (const spec of NEW_COLUMNS) {
          const column = columnSpec(target, "net_worth_snapshots", spec.column);
          if (!column) throw new Error(`${phase}: net_worth_snapshots.${spec.column} was not added`);
          if (column.type !== spec.type) {
            throw new Error(
              `${phase}: net_worth_snapshots.${spec.column} is ${column.type}, expected ${spec.type}`,
            );
          }
          if (column.notNull !== spec.notNull) {
            throw new Error(
              `${phase}: net_worth_snapshots.${spec.column} notNull is ${column.notNull}, expected ${spec.notNull}`,
            );
          }
        }

        const countsAfter = counts(target);
        for (const table of Object.keys(countsBefore)) {
          if (countsAfter[table] !== countsBefore[table]) {
            throw new Error(
              `${phase}: ${table} row count changed: ${countsBefore[table]} -> ${countsAfter[table]}`,
            );
          }
        }

        // Every row that already existed was MEASURED. It must survive untouched
        // and be labelled 'recorded' — never silently downgraded to an estimate.
        const after = readSnapshots(target);
        if (after.length !== snapshotsBefore.length) {
          throw new Error(`${phase}: net_worth_snapshots row count changed`);
        }
        for (let i = 0; i < snapshotsBefore.length; i++) {
          const before = snapshotsBefore[i];
          const now = after[i];
          if (
            now.id !== before.id ||
            now.date !== before.date ||
            now.totalAssetsCents !== before.totalAssetsCents ||
            now.totalLiabilitiesCents !== before.totalLiabilitiesCents ||
            now.netWorthCents !== before.netWorthCents
          ) {
            throw new Error(
              `${phase}: snapshot ${before.id} changed: ${JSON.stringify(before)} -> ${JSON.stringify(now)}`,
            );
          }
        }

        const labelledRecorded = Number(
          scalar(target, "SELECT COUNT(*) FROM net_worth_snapshots WHERE source = 'recorded'") ?? 0,
        );
        if (labelledRecorded !== snapshotsBefore.length) {
          throw new Error(
            `${phase}: ${snapshotsBefore.length} pre-existing snapshot(s) but only ${labelledRecorded} ` +
              `are labelled 'recorded'`,
          );
        }
        const notes = Number(
          scalar(target, "SELECT COUNT(*) FROM net_worth_snapshots WHERE source_note IS NOT NULL") ?? 0,
        );
        if (notes !== 0) {
          throw new Error(`${phase}: ${notes} row(s) gained a source_note, but this migration writes none`);
        }

        const fk = rows(target, "PRAGMA foreign_key_check");
        if (fk.length > 0) {
          throw new Error(`${phase}: PRAGMA foreign_key_check reported ${fk.length} violation(s)`);
        }

        return { countsAfter, labelledRecorded };
      };

      const inMemory = verify(db, "in-memory check");
      const migrated = Buffer.from(db.export());
      db.run("PRAGMA foreign_keys = ON"); // export() re-opened the connection

      if (dryRun) {
        log("Dry run: verified but nothing written.");
        return {
          alreadyMigrated: false,
          dbPath,
          backupPath,
          countsBefore,
          countsAfter: inMemory.countsAfter,
          snapshotsBefore,
          labelledRecorded: inMemory.labelledRecorded,
        };
      }

      writeFileSync(dbPath, migrated);
      db.close();
      db = new SQL.Database(readFileSync(dbPath));
      const onDisk = verify(db, "post-write check");

      return {
        alreadyMigrated: false,
        dbPath,
        backupPath,
        countsBefore,
        countsAfter: onDisk.countsAfter,
        snapshotsBefore,
        labelledRecorded: onDisk.labelledRecorded,
      };
    } catch (error) {
      restore();
      throw error;
    }
  } finally {
    db.close();
  }
}

export function format0005Report(result: Migrate0005Result): string {
  if (result.alreadyMigrated) {
    return `Already migrated: net_worth_snapshots.source exists (${result.labelledRecorded} recorded row(s)).`;
  }
  const lines: string[] = [];
  lines.push(`Database: ${result.dbPath}`);
  if (result.backupPath) lines.push(`Backup:   ${result.backupPath}`);
  lines.push("");
  lines.push("Row counts (must be unchanged):");
  for (const table of Object.keys(result.countsBefore)) {
    const before = result.countsBefore[table];
    const after = result.countsAfter[table];
    lines.push(
      `  ${table.padEnd(24)} ${String(before).padStart(6)} -> ${String(after).padStart(6)} ` +
        `${before === after ? "ok" : "CHANGED"}`,
    );
  }
  lines.push("");
  lines.push(
    `${result.snapshotsBefore.length} pre-existing snapshot(s), all labelled 'recorded' ` +
      `(${result.labelledRecorded} verified). Their figures are byte-identical.`,
  );
  return lines.join("\n");
}
