/**
 * Throwaway database fixture for the domain-model server actions (accounts,
 * transfers, recurring transactions, budgets).
 *
 * Every test gets its own file in a fresh `mkdtemp` directory, pointed at via
 * BUDGET_DB_PATH. data/budget.db — the user's real financial history — is never
 * opened, and no `db:init` / `db:seed` script is run.
 *
 * The schema comes from replaying drizzle/migrations in journal order, exactly as
 * lib/db/init.ts does, so the fixture tracks the real schema instead of
 * duplicating DDL that would rot.
 *
 * This is deliberately separate from support/temp-db.ts: that fixture belongs to
 * the concurrent UI/actions work and predates the accounts tables. Sharing one
 * file across two independent workstreams costs more than the forty lines of
 * overlap.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { closeDb } from "@/lib/db/client";
import { toDateKey } from "@/lib/dates";
import { SCHEMA_JOURNAL_TABLE } from "@/lib/db/upgrade";
import { deriveCashAssetProjection } from "@/lib/db/sync-cash";
import {
  buildTransactionMovements,
  canonicalDecimal,
  canonicalStringify,
  postLedgerEventRaw,
  registerLedgerAccount,
} from "@/lib/ledger";
import {
  createManualInstrument,
  postAssetOpeningPosition,
  projectPositionHolding,
  recordInstrumentObservation,
} from "@/lib/investments";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "drizzle", "migrations");

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
async function sqlJs() {
  SQL ??= await initSqlJs({
    locateFile: (file) => path.join(PROJECT_ROOT, "node_modules/sql.js/dist", file),
  });
  return SQL;
}

export type DomainDb = {
  dir: string;
  file: string;
  /** Read rows without going through lib/db/client — independent verification. */
  query: (sql: string) => Array<Record<string, unknown>>;
  /** First column of the first row. */
  scalar: (sql: string) => unknown;
  cleanup: () => Promise<void>;
};

