
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
import { CENTS_ONLY_COLUMNS } from "./migrate-to-cents";

const MIGRATION_SQL_PATH = path.join(
  "drizzle",
  "migrations",
  "0003_accounts_and_budget_periods.sql",
);

const PRESERVED_TABLES = [
  "transactions",
  "categories",
  "assets",
  "asset_history",
  "quick_commands",
  "settings",
  "visited_countries",
] as const;

const NEW_TABLES = ["accounts", "budgets", "recurring_transactions", "net_worth_snapshots"] as const;

export type TableCounts = Record<string, number>;

export type LedgerRow = {
  id: number;
  categoryId: number | null;
  amountCents: Cents;
  pending: boolean;
  date: number;
  comment: string | null;
};

export type MigrateToAccountsResult = {
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

  foreignKeyViolationsBefore: unknown[][];
  foreignKeyViolationsAfter: unknown[][];

  repairedRows: Array<{ id: number; previousCategoryId: number; amountCents: Cents; comment: string | null }>;

  defaultAccount: { id: number; name: string; kind: string; type: string } | null;
  transactionsOnDefaultAccount: number;

  legacyLimits: Array<{ categoryId: number; name: string; limitCents: Cents }>;
  migratedBudgets: Array<{ categoryId: number; period: string; limitCents: Cents; effectiveFrom: string }>;
};

export type MigrateToAccountsOptions = {
  dbPath: string;
  backupDir: string;

  dryRun?: boolean;
  migrationSqlPath?: string;

  expectedCashBalanceCents?: Cents;

  expectedCounts?: Partial<Record<(typeof PRESERVED_TABLES)[number], number>>;

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
  return new Set(rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r[0])));
}

function columnNames(db: Database, table: string): Set<string> {
  return new Set(rows(db, `PRAGMA table_info(${table})`).map((r) => String(r[1])));
}

function columnIsNotNull(db: Database, table: string, column: string): boolean {
  const row = rows(db, `PRAGMA table_info(${table})`).find((r) => String(r[1]) === column);
  return row !== undefined && Number(row[3]) === 1;
}

function countRows(db: Database, table: string): number {
  return Number(scalar(db, `SELECT COUNT(*) FROM ${table}`) ?? 0);
}

function counts(db: Database): TableCounts {
  const present = tableNames(db);
  const out: TableCounts = {};
  for (const table of PRESERVED_TABLES) {
    if (present.has(table)) out[table] = countRows(db, table);
  }
  return out;
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
    comment: r[5] === null ? null : String(r[5]),
  }));
}

function readCategories(db: Database) {
  return rows(db, "SELECT id, type FROM categories").map((r) => ({
    id: Number(r[0]),
    type: String(r[1]),
  }));
}


function cashBalance(db: Database): Cents {
  return deriveCashBalanceCents(readLedger(db), readCategories(db));
}

