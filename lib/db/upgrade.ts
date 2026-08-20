import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { WriterLease } from "./writer-lease";

export const SCHEMA_JOURNAL_TABLE = "localfi_schema_journal";

const MIGRATIONS_DIRECTORY = path.resolve(process.cwd(), "drizzle", "migrations");
const DRIZZLE_JOURNAL_PATH = path.join(MIGRATIONS_DIRECTORY, "meta", "_journal.json");

type DrizzleJournalEntry = { idx: number; tag: string };
type MigrationEntry = DrizzleJournalEntry & { checksum: string; sql: string };
type SchemaState = "applied" | "absent" | "partial";

const COMPATIBLE_MIGRATION_CHECKSUMS = new Map<number, ReadonlySet<string>>([
  [9, new Set(["d4b22ffa8ffa059a5bd703a3473dfa4e681d75cdbd583a6bf28f41cf69ae18d5"])],
  [12, new Set(["b11b611f8015645fceceb39cd02ac7c6dad5150cfd94acc7ee3756c35d3d0e3b"])],
]);

export type UpgradeDatabaseResult = {
  dbPath: string;
  backupPath: string | null;
  changed: boolean;
  dryRun: boolean;
  adopted: string[];
  applied: string[];
  pending: string[];
};

export class DatabaseUpgradeError extends Error {
  readonly dbPath: string;
  readonly backupPath: string | null;

  constructor(dbPath: string, backupPath: string | null, detail: string) {
    super(
      `Database upgrade failed for ${dbPath}: ${detail}. ` +
        (backupPath
          ? `The pre-upgrade database is recoverable at ${backupPath}.`
          : "The original database was not replaced."),
    );
    this.name = "DatabaseUpgradeError";
    this.dbPath = dbPath;
    this.backupPath = backupPath;
  }
}

function loadMigrationEntries(): MigrationEntry[] {
  const journal = JSON.parse(readFileSync(DRIZZLE_JOURNAL_PATH, "utf8")) as {
    entries: DrizzleJournalEntry[];
  };
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  if (entries.some((entry, index) => entry.idx !== index)) {
    throw new Error("The Drizzle migration journal is not a contiguous zero-based sequence");
  }
  return entries.map((entry) => {
    if (!/^\d{4}_[a-z0-9_-]+$/i.test(entry.tag)) {
      throw new Error(`Unsafe migration tag in Drizzle journal: ${entry.tag}`);
    }
    const sql = readFileSync(path.join(MIGRATIONS_DIRECTORY, `${entry.tag}.sql`), "utf8");
    return {
      ...entry,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  });
}

function tableExists(db: Database, table: string): boolean {
  const statement = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  );
  try {
    statement.bind([table]);
    return statement.step();
  } finally {
    statement.free();
  }
}

function triggerExists(db: Database, trigger: string): boolean {
  const statement = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ? LIMIT 1",
  );
  try {
    statement.bind([trigger]);
    return statement.step();
  } finally {
    statement.free();
  }
}

function indexExists(db: Database, index: string): boolean {
  const statement = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1",
  );
  try {
    statement.bind([index]);
    return statement.step();
  } finally {
    statement.free();
  }
}

