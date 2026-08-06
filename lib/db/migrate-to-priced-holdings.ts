/**
 * One-shot application of migration 0004 (priced holdings: `assets.price_symbol`
 * and `assets.priced_at`) to an existing budget database.
 *
 *   npx tsx lib/db/migrate-to-priced-holdings.ts [--db <path>] [--dry-run]
 *
 * The database this points at by default holds the owner's REAL financial
 * history, so this script is written the same way lib/db/migrate-to-cents.ts and
 * lib/db/migrate-to-accounts.ts are: its job is not to migrate — 0004's SQL does
 * that — but to REFUSE to leave a damaged file behind.
 *
 *  1. A byte-for-byte backup of the PRE-migration file is written to
 *     data/backups/budget.<timestamp>.pre-0004.db before anything is modified.
 *  2. All work happens on an in-memory copy. Nothing is written to the live path
 *     until every assertion has passed, and what lands on disk is re-opened and
 *     verified AGAIN.
 *  3. Row counts must be unchanged for every table — `asset_history` very much
 *     included, because `asset_history.asset_id` REFERENCES assets ON DELETE
 *     CASCADE and a careless rebuild of `assets` would cascade real history away.
 *     (0004 adds two nullable columns and does NOT rebuild any table, which is
 *     the cheapest possible way to be safe here.)
 *  4. Every asset row must be IDENTICAL except for the two new columns: value,
 *     currency, category, commodity_type, quantity, unit, notes, timestamps. In
 *     particular `quantity` is compared exactly — 1.1376 troy ounces must not
 *     become 1.14.
 *  5. The derived cash balance — computed with the app's own single rule,
 *     `deriveCashBalanceCents` — must be IDENTICAL before and after, and equal to
 *     an expected value when one is supplied (449618 = $4,496.18 for the live
 *     file). The sum of `transactions.amount_cents` and of
 *     `assets.current_value_cents` must be conserved too.
 *  6. `PRAGMA foreign_key_check` must introduce no NEW violations. 0003 repaired
 *     the two long-standing `category_id = 0` orphans, so on the live file this
 *     should be 0 before and 0 after — verified, not assumed.
 *  7. Every metals row must come out pointing at the right symbol, and no
 *     non-commodity row may acquire one.
 *  8. If ANY of that fails, the backup is copied back over the live file and the
 *     script throws.
 *  9. Running it twice is refused: an already-migrated schema is detected and the
 *     file is left untouched.
 *
 * Like its predecessors this opens its own sql.js handle instead of going through
 * lib/db/client.ts: it must control the `foreign_keys` pragma itself and must not
 * disturb the process-cached connection. Note that `Database.export()` internally
 * closes and re-opens the connection, silently resetting connection-scoped
 * pragmas — so `PRAGMA foreign_keys = ON` is re-applied after every export.
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

import { deriveCashBalanceCents } from "@/lib/cash-balance";
import { formatMoney, type Cents } from "@/lib/money";
import { priceSymbolForCommodityType } from "@/lib/prices";

const MIGRATION_SQL_PATH = path.join("drizzle", "migrations", "0004_priced_holdings.sql");

/** Tables whose row count must be identical before and after. */
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

/** The columns 0004 adds. */
const NEW_COLUMNS = [
  { column: "price_symbol", type: "text" },
  { column: "priced_at", type: "integer" },
] as const;

export type TableCounts = Record<string, number>;

/** Everything about an asset row that 0004 must NOT change. */
export type AssetRow = {
  id: number;
  category: string;
  currentValueCents: Cents;
  currency: string;
  notes: string | null;
  commodityType: string | null;
  quantity: number | null;
  unit: string | null;
  linkedTransactionIds: string | null;
  useLivePrice: number | null;
  createdAt: number;
  updatedAt: number;
};

export type LedgerRow = {
  id: number;
  categoryId: number | null;
  amountCents: Cents;
  pending: boolean;
  date: number;
  comment: string | null;
};