function sumAmounts(db: Database): Cents {
  return Number(scalar(db, "SELECT COALESCE(SUM(amount_cents), 0) FROM transactions") ?? 0);
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


function detectState(db: Database): "pre-0003" | "post-0003" {
  const tables = tableNames(db);
  for (const required of ["transactions", "categories", "assets"]) {
    if (!tables.has(required)) throw new Error(`Not a budget database: missing table ${required}`);
  }
  if (!columnNames(db, "transactions").has("amount_cents")) {
    throw new Error(
      "This database still has float money columns. Run lib/db/migrate-to-cents.ts (migration 0002) first.",
    );
  }

  const present = NEW_TABLES.filter((t) => tables.has(t));
  const txHasAccount = columnNames(db, "transactions").has("account_id");

  if (present.length === 0 && !txHasAccount) return "pre-0003";
  if (present.length === NEW_TABLES.length && txHasAccount) return "post-0003";

  throw new Error(
    "Refusing to run: the database is in a half-migrated state. " +
      `0003 tables present: [${present.join(", ")}]; transactions.account_id: ${txHasAccount}. ` +
      "Restore a backup from data/backups/ and re-run.",
  );
}


export async function migrateDatabaseToAccounts(
  options: MigrateToAccountsOptions,
): Promise<MigrateToAccountsResult> {
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
    if (detectState(db) === "post-0003") {
      log("Already migrated: accounts, budgets, recurring_transactions and net_worth_snapshots all exist.");
      const countsNow = counts(db);
      return {
        alreadyMigrated: true,
        backupPath: null,
        dbPath,
        bytesBefore,
        bytesAfter: bytesBefore,
        countsBefore: countsNow,
        countsAfter: countsNow,
        cashBalanceBefore: cashBalance(db),
        cashBalanceAfter: cashBalance(db),
        sumAmountsBefore: sumAmounts(db),
        sumAmountsAfter: sumAmounts(db),
        foreignKeyViolationsBefore: [],
        foreignKeyViolationsAfter: [],
        repairedRows: [],
        defaultAccount: null,
        transactionsOnDefaultAccount: 0,
        legacyLimits: [],
        migratedBudgets: [],
      };
    }


    const countsBefore = counts(db);
    const ledgerBefore = readLedger(db);
    const cashBalanceBefore = cashBalance(db);
    const sumAmountsBefore = sumAmounts(db);
    const fkBefore = foreignKeyCheck(db);

    if (expectedCounts) {
      for (const [table, expected] of Object.entries(expectedCounts)) {
        if (countsBefore[table] !== expected) {
          throw new Error(
            `Pre-flight check failed: expected ${expected} row(s) in ${table}, found ${countsBefore[table]}. ` +
              `Is this the right database?`,
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

    const knownCategoryIds = new Set(readCategories(db).map((c) => c.id));
    const willRepair = ledgerBefore.filter(
      (row) => row.categoryId !== null && !knownCategoryIds.has(row.categoryId),
    );

    const legacyLimits = rows(
      db,
      "SELECT id, name, monthly_limit_cents FROM categories WHERE monthly_limit_cents IS NOT NULL ORDER BY id",
    ).map((r) => ({ categoryId: Number(r[0]), name: String(r[1]), limitCents: Number(r[2]) }));


    let backupPath: string | null = null;
    if (!dryRun) {
      mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = path.join(backupDir, `budget.${stamp}.pre-0003.db`);
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
        const present = tableNames(target);
        for (const table of NEW_TABLES) {
          if (!present.has(table)) throw new Error(`${phase}: ${table} was not created`);
        }
        if (present.has("__new_transactions")) {
          throw new Error(`${phase}: rebuild scaffolding __new_transactions was left behind`);
        }


        const countsAfter = counts(target);
        for (const table of Object.keys(countsBefore)) {
          if (countsAfter[table] !== countsBefore[table]) {
            throw new Error(
              `${phase}: ${table} row count changed: ${countsBefore[table]} before, ${countsAfter[table]} after`,
            );
          }
        }



        const txColumns = columnNames(target, "transactions");
        for (const column of ["account_id", "transfer_account_id", "recurring_id", "recurring_occurrence"]) {
          if (!txColumns.has(column)) throw new Error(`${phase}: transactions.${column} missing`);
        }
        if (columnIsNotNull(target, "transactions", "category_id")) {
          throw new Error(`${phase}: transactions.category_id is still NOT NULL`);
        }


        for (const spec of CENTS_ONLY_COLUMNS) {
          if (!present.has(spec.table)) continue;
          if (!columnNames(target, spec.table).has(spec.column)) {
            throw new Error(`${phase}: ${spec.table}.${spec.column} missing`);
          }
          if (columnIsNotNull(target, spec.table, spec.column) !== spec.notNull) {
            throw new Error(`${phase}: ${spec.table}.${spec.column} NOT NULL flag is wrong`);
          }
        }



        const ledgerAfter = readLedger(target);
        if (ledgerAfter.length !== ledgerBefore.length) {
          throw new Error(`${phase}: ledger length changed`);
        }
        for (let i = 0; i < ledgerBefore.length; i++) {
          const before = ledgerBefore[i];
          const after = ledgerAfter[i];
          if (after.id !== before.id) {
            throw new Error(`${phase}: transaction ids reordered at index ${i}`);
          }
          if (after.amountCents !== before.amountCents) {
            throw new Error(
              `${phase}: transaction ${before.id} amount changed: ${before.amountCents} -> ${after.amountCents}`,
            );
          }
          if (after.date !== before.date) {
            throw new Error(`${phase}: transaction ${before.id} date changed`);
          }
          if (after.comment !== before.comment) {
            throw new Error(`${phase}: transaction ${before.id} comment changed`);
          }
          if (after.pending !== before.pending) {
            throw new Error(`${phase}: transaction ${before.id} pending flag changed`);
          }

          const shouldBeRepaired = willRepair.some((r) => r.id === before.id);
          if (shouldBeRepaired) {
            if (after.categoryId !== null) {
              throw new Error(
                `${phase}: transaction ${before.id} pointed at missing category ` +
                  `${before.categoryId} and should now be NULL, found ${after.categoryId}`,
              );
            }
          } else if (after.categoryId !== before.categoryId) {
            throw new Error(
              `${phase}: transaction ${before.id} category changed: ${before.categoryId} -> ${after.categoryId}`,
            );
          }
        }


        const sumAmountsAfter = sumAmounts(target);
        if (sumAmountsAfter !== sumAmountsBefore) {
          throw new Error(
            `${phase}: sum(amount_cents) changed: ${sumAmountsBefore} -> ${sumAmountsAfter}`,
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


        const accountRows = rows(target, "SELECT id, name, kind, type FROM accounts ORDER BY id");
        if (accountRows.length !== 1) {
          throw new Error(`${phase}: expected exactly 1 seeded account, found ${accountRows.length}`);
        }
        const defaultAccount = {
          id: Number(accountRows[0][0]),
          name: String(accountRows[0][1]),
          kind: String(accountRows[0][2]),
          type: String(accountRows[0][3]),
        };
        const onDefault = Number(
          scalar(target, `SELECT COUNT(*) FROM transactions WHERE account_id = ${defaultAccount.id}`) ?? 0,
        );
        if (onDefault !== ledgerBefore.length) {
          throw new Error(
            `${phase}: ${ledgerBefore.length} transaction(s) exist but only ${onDefault} are on the default account`,
          );
        }
        const strayTransfers = Number(
          scalar(target, "SELECT COUNT(*) FROM transactions WHERE transfer_account_id IS NOT NULL") ?? 0,
        );
        if (strayTransfers !== 0) {
          throw new Error(`${phase}: migration invented ${strayTransfers} transfer(s)`);
        }


        const migratedBudgets = rows(
          target,
          "SELECT category_id, period, limit_cents, effective_from FROM budgets ORDER BY category_id",
        ).map((r) => ({
          categoryId: Number(r[0]),
          period: String(r[1]),
          limitCents: Number(r[2]),
          effectiveFrom: String(r[3]),
        }));
        if (migratedBudgets.length !== legacyLimits.length) {
          throw new Error(
            `${phase}: ${legacyLimits.length} legacy monthly limit(s) but ${migratedBudgets.length} budget row(s)`,
          );
        }
        for (const legacy of legacyLimits) {
          const budget = migratedBudgets.find((b) => b.categoryId === legacy.categoryId);
          if (!budget) throw new Error(`${phase}: no budget row for category ${legacy.categoryId}`);
          if (budget.limitCents !== legacy.limitCents) {
            throw new Error(
              `${phase}: budget for category ${legacy.categoryId} is ${budget.limitCents}, expected ${legacy.limitCents}`,
            );
          }
          if (budget.period !== "monthly") {
            throw new Error(`${phase}: migrated budget for category ${legacy.categoryId} is not monthly`);
          }
        }
        const legacyStillThere = Number(
          scalar(target, "SELECT COUNT(*) FROM categories WHERE monthly_limit_cents IS NOT NULL") ?? 0,
        );
        if (legacyStillThere !== legacyLimits.length) {
          throw new Error(
            `${phase}: categories.monthly_limit_cents was modified (${legacyStillThere} of ${legacyLimits.length} left)`,
          );
        }


        const fkAfter = foreignKeyCheck(target);
        const known = new Set(fkBefore.map(fkKey));
        const introduced = fkAfter.filter((row) => !known.has(fkKey(row)));
        if (introduced.length > 0) {
          throw new Error(
            `${phase}: PRAGMA foreign_key_check reported ${introduced.length} NEW violation(s): ` +
              JSON.stringify(introduced),
          );
        }

        return { countsAfter, cashBalanceAfter, sumAmountsAfter, defaultAccount, onDefault, migratedBudgets, fkAfter };
      };

      const inMemory = verify(db, "in-memory check");

      const migrated = Buffer.from(db.export());

      db.run("PRAGMA foreign_keys = ON");

      const repairedRows = willRepair.map((row) => ({
        id: row.id,
        previousCategoryId: row.categoryId as number,
        amountCents: row.amountCents,
        comment: row.comment,
      }));

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
          foreignKeyViolationsBefore: fkBefore,
          foreignKeyViolationsAfter: inMemory.fkAfter,
          repairedRows,
          defaultAccount: inMemory.defaultAccount,
          transactionsOnDefaultAccount: inMemory.onDefault,
          legacyLimits,
          migratedBudgets: inMemory.migratedBudgets,
        };
      }

      writeFileSync(dbPath, migrated);


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
        foreignKeyViolationsBefore: fkBefore,
        foreignKeyViolationsAfter: onDisk.fkAfter,
        repairedRows,
        defaultAccount: onDisk.defaultAccount,
        transactionsOnDefaultAccount: onDisk.onDefault,
        legacyLimits,
        migratedBudgets: onDisk.migratedBudgets,
      };
    } catch (error) {
      restore();
      throw error;
    }
  } finally {
    db.close();
  }
}


export function formatAccountsReport(result: MigrateToAccountsResult): string {
  if (result.alreadyMigrated) {
    return "Already migrated to the accounts schema: no changes made.";
  }

  const lines: string[] = [];
  lines.push(`Database: ${result.dbPath}`);
  lines.push(`Size:     ${result.bytesBefore} bytes -> ${result.bytesAfter} bytes`);
  lines.push("");

  lines.push("Row counts (must be unchanged):");
  const header = ["table".padEnd(20), "before".padStart(8), "after".padStart(8), "ok".padStart(4)].join(" ");
  lines.push(`  ${header}`);
  lines.push(`  ${"-".repeat(header.length)}`);
  for (const table of Object.keys(result.countsBefore)) {
    const before = result.countsBefore[table];
    const after = result.countsAfter[table];
    lines.push(
      `  ${table.padEnd(20)} ${String(before).padStart(8)} ${String(after).padStart(8)} ${
        (before === after ? "YES" : "NO").padStart(4)
      }`,
    );
  }
  lines.push("");

  lines.push("Totals (must be unchanged):");
  lines.push(
    `  sum(amount_cents)     ${result.sumAmountsBefore} -> ${result.sumAmountsAfter} ` +
      `(${result.sumAmountsBefore === result.sumAmountsAfter ? "conserved" : "CHANGED"})`,
  );
  lines.push(
    `  derived cash balance  ${result.cashBalanceBefore} -> ${result.cashBalanceAfter} cents ` +
      `= ${formatMoney(result.cashBalanceAfter)} ` +
      `(${result.cashBalanceBefore === result.cashBalanceAfter ? "conserved" : "CHANGED"})`,
  );
  lines.push("");

  lines.push("Accounts:");
  if (result.defaultAccount) {
    lines.push(
      `  seeded default: id=${result.defaultAccount.id} "${result.defaultAccount.name}" ` +
        `(${result.defaultAccount.kind}/${result.defaultAccount.type})`,
    );
  }
  lines.push(`  transactions attached to it: ${result.transactionsOnDefaultAccount}`);
  lines.push("");

  lines.push("Orphan repair (category_id pointed at a category that no longer exists):");
  if (result.repairedRows.length === 0) {
    lines.push("  none");
  } else {
    for (const row of result.repairedRows) {
      lines.push(
        `  transaction id=${row.id}: category_id ${row.previousCategoryId} -> NULL, ` +
          `amount ${formatMoney(row.amountCents)} preserved` +
          (row.comment ? ` ("${row.comment}")` : ""),
      );
    }
  }
  lines.push("");

  lines.push("Legacy monthly limits -> budgets:");
  if (result.legacyLimits.length === 0) {
    lines.push("  none");
  } else {
    for (const legacy of result.legacyLimits) {
      const budget = result.migratedBudgets.find((b) => b.categoryId === legacy.categoryId);
      lines.push(
        `  ${legacy.name.padEnd(22)} ${formatMoney(legacy.limitCents).padStart(10)} -> ` +
          `${budget ? `${budget.period} from ${budget.effectiveFrom}` : "MISSING"}`,
      );
    }
    lines.push("  categories.monthly_limit_cents kept in place (legacy path still works)");
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

  const isLive = !argv.includes("--no-expect") && dbPath.endsWith(path.join("data", "budget.db"));

  console.log("Applying migration 0003 (accounts, transfers, budgets, recurring, net worth)");
  console.log(`  database: ${dbPath}`);
  console.log(`  backups:  ${backupDir}`);
  console.log(`  dry run:  ${dryRun}`);
  console.log(`  asserting live-database figures: ${isLive}`);
  if (isLive) {
    console.log(`    expected cash balance: ${LIVE_EXPECTATIONS.cashBalanceCents} cents`);
    console.log(`    expected row counts:   ${JSON.stringify(LIVE_EXPECTATIONS.counts)}`);
  }
  console.log("");

  const result = await migrateDatabaseToAccounts({
    dbPath,
    backupDir,
    dryRun,
    expectedCashBalanceCents: isLive ? LIVE_EXPECTATIONS.cashBalanceCents : undefined,
    expectedCounts: isLive ? LIVE_EXPECTATIONS.counts : undefined,
    log: (message) => console.log(message),
  });

  console.log("");
  console.log(formatAccountsReport(result));
  console.log("");
  if (result.alreadyMigrated) {
    console.log("Nothing to do.");
  } else if (dryRun) {
    console.log("Dry run: migration verified, nothing written.");
  } else {
    console.log("Migration verified and saved.");
  }
}


if (/migrate-to-accounts\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("");
    console.error("MIGRATION FAILED: the database was left unchanged (or restored).");
    console.error(error);
    process.exit(1);
  });
}