function columns(db: Database, table: string): Set<string> {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
  if (!tableExists(db, table)) return new Set();
  return new Set(
    (db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((row) => String(row[1])),
  );
}

function tableDefinition(db: Database, table: string): string {
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

function allOrNone(values: boolean[]): SchemaState {
  if (values.every(Boolean)) return "applied";
  if (values.every((value) => !value)) return "absent";
  return "partial";
}

function migrationState(db: Database, idx: number): SchemaState {
  const transactionColumns = columns(db, "transactions");
  switch (idx) {
    case 0: {
      return allOrNone(
        [
          "categories",
          "transactions",
          "assets",
          "asset_history",
          "quick_commands",
          "settings",
        ].map((table) => tableExists(db, table)),
      );
    }
    case 1:
      return tableExists(db, "transactions")
        ? allOrNone([
            transactionColumns.has("pending"),
            tableExists(db, "visited_countries"),
          ])
        : "absent";
    case 2: {
      if (!tableExists(db, "transactions")) return "absent";
      const oldColumns = [
        columns(db, "categories").has("monthly_limit"),
        transactionColumns.has("amount"),
        columns(db, "assets").has("current_value"),
        columns(db, "asset_history").has("value"),
        columns(db, "quick_commands").has("amount"),
      ];
      const centsColumns = [
        columns(db, "categories").has("monthly_limit_cents"),
        transactionColumns.has("amount_cents"),
        columns(db, "assets").has("current_value_cents"),
        columns(db, "asset_history").has("value_cents"),
        columns(db, "quick_commands").has("amount_cents"),
      ];
      if (centsColumns.every(Boolean) && oldColumns.every((value) => !value)) return "applied";
      if (oldColumns.every(Boolean) && centsColumns.every((value) => !value)) return "absent";
      return "partial";
    }
    case 3:
      return allOrNone([
        tableExists(db, "accounts"),
        tableExists(db, "budgets"),
        tableExists(db, "recurring_transactions"),
        tableExists(db, "net_worth_snapshots"),
        transactionColumns.has("account_id"),
        transactionColumns.has("transfer_account_id"),
        transactionColumns.has("recurring_id"),
        transactionColumns.has("recurring_occurrence"),
      ]);
    case 4:
      return allOrNone([
        columns(db, "assets").has("price_symbol"),
        columns(db, "assets").has("priced_at"),
      ]);
    case 5:
      return allOrNone([
        columns(db, "net_worth_snapshots").has("source"),
        columns(db, "net_worth_snapshots").has("source_note"),
      ]);
    case 6:
      return tableExists(db, "budget_reallocations") ? "applied" : "absent";
    case 7:
      return tableExists(db, "travel_checkpoints") ? "applied" : "absent";
    case 8:
      return columns(db, "travel_checkpoints").has("origin_city_id") ? "applied" : "absent";
    case 9: {
      const accountSql = tableDefinition(db, "accounts");
      const transactionSql = tableDefinition(db, "transactions");
      const markers = [
        columns(db, "accounts").has("opening_balance_date"),
        transactionColumns.has("direction"),
        transactionColumns.has("currency"),
        accountSql.includes("accounts_opening_balance_magnitude"),
        accountSql.includes("accounts_opening_balance_date_valid"),
        transactionSql.includes("transactions_amount_magnitude"),
        transactionSql.includes("transactions_direction_valid"),
        triggerExists(db, "transactions_fill_legacy_semantics"),
        triggerExists(db, "transactions_reject_legacy_update"),
        triggerExists(db, "transactions_reject_cross_currency_insert"),
        triggerExists(db, "transactions_reject_cross_currency_update"),
        triggerExists(db, "accounts_reject_active_currency_change"),
      ];
      return allOrNone(markers);
    }
    case 10: {
      const markers = [
        columns(db, "assets").has("archived"),
        columns(db, "asset_history").has("currency"),
        columns(db, "asset_history").has("recorded_day"),
        columns(db, "net_worth_snapshots").has("currency"),
        (() => {
          const statement = db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' " +
              "AND name = 'asset_history_asset_day_unique' LIMIT 1",
          );
          try {
            return statement.step();
          } finally {
            statement.free();
          }
        })(),
        tableDefinition(db, "asset_history").includes("asset_history_currency_valid"),
        tableDefinition(db, "asset_history").includes("asset_history_recorded_day_valid"),
      ];
      return allOrNone(markers);
    }
    case 11: {
      const budgetSql = tableDefinition(db, "budgets");
      return allOrNone([
        columns(db, "budgets").has("goal_name"),
        columns(db, "budgets").has("goal_amount_cents"),
        budgetSql.includes("budgets_goal_valid"),
      ]);
    }
    case 12: {
      const transactionColumns = columns(db, "transactions");
      const assetColumns = columns(db, "assets");
      return allOrNone([
        tableExists(db, "instruments"),
        tableExists(db, "instrument_observations"),
        tableExists(db, "ledger_accounts"),
        tableExists(db, "ledger_events"),
        tableExists(db, "ledger_movements"),
        tableExists(db, "ledger_projection_state"),
        tableExists(db, "instrument_positions"),
        tableExists(db, "transaction_allocations"),
        indexExists(db, "instruments_kind_symbol_idx"),
        transactionColumns.has("current_event_id"),
        transactionColumns.has("instrument_id"),
        transactionColumns.has("quantity_delta"),
        transactionColumns.has("transfer_principal_amount_cents"),
        assetColumns.has("instrument_id"),
        triggerExists(db, "ledger_events_validate_insert"),
        triggerExists(db, "ledger_events_seal_movements"),
        triggerExists(db, "ledger_events_immutable_update"),
        triggerExists(db, "ledger_movements_immutable_delete"),
      ]);
    }
    case 13:
      return columns(db, "settings").has("show_ledger") ? "applied" : "absent";
    case 14:
      return allOrNone([
        columns(db, "categories").has("display_order"),
        indexExists(db, "categories_type_display_order_idx"),
      ]);
    case 15:
      return allOrNone([
        columns(db, "budgets").has("display_order"),
        indexExists(db, "budgets_display_order_idx"),
      ]);
    default:
      throw new Error(
        `Migration ${String(idx).padStart(4, "0")} has no upgrade verifier; ` +
          "add one before placing it in the journal",
      );
  }
}

function assertImmutableLedgerSemanticBackfillComplete(db: Database): void {
  const confirmedWithoutEvents = Number(
    db.exec(
      "SELECT COUNT(*) FROM transactions WHERE pending = 0 AND current_event_id IS NULL",
    )[0]?.values[0]?.[0] ?? 0,
  );
  const holdingsWithoutInstruments = Number(
    db.exec(
      "SELECT COUNT(*) FROM assets WHERE category <> 'Cash' AND instrument_id IS NULL",
    )[0]?.values[0]?.[0] ?? 0,
  );
  const legacyFacts = Number(
    db.exec(
      `SELECT
         (SELECT COUNT(*) FROM accounts WHERE opening_balance_cents <> 0) +
         (SELECT COUNT(*) FROM transactions WHERE pending = 0) +
         (SELECT COUNT(*) FROM assets WHERE category <> 'Cash')`,
    )[0]?.values[0]?.[0] ?? 0,
  );
  const eventCount = Number(
    db.exec("SELECT COUNT(*) FROM ledger_events")[0]?.values[0]?.[0] ?? 0,
  );
  if (
    confirmedWithoutEvents > 0 || holdingsWithoutInstruments > 0 ||
    (legacyFacts > 0 && eventCount === 0)
  ) {
    throw new Error(
      "Migration 0012_immutable-ledger has SQL schema without its TypeScript semantic backfill; " +
        "restore the pre-0012 database or a pre-upgrade backup, then rerun the supported db:upgrade command",
    );
  }
}

function detectAppliedPrefix(db: Database, entries: MigrationEntry[]): number {
  let count = 0;
  let foundAbsent = false;
  for (const entry of entries) {
    const state = migrationState(db, entry.idx);
    if (state === "partial") {
      throw new Error(
        `Schema is partially migrated at ${entry.tag}; restore a pre-migration backup and retry`,
      );
    }
    if (state === "absent") {
      foundAbsent = true;
      continue;
    }
    if (foundAbsent) {
      throw new Error(`Schema has ${entry.tag} without all earlier migrations`);
    }




    if (entry.idx === 12) assertImmutableLedgerSemanticBackfillComplete(db);
    count += 1;
  }
  return count;
}

function createSchemaJournal(db: Database) {
  db.exec(`
    CREATE TABLE ${SCHEMA_JOURNAL_TABLE} (
      idx integer PRIMARY KEY NOT NULL,
      tag text NOT NULL UNIQUE,
      checksum text NOT NULL,
      origin text NOT NULL CHECK(origin IN ('adopted', 'applied')),
      applied_at integer DEFAULT (unixepoch()) NOT NULL
    )
  `);
}

function journalRows(db: Database): Array<{
  idx: number;
  tag: string;
  checksum: string;
}> {
  if (!tableExists(db, SCHEMA_JOURNAL_TABLE)) return [];
  const required = ["idx", "tag", "checksum", "origin", "applied_at"];
  const actual = columns(db, SCHEMA_JOURNAL_TABLE);
  if (!required.every((column) => actual.has(column))) {
    throw new Error(`${SCHEMA_JOURNAL_TABLE} has an unsupported shape`);
  }
  return (db.exec(`SELECT idx, tag, checksum FROM ${SCHEMA_JOURNAL_TABLE} ORDER BY idx`)[0]
    ?.values ?? [])
    .map((row) => ({ idx: Number(row[0]), tag: String(row[1]), checksum: String(row[2]) }));
}

function validateJournalPrefix(db: Database, entries: MigrationEntry[]): number {
  const rows = journalRows(db);
  if (rows.length > entries.length) {
    throw new Error("Database journal is newer than this LocalFi build");
  }
  rows.forEach((row, index) => {
    const expected = entries[index];
    if (
      !expected ||
      row.idx !== expected.idx ||
      row.tag !== expected.tag ||
      row.checksum !== expected.checksum &&
        !COMPATIBLE_MIGRATION_CHECKSUMS.get(row.idx)?.has(row.checksum)
    ) {
      throw new Error(
        `Database journal diverges at index ${index}; expected ${expected?.tag ?? "no entry"}, ` +
          `found ${row.tag}`,
      );
    }
  });

  entries.forEach((entry, index) => {
    const state = migrationState(db, entry.idx);
    const expectedState = index < rows.length ? "applied" : "absent";
    if (state !== expectedState) {
      throw new Error(
        `Database journal/schema mismatch at ${entry.tag}: journal expects ${expectedState}, ` +
          `schema is ${state}`,
      );
    }
  });
  return rows.length;
}

function insertJournalEntry(db: Database, entry: MigrationEntry, origin: "adopted" | "applied") {
  db.run(
    `INSERT INTO ${SCHEMA_JOURNAL_TABLE} (idx, tag, checksum, origin) VALUES (?, ?, ?, ?)`,
    [entry.idx, entry.tag, entry.checksum, origin],
  );
}

function userTableCounts(db: Database): Record<string, number> {
  const tables = (
    db.exec(
      "SELECT name FROM sqlite_master " +
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )[0]?.values ?? []
  ).map((row) => String(row[0]));
  return Object.fromEntries(
    tables.map((table) => {
      if (!/^[a-z_]+$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
      return [table, Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] ?? 0)];
    }),
  );
}