export type MigrateToPricedHoldingsResult = {
  alreadyMigrated: boolean;
  backupPath: string | null;
  dbPath: string;
  bytesBefore: number;
  bytesAfter: number;

  countsBefore: TableCounts;
  countsAfter: TableCounts;

  cashBalanceBefore: Cents;
  cashBalanceAfter: Cents;

  sumAmountsBefore: Cents;
  sumAmountsAfter: Cents;

  assetTotalBefore: Cents;
  assetTotalAfter: Cents;

  foreignKeyViolationsBefore: unknown[][];
  foreignKeyViolationsAfter: unknown[][];

  /** Commodity rows given a symbol by the backfill. */
  backfilled: Array<{ id: number; commodityType: string; priceSymbol: string }>;
  /**
   * Rows in a priceable category that the migration deliberately left
   * hand-valued, because nothing in the database says how much is held (the
   * live file's "$70.00 of BTC + ETH" note is exactly this).
   */
  unmigratableRows: Array<{
    id: number;
    category: string;
    notes: string | null;
    currentValueCents: Cents;
  }>;
};

export type MigrateToPricedHoldingsOptions = {
  dbPath: string;
  backupDir: string;
  /** Verify and report, but never write the database or a backup. */
  dryRun?: boolean;
  migrationSqlPath?: string;
  /**
   * When set, the derived cash balance must equal this exactly, before AND
   * after. For data/budget.db that is 449618 ($4,496.18).
   */
  expectedCashBalanceCents?: Cents;
  /** When set, these row counts must match before AND after. */
  expectedCounts?: Partial<Record<(typeof PRESERVED_TABLES)[number], number>>;
  /** Test seam: mutate the migrated database to prove verification bites. */
  corruptForTest?: (db: Database) => void;
  log?: (message: string) => void;
};

async function loadSqlJs() {
  return initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules/sql.js/dist", file),
  });
}

function rows(db: Database, sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

function scalar(db: Database, sql: string): unknown {
  return rows(db, sql)[0]?.[0] ?? null;
}

function tableNames(db: Database): Set<string> {
  return new Set(
    rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r[0])),
  );
}

function columnNames(db: Database, table: string): Set<string> {
  return new Set(rows(db, `PRAGMA table_info(${table})`).map((r) => String(r[1])));
}

function columnSpec(db: Database, table: string, column: string) {
  const row = rows(db, `PRAGMA table_info(${table})`).find((r) => String(r[1]) === column);
  return row ? { type: String(row[2]).toLowerCase(), notNull: Number(row[3]) === 1 } : null;
}

function counts(db: Database): TableCounts {
  const present = tableNames(db);
  const out: TableCounts = {};
  for (const table of PRESERVED_TABLES) {
    if (present.has(table)) out[table] = Number(scalar(db, `SELECT COUNT(*) FROM ${table}`) ?? 0);
  }
  return out;
}

const text = (value: unknown): string | null => (value === null ? null : String(value));

function readAssets(db: Database): AssetRow[] {
  return rows(
    db,
    `SELECT id, category, current_value_cents, currency, notes, commodity_type, quantity, unit,
            linked_transaction_ids, use_live_price, created_at, updated_at
     FROM assets ORDER BY id`,
  ).map((r) => ({
    id: Number(r[0]),
    category: String(r[1]),
    currentValueCents: Number(r[2]),
    currency: String(r[3]),
    notes: text(r[4]),
    commodityType: text(r[5]),
    quantity: r[6] === null ? null : Number(r[6]),
    unit: text(r[7]),
    linkedTransactionIds: text(r[8]),
    useLivePrice: r[9] === null ? null : Number(r[9]),
    createdAt: Number(r[10]),
    updatedAt: Number(r[11]),
  }));
}

function readLedger(db: Database): LedgerRow[] {
  return rows(
    db,
    "SELECT id, category_id, amount_cents, pending, date, comment FROM transactions ORDER BY id",
  ).map((r) => ({
    id: Number(r[0]),
    categoryId: r[1] === null ? null : Number(r[1]),
    amountCents: Number(r[2]),
    pending: Number(r[3]) === 1,
    date: Number(r[4]),
    comment: text(r[5]),
  }));
}

function readCategories(db: Database) {
  return rows(db, "SELECT id, type FROM categories").map((r) => ({
    id: Number(r[0]),
    type: String(r[1]),
  }));
}

