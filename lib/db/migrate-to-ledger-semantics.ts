import type { Database } from "sql.js";

import { applyAdditiveMigration, tableExists, tableHasColumn } from "./migrate-additive";

function scalarNumber(db: Database, sql: string): number {
  return Number(db.exec(sql)[0]?.values[0]?.[0] ?? 0);
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

function triggerExists(db: Database, name: string): boolean {
  const statement = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ? LIMIT 1",
  );
  try {
    statement.bind([name]);
    return statement.step();
  } finally {
    statement.free();
  }
}

const migration = {
  id: "0009",
  sqlPath: "drizzle/migrations/0009_ledger-semantics.sql",
  isApplied: (db: Database) =>
    tableHasColumn(db, "accounts", "opening_balance_date") &&
    tableHasColumn(db, "transactions", "direction") &&
    tableHasColumn(db, "transactions", "currency"),
  assertPrerequisites(db: Database) {
    if (!tableExists(db, "accounts") || !tableExists(db, "transactions")) {
      throw new Error("accounts or transactions is missing; apply migration 0003 first.");
    }

    const mixedTransfers = scalarNumber(
      db,
      `SELECT COUNT(*)
       FROM transactions t
       JOIN accounts source ON source.id = t.account_id
       JOIN accounts destination ON destination.id = t.transfer_account_id
       WHERE t.transfer_account_id IS NOT NULL
         AND UPPER(TRIM(source.currency)) <> UPPER(TRIM(destination.currency))`,
    );
    if (mixedTransfers > 0) {
      throw new Error(
        `Migration 0009 found ${mixedTransfers} cross-currency transfer(s). ` +
          "Resolve them before upgrading because LocalFi has no FX model.",
      );
    }
  },
  assertResult(db: Database) {
    for (const [table, column] of [
      ["accounts", "opening_balance_date"],
      ["transactions", "direction"],
      ["transactions", "currency"],
    ] as const) {
      if (!tableHasColumn(db, table, column)) throw new Error(`${table}.${column} is missing`);
    }

    if (
      scalarNumber(
        db,
        "SELECT COUNT(*) FROM accounts WHERE typeof(opening_balance_cents) <> 'integer' OR opening_balance_cents < 0",
      ) > 0
    ) {
      throw new Error("accounts still contain an invalid opening-balance magnitude");
    }
    if (
      scalarNumber(
        db,
        "SELECT COUNT(*) FROM transactions WHERE typeof(amount_cents) <> 'integer' OR amount_cents < 0",
      ) > 0
    ) {
      throw new Error("transactions still contain an invalid amount magnitude");
    }
    if (
      scalarNumber(
        db,
        "SELECT COUNT(*) FROM transactions WHERE direction NOT IN ('inflow', 'outflow', 'transfer')",
      ) > 0
    ) {
      throw new Error("transactions contain an invalid or unbackfilled direction");
    }
    if (
      scalarNumber(
        db,
        `SELECT COUNT(*) FROM transactions
         WHERE (direction = 'transfer' AND (transfer_account_id IS NULL OR category_id IS NOT NULL))
            OR (direction IN ('inflow', 'outflow') AND transfer_account_id IS NOT NULL)`,
      ) > 0
    ) {
      throw new Error("transaction direction does not match its transfer/category shape");
    }
    if (
      scalarNumber(
        db,
        `SELECT COUNT(*) FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.currency <> a.currency`,
      ) > 0
    ) {
      throw new Error("transaction currency backfill does not match its source account");
    }

    const accountDefinition = tableSql(db, "accounts");
    const transactionDefinition = tableSql(db, "transactions");
    for (const constraint of [
      "accounts_opening_balance_magnitude",
      "accounts_opening_balance_date_valid",
      "accounts_currency_valid",
    ]) {
      if (!accountDefinition.includes(constraint)) throw new Error(`${constraint} is missing`);
    }
    for (const constraint of [
      "transactions_amount_magnitude",
      "transactions_direction_valid",
      "transactions_direction_shape",
      "transactions_currency_valid",
    ]) {
      if (!transactionDefinition.includes(constraint)) throw new Error(`${constraint} is missing`);
    }
    for (const trigger of [
      "transactions_fill_legacy_semantics",
      "transactions_reject_legacy_update",
      "transactions_reject_cross_currency_insert",
      "transactions_reject_cross_currency_update",
      "accounts_reject_active_currency_change",
    ]) {
      if (!triggerExists(db, trigger)) throw new Error(`${trigger} is missing`);
    }
  },
};

export function migrateToLedgerSemantics(options: { dbPath?: string; dryRun?: boolean } = {}) {
  return applyAdditiveMigration(migration, options);
}

async function main() {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf("--db");
  const result = await migrateToLedgerSemantics({
    dbPath: dbIndex >= 0 ? args[dbIndex + 1] : undefined,
    dryRun: args.includes("--dry-run"),
  });
  console.log(result.alreadyMigrated ? "Migration 0009 is already applied." : "Migration 0009 verified.");
  console.log(`Database: ${result.dbPath}`);
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
  if (args.includes("--dry-run")) console.log("Dry run only; the database was not changed.");
}

if (/migrate-to-ledger-semantics\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("Migration 0009 failed; the database was left unchanged or restored.");
    console.error(error);
    process.exit(1);
  });
}
