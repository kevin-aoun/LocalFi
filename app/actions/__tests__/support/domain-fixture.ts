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
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { closeDb } from "@/lib/db/client";

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
    archived?: boolean;
  },
) {
  execOn(temp, (db) => {
    db.run(
      "INSERT INTO accounts (id, name, kind, type, opening_balance_cents, archived) VALUES (?, ?, ?, ?, ?, ?)",
      [
        values.id ?? null,
        values.name,
        values.kind,
        values.type,
        values.openingBalanceCents ?? 0,
        values.archived ? 1 : 0,
      ],
    );
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