/** The app's own rule, not a re-implementation of it. */
function cashBalance(db: Database): Cents {
  return deriveCashBalanceCents(readLedger(db), readCategories(db));
}

function sumAmounts(db: Database): Cents {
  return Number(scalar(db, "SELECT COALESCE(SUM(amount_cents), 0) FROM transactions") ?? 0);
}

function assetTotal(db: Database): Cents {
  return Number(scalar(db, "SELECT COALESCE(SUM(current_value_cents), 0) FROM assets") ?? 0);
}

function foreignKeyCheck(db: Database): unknown[][] {
  db.run("PRAGMA foreign_keys = ON");
  return rows(db, "PRAGMA foreign_key_check");
}

function fkKey(row: unknown[]): string {
  return row.map((cell) => String(cell)).join("|");
}

function execScript(db: Database, sql: string) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

/** Decides whether 0004 still has to be applied. Refuses a half-applied state. */
function detectState(db: Database): "pre-0004" | "post-0004" {
  const tables = tableNames(db);
  for (const required of ["transactions", "categories", "assets"]) {
    if (!tables.has(required)) throw new Error(`Not a budget database: missing table ${required}`);
  }
  if (!columnNames(db, "transactions").has("amount_cents")) {
    throw new Error(
      "This database still has float money columns. Run lib/db/migrate-to-cents.ts (migration 0002) first.",
    );
  }
  if (!tables.has("accounts") || !columnNames(db, "transactions").has("account_id")) {
    throw new Error(
      "This database predates the accounts schema. Run lib/db/migrate-to-accounts.ts (migration 0003) first.",
    );
  }

  const assetColumns = columnNames(db, "assets");
  const present = NEW_COLUMNS.filter((spec) => assetColumns.has(spec.column));
  if (present.length === 0) return "pre-0004";
  if (present.length === NEW_COLUMNS.length) return "post-0004";

  throw new Error(
    "Refusing to run: the database is in a half-migrated state. " +
      `0004 columns present: [${present.map((p) => p.column).join(", ")}]. ` +
      "Restore a backup from data/backups/ and re-run.",
  );
}

/**
 * Apply 0004 to `options.dbPath` in place, with a backup and full verification.
 * Idempotent: a second run reports `alreadyMigrated` and writes nothing.
 */