/** Create a migrated, empty database and point BUDGET_DB_PATH at it. */
export async function createDomainDb(): Promise<DomainDb> {
  const SqlJs = await sqlJs();
  const dir = mkdtempSync(path.join(os.tmpdir(), "budget-c1-test-"));
  const file = path.join(dir, "budget.db");

  const db = new SqlJs.Database();
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8"),
  ) as { entries: Array<{ idx: number; tag: string }> };

  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf-8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) db.exec(statement);
    }
  }
  // SQLite date('now') is UTC, while product opening dates are local DateKeys.
  // Pin the shared migrated fixture to the same local day in UTC extremes.
  db.run("UPDATE accounts SET opening_balance_date = ?", [toDateKey(new Date())]);
  db.run(
    `CREATE TABLE ${SCHEMA_JOURNAL_TABLE} (
      idx integer PRIMARY KEY NOT NULL,
      tag text NOT NULL UNIQUE,
      checksum text NOT NULL,
      origin text NOT NULL CHECK(origin IN ('adopted', 'applied')),
      applied_at integer DEFAULT (unixepoch()) NOT NULL
    )`,
  );
  for (const entry of journal.entries) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf-8");
    db.run(
      `INSERT INTO ${SCHEMA_JOURNAL_TABLE} (idx, tag, checksum, origin)
       VALUES (?, ?, ?, 'applied')`,
      [entry.idx, entry.tag, createHash("sha256").update(sql).digest("hex")],
    );
  }
  db.run(
    `INSERT INTO assets (category, current_value_cents, currency, notes)
     SELECT 'Cash', 0, 'USD', 'Auto-calculated from USD transactions'
      WHERE NOT EXISTS (SELECT 1 FROM assets WHERE category = 'Cash')`,
  );

  writeFileSync(file, Buffer.from(db.export()));
  db.close();

  process.env.BUDGET_DB_PATH = file;
  await closeDb();

  const query = (sql: string) => {
    const handle = new SqlJs.Database(readFileSync(file));
    try {
      const result = handle.exec(sql);
      if (!result[0]) return [];
      const { columns, values } = result[0];
      return values.map((row) => {
        const out: Record<string, unknown> = {};
        columns.forEach((column, i) => {
          out[column] = row[i];
        });
        return out;
      });
    } finally {
      handle.close();
    }
  };

  return {
    dir,
    file,
    query,
    scalar: (sql: string) => {
      const rows = query(sql);
      if (rows.length === 0) return null;
      return Object.values(rows[0])[0];
    },
    cleanup: async () => {
      await closeDb();
      delete process.env.BUDGET_DB_PATH;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run raw statements against the file, then write it back. */
export function execOn(temp: DomainDb, fn: (db: Database) => void) {
  if (!SQL) throw new Error("createDomainDb() must be awaited first");
  const handle = new SQL.Database(readFileSync(temp.file));
  try {
    handle.run("PRAGMA foreign_keys = ON");
    handle.create_function("ledger_sha256", (value: unknown) => {
      if (typeof value !== "string") throw new Error("ledger_sha256 requires text");
      return createHash("sha256").update(value).digest("hex");
    });
    handle.create_function("ledger_canonical_json", (value: unknown) => {
      if (typeof value !== "string") throw new Error("ledger_canonical_json requires text");
      return canonicalStringify(JSON.parse(value));
    });
    handle.create_function("ledger_canonical_decimal", (value: unknown) => {
      if (typeof value !== "string") throw new Error("ledger_canonical_decimal requires text");
      return canonicalDecimal(value);
    });
    fn(handle);
    writeFileSync(temp.file, Buffer.from(handle.export()));
  } finally {
    handle.close();
  }
}

/** Local-midnight unix seconds for a 'YYYY-MM-DD' key. */
export function secondsFor(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
}

function syncFixtureCash(db: Database): void {
  const transactionResult = db.exec(
    `SELECT category_id, amount_cents, direction, currency, pending,
            account_id, transfer_account_id
       FROM transactions`,
  )[0];
  const ledgerTransactions = (transactionResult?.values ?? []).map((row) => ({
    categoryId: row[0] == null ? null : Number(row[0]),
    amountCents: Number(row[1]),
    direction: row[2] == null ? null : String(row[2]) as "inflow" | "outflow" | "transfer",
    currency: row[3] == null ? null : String(row[3]),
    pending: Number(row[4]) === 1,
    accountId: row[5] == null ? null : Number(row[5]),
    transferAccountId: row[6] == null ? null : Number(row[6]),
  }));
  const categoryResult = db.exec("SELECT id, type FROM categories")[0];
  const ledgerCategories = (categoryResult?.values ?? []).map((row) => ({
    id: Number(row[0]),
    type: String(row[1]),
  }));
  const firstCash = db.exec(
    "SELECT id, currency FROM assets WHERE category = 'Cash' ORDER BY id LIMIT 1",
  )[0]?.values[0];
  const projection = deriveCashAssetProjection(
    ledgerTransactions,
    ledgerCategories,
    firstCash?.[1],
  );
  if (firstCash) {
    db.run(
      "UPDATE assets SET current_value_cents = ?, currency = ? WHERE id = ?",
      [projection.currentValueCents, projection.currency, firstCash[0]],
    );
  } else {
    db.run(
      `INSERT INTO assets (category, current_value_cents, currency, notes)
       VALUES ('Cash', ?, ?, ?)`,
      [
        projection.currentValueCents,
        projection.currency,
        `Auto-calculated from ${projection.currency} transactions`,
      ],
    );
  }
}

export function seedCategory(
  temp: DomainDb,
  values: { id?: number; name: string; type: string; monthlyLimitCents?: number | null },
) {
  execOn(temp, (db) => {
    db.run(
      "INSERT INTO categories (id, name, type, monthly_limit_cents, icon, color) VALUES (?, ?, ?, ?, 'Wallet', '#10b981')",
      [values.id ?? null, values.name, values.type, values.monthlyLimitCents ?? null],
    );
  });
}

export function seedAccount(
  temp: DomainDb,
  values: {
    id?: number;
    name: string;
    kind: "asset" | "liability";
    type: string;
    openingBalanceCents?: number;
    openingBalanceDate?: string;
    currency?: string;
    archived?: boolean;
  },
) {
  execOn(temp, (db) => {
    const openingBalanceDate = values.openingBalanceDate ?? toDateKey(new Date());
    db.run(
      `INSERT INTO accounts
        (id, name, kind, type, opening_balance_cents, opening_balance_date, currency, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.id ?? null,
        values.name,
        values.kind,
        values.type,
        values.openingBalanceCents ?? 0,
        openingBalanceDate,
        values.currency ?? "USD",
        values.archived ? 1 : 0,
      ],
    );
    const id = values.id ?? Number(db.exec("SELECT last_insert_rowid()")[0].values[0][0]);
    const opening = values.openingBalanceCents ?? 0;
    if (opening === 0) return;
    const accountTarget = registerLedgerAccount(db, {
      targetType: "real_account",
      targetRef: id,
      currency: values.currency ?? "USD",
    });
    const counterTarget = registerLedgerAccount(db, {
      targetType: "system",
      targetRef: "opening-balance",
      currency: values.currency ?? "USD",
    });
    const signed = values.kind === "liability" ? -opening : opening;
    const openingDate = String(
      db.exec(`SELECT opening_balance_date FROM accounts WHERE id = ${id}`)[0].values[0][0],
    );
    postLedgerEventRaw(db, {
      effectiveDate: openingDate,
      description: `Opening balance for ${values.name}`,
      metadata: {
        fact: "account-opening",
        accountId: id,
        openingBalanceCents: opening,
        expectedKind: values.kind,
        currency: values.currency ?? "USD",
        fixture: true,
      },
      movements: [
        { ledgerAccountId: accountTarget, amountMinor: signed, currency: values.currency ?? "USD" },
        { ledgerAccountId: counterTarget, amountMinor: -signed, currency: values.currency ?? "USD" },
      ],
    });
  });
}

export function seedTransaction(
  temp: DomainDb,
  values: {
    id?: number;
    categoryId?: number | null;
    accountId?: number | null;
    transferAccountId?: number | null;
    amountCents: number;
    dateKey: string;
    comment?: string | null;
    pending?: boolean;
  },
) {
  execOn(temp, (db) => {
    db.run(
      "INSERT INTO transactions (id, date, category_id, account_id, transfer_account_id, amount_cents, comment, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        values.id ?? null,
        secondsFor(values.dateKey),
        values.categoryId ?? null,
        values.accountId ?? null,
        values.transferAccountId ?? null,
        values.amountCents,
        values.comment ?? null,
        values.pending ? 1 : 0,
      ],
    );
    if (values.pending) return;
    const id = values.id ?? Number(db.exec("SELECT last_insert_rowid()")[0].values[0][0]);
    const result = db.exec(
      `SELECT date, category_id, account_id, transfer_account_id, amount_cents, direction,
              currency, comment, recurring_id, recurring_occurrence, instrument_id,
              quantity_delta, transfer_principal_amount_cents, created_at, updated_at
         FROM transactions WHERE id = ${id}`,
    )[0].values[0];
    const [
      date,
      categoryId,
      accountId,
      transferAccountId,
      amountCents,
      direction,
      currency,
      comment,
      recurringId,
      recurringOccurrence,
      instrumentId,
      quantityDelta,
      transferPrincipalAmountCents,
      createdAt,
      updatedAt,
    ] = result;
    const currencyCode = String(currency);
    const sourceTarget = registerLedgerAccount(db, accountId === null
      ? { targetType: "system", targetRef: "legacy-unassigned-account", currency: currencyCode }
      : { targetType: "real_account", targetRef: Number(accountId), currency: currencyCode });
    let movements;
    if (String(direction) === "transfer") {
      if (transferAccountId === null) throw new Error("Fixture transfer requires a destination account");
      const destinationTarget = registerLedgerAccount(db, {
        targetType: "real_account",
        targetRef: Number(transferAccountId),
        currency: currencyCode,
      });
      movements = buildTransactionMovements({
        direction: "transfer",
        amountMinor: Number(amountCents),
        currency: currencyCode,
        accountTargetId: sourceTarget,
        transferTargetId: destinationTarget,
      });
    } else {
      if (categoryId === null) throw new Error("Fixture transaction requires a category");
      const categoryTarget = registerLedgerAccount(db, {
        targetType: "category",
        targetRef: Number(categoryId),
        currency: currencyCode,
      });
      movements = buildTransactionMovements({
        direction: String(direction) as "inflow" | "outflow",
        amountMinor: Number(amountCents),
        currency: currencyCode,
        accountTargetId: sourceTarget,
        categoryTargetId: categoryTarget,
      });
    }
    const event = postLedgerEventRaw(db, {
      effectiveDate: values.dateKey,
      description: comment === null ? "" : String(comment),
      metadata: {
        projectionKey: id,
        fixture: true,
        transaction: {
          id,
          date: Number(date),
          categoryId: categoryId === null ? null : Number(categoryId),
          accountId: accountId === null ? null : Number(accountId),
          transferAccountId: transferAccountId === null ? null : Number(transferAccountId),
          amountCents: Number(amountCents),
          direction: String(direction),
          currency: currencyCode,
          comment: comment === null ? null : String(comment),
          pending: false,
          recurringId: recurringId === null ? null : Number(recurringId),
          recurringOccurrence: recurringOccurrence === null ? null : String(recurringOccurrence),
          instrumentId: instrumentId === null ? null : String(instrumentId),
          quantityDelta: quantityDelta === null ? null : String(quantityDelta),
          transferPrincipalAmountCents: transferPrincipalAmountCents === null
            ? null
            : Number(transferPrincipalAmountCents),
          allocations: [],
          createdAt: Number(createdAt),
          updatedAt: Number(updatedAt),
        },
      },
      movements,
      recordedAt: Number(updatedAt),
    });
    db.run("UPDATE transactions SET current_event_id = ? WHERE id = ?", [event.eventId, id]);
    syncFixtureCash(db);
  });
}

export function seedAsset(
  temp: DomainDb,
  values: { category: string; currentValueCents: number; notes?: string | null },
) {
  execOn(temp, (db) => {
    db.run("INSERT INTO assets (category, current_value_cents, currency, notes) VALUES (?, ?, 'USD', ?)", [
      values.category,
      values.currentValueCents,
      values.notes ?? null,
    ]);
    if (values.category === "Cash") return;
    const assetId = Number(db.exec("SELECT last_insert_rowid()")[0].values[0][0]);
    const instrument = createManualInstrument(db, {
      label: values.notes ?? values.category,
      category: values.category,
      currency: "USD",
      createdAt: 0,
    });
    db.run("UPDATE assets SET instrument_id = ? WHERE id = ?", [instrument.id, assetId]);
    recordInstrumentObservation(db, {
      instrumentId: instrument.id,
      observationKind: "valuation",
      observedDay: "1970-01-01",
      observedAt: 0,
      amountMinor: values.currentValueCents,
      currency: "USD",
      source: "fixture",
    });
    postAssetOpeningPosition(db, {
      assetId,
      instrumentId: instrument.id,
      currency: "USD",
      quantity: "1",
      bookAmountMinor: values.currentValueCents,
      effectiveDate: "1970-01-01",
      description: "Fixture opening position",
      recordedAt: 0,
      source: "manual-holding",
    });
    projectPositionHolding(db, instrument.id, "USD");
  });
}

export function seedBudget(
  temp: DomainDb,
  values: {
    id?: number;
    categoryId: number;
    period: "weekly" | "monthly" | "yearly";
    limitCents: number;
    effectiveFrom: string;
    effectiveTo?: string | null;
    rollover?: boolean;
  },
) {
  execOn(temp, (db) => {
    db.run(
      "INSERT INTO budgets (id, category_id, period, limit_cents, effective_from, effective_to, rollover) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        values.id ?? null,
        values.categoryId,
        values.period,
        values.limitCents,
        values.effectiveFrom,
        values.effectiveTo ?? null,
        values.rollover ? 1 : 0,
      ],
    );
  });
}

export function seedRecurring(
  temp: DomainDb,
  values: {
    id?: number;
    name: string;
    accountId?: number | null;
    transferAccountId?: number | null;
    categoryId?: number | null;
    amountCents: number;
    comment?: string | null;
    frequency: "daily" | "weekly" | "monthly" | "yearly";
    interval?: number;
    startDate: string;
    endDate?: string | null;
    nextDue?: string | null;
    lastGenerated?: string | null;
    archived?: boolean;
  },
) {
  execOn(temp, (db) => {
    db.run(
      "INSERT INTO recurring_transactions (id, name, account_id, transfer_account_id, category_id, amount_cents, comment, frequency, interval, start_date, end_date, next_due, last_generated, archived) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        values.id ?? null,
        values.name,
        values.accountId ?? null,
        values.transferAccountId ?? null,
        values.categoryId ?? null,
        values.amountCents,
        values.comment ?? null,
        values.frequency,
        values.interval ?? 1,
        values.startDate,
        values.endDate ?? null,
        values.nextDue ?? values.startDate,
        values.lastGenerated ?? null,
        values.archived ? 1 : 0,
      ],
    );
  });
}

/** Build a FormData from a plain object, skipping undefined values. */
export function form(values: Record<string, string | number | boolean | null | undefined>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    fd.set(key, value === null ? "" : String(value));
  }
  return fd;
}