function assertExistingRowsPreserved(
  db: Database,
  before: Record<string, number>,
  migrationTag: string,
) {
  for (const [table, expected] of Object.entries(before)) {
    if (!tableExists(db, table)) throw new Error(`${migrationTag} removed existing table ${table}`);
    const actual = Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] ?? 0);
    if (actual !== expected) {
      throw new Error(
        `${migrationTag} changed ${table} row count from ${expected} to ${actual}`,
      );
    }
  }
}

function executeMigrationSql(db: Database, sql: string) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

async function applyOwnedMigration(
  db: Database,
  SQL: SqlJsStatic,
  migrationIndex: 9 | 10 | 12,
): Promise<Database> {
  if (migrationIndex === 12) {
    const entries = loadMigrationEntries();
    const entry = entries.find((candidate) => candidate.idx === 12);
    if (!entry) throw new Error("Migration 0012 is absent from the journal");
    const { applyImmutableLedgerMigration } = await import("./migrate-to-immutable-ledger");
    applyImmutableLedgerMigration(db, entry.sql);
    return db;
  }
  const migrationId = String(migrationIndex).padStart(4, "0");
  const stagingDirectory = mkdtempSync(path.join(os.tmpdir(), `localfi-upgrade-${migrationId}-`));
  const stagingPath = path.join(stagingDirectory, "budget.db");
  try {
    writeFileSync(stagingPath, Buffer.from(db.export()), { mode: 0o600 });
    if (migrationIndex === 9) {
      const { migrateToLedgerSemantics } = await import("./migrate-to-ledger-semantics");
      await migrateToLedgerSemantics({ dbPath: stagingPath });
    } else {
      const { migrateToCurrencySafeHoldings } = await import(
        "./migrate-to-currency-safe-holdings"
      );
      await migrateToCurrencySafeHoldings({ dbPath: stagingPath });
    }
    const migrated = new SQL.Database(readFileSync(stagingPath));
    db.close();
    return migrated;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

async function applyMigration(
  db: Database,
  SQL: SqlJsStatic,
  entry: MigrationEntry,
): Promise<Database> {
  const countsBefore = userTableCounts(db);
  const migrated = entry.idx === 9 || entry.idx === 10 || entry.idx === 12
    ? await applyOwnedMigration(db, SQL, entry.idx)
    : (executeMigrationSql(db, entry.sql), db);
  migrated.run("PRAGMA foreign_keys = ON");
  if (migrationState(migrated, entry.idx) !== "applied") {
    throw new Error(`${entry.tag} did not produce its required schema`);
  }



  if (entry.idx !== 10) assertExistingRowsPreserved(migrated, countsBefore, entry.tag);
  if (entry.idx === 12) {
    const { rebuildCashAssetProjectionRaw } = await import("../ledger/rebuild");
    rebuildCashAssetProjectionRaw(migrated);
  }
  insertJournalEntry(migrated, entry, "applied");
  return migrated;
}

function assertDatabaseHealthy(db: Database) {
  db.run("PRAGMA foreign_keys = ON");
  const integrity = db.exec("PRAGMA integrity_check")[0]?.values ?? [];
  if (integrity.length !== 1 || String(integrity[0][0]).toLowerCase() !== "ok") {
    throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity)}`);
  }
  const foreignKeys = db.exec("PRAGMA foreign_key_check")[0]?.values ?? [];
  if (foreignKeys.length > 0) {
    throw new Error(`Foreign-key verification failed: ${JSON.stringify(foreignKeys)}`);
  }
}

function fsyncFile(file: string) {
  const fd = openSync(file, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(directory: string) {
  try {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {

  }
}

let fileCounter = 0;

function writeBytesAtomically(file: string, bytes: Buffer) {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.upgrade-${process.pid}-${++fileCounter}.tmp`,
  );
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, bytes, 0, bytes.length, 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    fsyncDirectory(directory);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {

    }
    throw error;
  }
}