export async function migrateDatabaseToPricedHoldings(
  options: MigrateToPricedHoldingsOptions,
): Promise<MigrateToPricedHoldingsResult> {
  const {
    dbPath,
    backupDir,
    dryRun = false,
    migrationSqlPath = MIGRATION_SQL_PATH,
    expectedCashBalanceCents,
    expectedCounts,
    corruptForTest,
    log = () => {},
  } = options;

  if (!existsSync(dbPath)) throw new Error(`Database not found at ${dbPath}`);
  const bytesBefore = statSync(dbPath).size;
  if (bytesBefore === 0) throw new Error(`Database at ${dbPath} is empty (0 bytes)`);

  const SQL = await loadSqlJs();
  const originalBytes = readFileSync(dbPath);
  let db = new SQL.Database(originalBytes);

  try {
    if (detectState(db) === "post-0004") {
      log("Already migrated: assets.price_symbol and assets.priced_at both exist.");
      const countsNow = counts(db);
      const balanceNow = cashBalance(db);
      return {
        alreadyMigrated: true,
        backupPath: null,
        dbPath,
        bytesBefore,
        bytesAfter: bytesBefore,
        countsBefore: countsNow,
        countsAfter: countsNow,
        cashBalanceBefore: balanceNow,
        cashBalanceAfter: balanceNow,
        sumAmountsBefore: sumAmounts(db),
        sumAmountsAfter: sumAmounts(db),
        assetTotalBefore: assetTotal(db),
        assetTotalAfter: assetTotal(db),
        foreignKeyViolationsBefore: [],
        foreignKeyViolationsAfter: [],
        backfilled: [],
        unmigratableRows: [],
      };
    }

    // ---- 1. Snapshot everything the assertions will compare against.
    const countsBefore = counts(db);
    const assetsBefore = readAssets(db);
    const ledgerBefore = readLedger(db);
    const cashBalanceBefore = cashBalance(db);
    const sumAmountsBefore = sumAmounts(db);
    const assetTotalBefore = assetTotal(db);
    const fkBefore = foreignKeyCheck(db);

    if (expectedCounts) {
      for (const [table, expected] of Object.entries(expectedCounts)) {
        if (countsBefore[table] !== expected) {
          throw new Error(
            `Pre-flight check failed: expected ${expected} row(s) in ${table}, found ${countsBefore[table]}. ` +
              "Is this the right database?",
          );
        }
      }
    }
    if (expectedCashBalanceCents !== undefined && cashBalanceBefore !== expectedCashBalanceCents) {
      throw new Error(
        `Pre-flight check failed: derived cash balance is ${cashBalanceBefore} cents, ` +
          `expected ${expectedCashBalanceCents}. Is this the right database?`,
      );
    }

    /** What the backfill is expected to produce, computed independently of the SQL. */
    const expectedSymbols = new Map<number, string | null>(
      assetsBefore.map((row) => [row.id, priceSymbolForCommodityType(row.commodityType)]),
    );

    // ---- 2. Back up the ORIGINAL bytes before anything else.
    let backupPath: string | null = null;
    if (!dryRun) {
      mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = path.join(backupDir, `budget.${stamp}.pre-0004.db`);
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
      // ---- 3. Apply the migration.
      //
      // 0004 only ADDs nullable columns, so no table is rebuilt and nothing can
      // cascade through asset_history.asset_id. The pragma is still bracketed
      // OFF/ON: it costs nothing, and it is the house rule for schema work here
      // precisely so that a future statement in this position cannot quietly
      // become destructive.
      const sqlPath = path.isAbsolute(migrationSqlPath)
        ? migrationSqlPath
        : path.resolve(process.cwd(), migrationSqlPath);
      if (!existsSync(sqlPath)) throw new Error(`Migration SQL not found at ${sqlPath}`);

      db.run("PRAGMA foreign_keys = OFF");
      execScript(db, readFileSync(sqlPath, "utf-8"));
      db.run("PRAGMA foreign_keys = ON");

      if (corruptForTest) corruptForTest(db);

      // ---- 4. Verify. Every check below throws, which triggers the restore.
      const verify = (target: Database, phase: string) => {
        // 4a. The new columns exist, are nullable, and have the right types.
        for (const spec of NEW_COLUMNS) {
          const column = columnSpec(target, "assets", spec.column);
          if (!column) throw new Error(`${phase}: assets.${spec.column} was not added`);
          if (column.type !== spec.type) {
            throw new Error(
              `${phase}: assets.${spec.column} is ${column.type}, expected ${spec.type}`,
            );
          }
          if (column.notNull) {
            throw new Error(
              `${phase}: assets.${spec.column} is NOT NULL, a hand-valued asset must be able to have none`,
            );
          }
        }
        if (tableNames(target).has("__new_assets")) {
          throw new Error(`${phase}: rebuild scaffolding __new_assets was left behind`);
        }

        // 4b. Row counts unchanged everywhere (asset_history: cascade guard).
        const countsAfter = counts(target);
        for (const table of Object.keys(countsBefore)) {
          if (countsAfter[table] !== countsBefore[table]) {
            throw new Error(
              `${phase}: ${table} row count changed: ${countsBefore[table]} before, ${countsAfter[table]} after`,
            );
          }
        }
        if (expectedCounts) {
          for (const [table, expected] of Object.entries(expectedCounts)) {
            if (countsAfter[table] !== expected) {
              throw new Error(`${phase}: expected ${expected} row(s) in ${table}, found ${countsAfter[table]}`);
            }
          }
        }

        // 4c. Every asset row identical except the two new columns.
        const assetsAfter = readAssets(target);
        if (assetsAfter.length !== assetsBefore.length) {
          throw new Error(`${phase}: assets row count changed`);
        }
        for (let i = 0; i < assetsBefore.length; i++) {
          const before = assetsBefore[i];
          const after = assetsAfter[i];
          if (after.id !== before.id) {
            throw new Error(`${phase}: asset ids reordered at index ${i}`);
          }
          for (const key of [
            "category",
            "currentValueCents",
            "currency",
            "notes",
            "commodityType",
            "quantity",
            "unit",
            "linkedTransactionIds",
            "useLivePrice",
            "createdAt",
            "updatedAt",
          ] as const) {
            // Exact comparison, quantity included: 1.1376 must not become 1.14.
            if (after[key] !== before[key]) {
              throw new Error(
                `${phase}: asset ${before.id} ${snake(key)} changed: ` +
                  `${JSON.stringify(before[key])} -> ${JSON.stringify(after[key])}`,
              );
            }
          }
        }

        // 4d. The backfill: every metals row on its symbol, nothing else touched.
        const symbolRows = rows(
          target,
          "SELECT id, commodity_type, price_symbol FROM assets ORDER BY id",
        ).map((r) => ({
          id: Number(r[0]),
          commodityType: text(r[1]),
          priceSymbol: text(r[2]),
        }));
        const backfilled: MigrateToPricedHoldingsResult["backfilled"] = [];
        for (const row of symbolRows) {
          const expected = expectedSymbols.get(row.id) ?? null;
          if (row.priceSymbol !== expected) {
            throw new Error(
              `${phase}: asset ${row.id} (commodity_type ${JSON.stringify(row.commodityType)}) ` +
                `has price_symbol ${JSON.stringify(row.priceSymbol)}, expected ${JSON.stringify(expected)}`,
            );
          }
          if (expected !== null) {
            backfilled.push({
              id: row.id,
              commodityType: String(row.commodityType),
              priceSymbol: expected,
            });
          }
        }
        // Nothing may have been priced by this migration: it fetches nothing.
        const pricedAtSet = Number(
          scalar(target, "SELECT COUNT(*) FROM assets WHERE priced_at IS NOT NULL") ?? 0,
        );
        if (pricedAtSet !== 0) {
          throw new Error(
            `${phase}: ${pricedAtSet} row(s) have priced_at set, but this migration fetches no prices`,
          );
        }

        // 4e. Totals and the ledger.
        const ledgerAfter = readLedger(target);
        if (ledgerAfter.length !== ledgerBefore.length) {
          throw new Error(`${phase}: ledger length changed`);
        }
        for (let i = 0; i < ledgerBefore.length; i++) {
          const before = ledgerBefore[i];
          const after = ledgerAfter[i];
          if (
            after.id !== before.id ||
            after.amountCents !== before.amountCents ||
            after.categoryId !== before.categoryId ||
            after.date !== before.date ||
            after.comment !== before.comment ||
            after.pending !== before.pending
          ) {
            throw new Error(
              `${phase}: transaction ${before.id} changed: ` +
                `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
            );
          }
        }

        const sumAmountsAfter = sumAmounts(target);
        if (sumAmountsAfter !== sumAmountsBefore) {
          throw new Error(
            `${phase}: sum(amount_cents) changed: ${sumAmountsBefore} -> ${sumAmountsAfter}`,
          );
        }
        const assetTotalAfter = assetTotal(target);
        if (assetTotalAfter !== assetTotalBefore) {
          throw new Error(
            `${phase}: sum(assets.current_value_cents) changed: ${assetTotalBefore} -> ${assetTotalAfter}`,
          );
        }
        const cashBalanceAfter = cashBalance(target);
        if (cashBalanceAfter !== cashBalanceBefore) {
          throw new Error(
            `${phase}: derived cash balance changed: ${cashBalanceBefore} -> ${cashBalanceAfter}`,
          );
        }
        if (expectedCashBalanceCents !== undefined && cashBalanceAfter !== expectedCashBalanceCents) {
          throw new Error(
            `${phase}: derived cash balance is ${cashBalanceAfter} cents, expected ${expectedCashBalanceCents}`,
          );
        }

        // 4f. No NEW referential damage. On the live file: 0 before, 0 after.
        const fkAfter = foreignKeyCheck(target);
        const known = new Set(fkBefore.map(fkKey));
        const introduced = fkAfter.filter((row) => !known.has(fkKey(row)));
        if (introduced.length > 0) {
          throw new Error(
            `${phase}: PRAGMA foreign_key_check reported ${introduced.length} NEW violation(s): ` +
              JSON.stringify(introduced),
          );
        }

        const unmigratableRows = assetsAfter
          .filter(
            (row) =>
              (row.category === "Crypto" || row.category === "Commodities") &&
              (expectedSymbols.get(row.id) ?? null) === null,
          )
          .map((row) => ({
            id: row.id,
            category: row.category,
            notes: row.notes,
            currentValueCents: row.currentValueCents,
          }));

        return {
          countsAfter,
          cashBalanceAfter,
          sumAmountsAfter,
          assetTotalAfter,
          fkAfter,
          backfilled,
          unmigratableRows,
        };
      };

      const inMemory = verify(db, "in-memory check");

      const migrated = Buffer.from(db.export());
      // export() closes and re-opens the connection, resetting pragmas.
      db.run("PRAGMA foreign_keys = ON");

      if (dryRun) {
        log("Dry run: verified but nothing written.");
        return {
          alreadyMigrated: false,
          backupPath,
          dbPath,
          bytesBefore,
          bytesAfter: migrated.length,
          countsBefore,
          countsAfter: inMemory.countsAfter,
          cashBalanceBefore,
          cashBalanceAfter: inMemory.cashBalanceAfter,
          sumAmountsBefore,
          sumAmountsAfter: inMemory.sumAmountsAfter,
          assetTotalBefore,
          assetTotalAfter: inMemory.assetTotalAfter,
          foreignKeyViolationsBefore: fkBefore,
          foreignKeyViolationsAfter: inMemory.fkAfter,
          backfilled: inMemory.backfilled,
          unmigratableRows: inMemory.unmigratableRows,
        };
      }

      writeFileSync(dbPath, migrated);

      // Re-open what actually landed on disk and verify THAT, not the memory copy.
      db.close();
      db = new SQL.Database(readFileSync(dbPath));
      const onDisk = verify(db, "post-write check");

      return {
        alreadyMigrated: false,
        backupPath,
        dbPath,
        bytesBefore,
        bytesAfter: migrated.length,
        countsBefore,
        countsAfter: onDisk.countsAfter,
        cashBalanceBefore,
        cashBalanceAfter: onDisk.cashBalanceAfter,
        sumAmountsBefore,
        sumAmountsAfter: onDisk.sumAmountsAfter,
        assetTotalBefore,
        assetTotalAfter: onDisk.assetTotalAfter,
        foreignKeyViolationsBefore: fkBefore,
        foreignKeyViolationsAfter: onDisk.fkAfter,
        backfilled: onDisk.backfilled,
        unmigratableRows: onDisk.unmigratableRows,
      };
    } catch (error) {
      restore();
      throw error;
    }
  } finally {
    db.close();
  }
}

/** camelCase -> snake_case, so error messages name real column names. */
function snake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Renders the before/after report. */
export function formatPricedHoldingsReport(result: MigrateToPricedHoldingsResult): string {
  if (result.alreadyMigrated) {
    return "Already migrated to priced holdings: no changes made.";
  }

  const lines: string[] = [];
  lines.push(`Database: ${result.dbPath}`);
  lines.push(`Size:     ${result.bytesBefore} bytes -> ${result.bytesAfter} bytes`);
  lines.push("");

  lines.push("Row counts (must be unchanged):");
  const header = ["table".padEnd(24), "before".padStart(8), "after".padStart(8), "ok".padStart(4)].join(" ");
  lines.push(`  ${header}`);
  lines.push(`  ${"-".repeat(header.length)}`);
  for (const table of Object.keys(result.countsBefore)) {
    const before = result.countsBefore[table];
    const after = result.countsAfter[table];
    lines.push(
      `  ${table.padEnd(24)} ${String(before).padStart(8)} ${String(after).padStart(8)} ${
        (before === after ? "YES" : "NO").padStart(4)
      }`,
    );
  }
  lines.push("");

  lines.push("Totals (must be unchanged):");
  lines.push(
    `  sum(transactions.amount_cents)      ${result.sumAmountsBefore} -> ${result.sumAmountsAfter} ` +
      `(${result.sumAmountsBefore === result.sumAmountsAfter ? "conserved" : "CHANGED"})`,
  );
  lines.push(
    `  sum(assets.current_value_cents)     ${result.assetTotalBefore} -> ${result.assetTotalAfter} ` +
      `= ${formatMoney(result.assetTotalAfter)} ` +
      `(${result.assetTotalBefore === result.assetTotalAfter ? "conserved" : "CHANGED"})`,
  );
  lines.push(
    `  derived cash balance                ${result.cashBalanceBefore} -> ${result.cashBalanceAfter} cents ` +
      `= ${formatMoney(result.cashBalanceAfter)} ` +
      `(${result.cashBalanceBefore === result.cashBalanceAfter ? "conserved" : "CHANGED"})`,
  );
  lines.push("");

  lines.push("Backfill (commodity_type -> price_symbol):");
  if (result.backfilled.length === 0) {
    lines.push("  none");
  } else {
    for (const row of result.backfilled) {
      lines.push(`  asset id=${row.id}: ${row.commodityType} -> ${row.priceSymbol}`);
    }
  }
  lines.push("");

  lines.push("Left hand-valued on purpose (no quantity in the database to price):");
  if (result.unmigratableRows.length === 0) {
    lines.push("  none");
  } else {
    for (const row of result.unmigratableRows) {
      lines.push(
        `  asset id=${row.id} (${row.category}) ${formatMoney(row.currentValueCents)}` +
          (row.notes ? ` "${row.notes}"` : "") +
          ": enter a quantity in the dialog to make it live-priced",
      );
    }
  }
  lines.push("");

  lines.push(
    `PRAGMA foreign_key_check: ${result.foreignKeyViolationsBefore.length} violation(s) before, ` +
      `${result.foreignKeyViolationsAfter.length} after (0 introduced).`,
  );
  if (result.foreignKeyViolationsBefore.length > 0) {
    lines.push(`  before: ${JSON.stringify(result.foreignKeyViolationsBefore)}`);
  }
  if (result.foreignKeyViolationsAfter.length > 0) {
    lines.push(`  after:  ${JSON.stringify(result.foreignKeyViolationsAfter)}`);
  }

  return lines.join("\n");
}

/** The live database's known-good figures, asserted by default. */
const LIVE_EXPECTATIONS = {
  cashBalanceCents: 449618,
  counts: { transactions: 71, categories: 14, assets: 3 } as const,
};

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
  // The live-file assertions only make sense for the live file.
  const isLive = !argv.includes("--no-expect") && dbPath.endsWith(path.join("data", "budget.db"));

  console.log("Applying migration 0004 (priced holdings: price_symbol, priced_at)");
  console.log(`  database: ${dbPath}`);
  console.log(`  backups:  ${backupDir}`);
  console.log(`  dry run:  ${dryRun}`);
  console.log(`  asserting live-database figures: ${isLive}`);
  if (isLive) {
    console.log(`    expected cash balance: ${LIVE_EXPECTATIONS.cashBalanceCents} cents`);
    console.log(`    expected row counts:   ${JSON.stringify(LIVE_EXPECTATIONS.counts)}`);
  }
  console.log("");

  const result = await migrateDatabaseToPricedHoldings({
    dbPath,
    backupDir,
    dryRun,
    expectedCashBalanceCents: isLive ? LIVE_EXPECTATIONS.cashBalanceCents : undefined,
    expectedCounts: isLive ? LIVE_EXPECTATIONS.counts : undefined,
    log: (message) => console.log(message),
  });

  console.log("");
  console.log(formatPricedHoldingsReport(result));
  console.log("");
  if (result.alreadyMigrated) {
    console.log("Nothing to do.");
  } else if (dryRun) {
    console.log("Dry run: migration verified, nothing written.");
  } else {
    console.log("Migration verified and saved.");
  }
}

// Only run when invoked directly, never on import.
if (/migrate-to-priced-holdings\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("");
    console.error("MIGRATION FAILED: the database was left unchanged (or restored).");
    console.error(error);
    process.exit(1);
  });
}