function createBackup(dbPath: string, originalBytes: Buffer, firstPendingTag: string): string {
  const backupDirectory = path.join(path.dirname(dbPath), "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basename = path.basename(dbPath, path.extname(dbPath));
  const backupPath = path.join(
    backupDirectory,
    `${basename}.${stamp}.${process.pid}.pre-upgrade-${firstPendingTag}.db`,
  );
  writeFileSync(backupPath, originalBytes, { flag: "wx", mode: 0o600 });
  fsyncFile(backupPath);
  fsyncDirectory(backupDirectory);
  return backupPath;
}

function normalizeLegacyBaseline(db: Database): boolean {
  const coreTables = [
    "categories",
    "transactions",
    "assets",
    "asset_history",
    "quick_commands",
    "settings",
  ];
  if (!coreTables.every((table) => tableExists(db, table))) {
    return false;
  }
  const hasPending = columns(db, "transactions").has("pending");
  const hasVisitedCountries = tableExists(db, "visited_countries");



  if (hasPending === hasVisitedCountries) return false;
  if (!hasVisitedCountries) {
    db.exec(`
      CREATE TABLE visited_countries (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        country_code text NOT NULL,
        country_name text NOT NULL,
        visited_at text DEFAULT (current_timestamp)
      );
      CREATE UNIQUE INDEX visited_countries_country_code_unique
        ON visited_countries (country_code);
    `);
  }
  if (!hasPending) {
    db.exec("ALTER TABLE transactions ADD pending integer DEFAULT false NOT NULL");
  }
  return true;
}

function verifyReadyDatabase(db: Database, entries: MigrationEntry[]) {
  const count = validateJournalPrefix(db, entries);
  if (count !== entries.length) {
    throw new Error(`Only ${count} of ${entries.length} supported migrations are journaled`);
  }
  assertDatabaseHealthy(db);
}


export async function upgradeDatabase(options: {
  dbPath: string;
  dryRun?: boolean;
  lease: WriterLease;
}): Promise<UpgradeDatabaseResult> {
  const dbPath = path.resolve(options.dbPath);
  if (path.resolve(options.lease.dbPath) !== dbPath) {
    throw new Error(
      `Writer lease for ${options.lease.dbPath} cannot upgrade a different database at ${dbPath}`,
    );
  }
  options.lease.assertOwned();
  const dryRun = options.dryRun ?? false;
  const entries = loadMigrationEntries();
  const hadOriginal = existsSync(dbPath);
  if (hadOriginal && !statSync(dbPath).isFile()) {
    throw new DatabaseUpgradeError(dbPath, null, "the target is not a regular file");
  }
  const originalBytes = hadOriginal ? readFileSync(dbPath) : Buffer.alloc(0);
  const SQL = await initSqlJs({
    locateFile: (file) => path.resolve(process.cwd(), "node_modules/sql.js/dist", file),
  });
  let db: Database;
  try {


    db = originalBytes.length > 0
      ? new SQL.Database(Uint8Array.from(originalBytes))
      : new SQL.Database();
    db.exec("SELECT name FROM sqlite_master LIMIT 1");
  } catch (error) {
    throw new DatabaseUpgradeError(dbPath, null, (error as Error).message);
  }

  let backupPath: string | null = null;
  const adopted: string[] = [];
  const applied: string[] = [];
  try {
    const hasJournal = tableExists(db, SCHEMA_JOURNAL_TABLE);
    const normalizedLegacyBaseline = !hasJournal && normalizeLegacyBaseline(db);
    const appliedCount = hasJournal
      ? validateJournalPrefix(db, entries)
      : detectAppliedPrefix(db, entries);
    const pending = entries.slice(appliedCount);
    const changed = !hasJournal || normalizedLegacyBaseline || pending.length > 0;

    if (changed && originalBytes.length > 0 && !dryRun) {
      options.lease.assertOwned();
      backupPath = createBackup(
        dbPath,
        originalBytes,
        pending[0]?.tag ?? "schema-journal",
      );
    }

    if (!hasJournal) {
      createSchemaJournal(db);
      for (const entry of entries.slice(0, appliedCount)) {
        insertJournalEntry(db, entry, "adopted");
        adopted.push(entry.tag);
      }
    }

    for (const entry of pending) {
      db = await applyMigration(db, SQL, entry);
      applied.push(entry.tag);
    }
    verifyReadyDatabase(db, entries);

    if (changed && !dryRun) {
      options.lease.assertOwned();
      const upgradedBytes = Buffer.from(db.export());
      writeBytesAtomically(dbPath, upgradedBytes);
      options.lease.assertOwned();
      const persisted = new SQL.Database(readFileSync(dbPath));
      try {
        verifyReadyDatabase(persisted, entries);
      } finally {
        persisted.close();
      }
    }

    return {
      dbPath,
      backupPath,
      changed,
      dryRun,
      adopted,
      applied,
      pending: pending.map((entry) => entry.tag),
    };
  } catch (error) {
    if (!dryRun) {
      try {
        if (hadOriginal) {
          const recoveryBytes = backupPath ? readFileSync(backupPath) : originalBytes;
          writeBytesAtomically(dbPath, recoveryBytes);
        } else if (existsSync(dbPath)) {
          unlinkSync(dbPath);
        }
      } catch (restoreError) {
        throw new DatabaseUpgradeError(
          dbPath,
          backupPath,
          `${(error as Error).message}; automatic restore also failed: ${(restoreError as Error).message}`,
        );
      }
    }
    throw new DatabaseUpgradeError(dbPath, backupPath, (error as Error).message);
  } finally {
    try {
      db.close();
    } catch {

    }
  }
}
