
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { closeDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  buildProjectedTransactionMovements,
  buildTransactionProjection,
  canonicalDecimal,
  canonicalStringify,
  postLedgerEventRaw,
} from "@/lib/ledger";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "drizzle", "migrations");

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
async function sqlJs() {
  SQL ??= await initSqlJs({
    locateFile: (file) => path.join(PROJECT_ROOT, "node_modules/sql.js/dist", file),
  });
  return SQL;
}

export type TempDb = {
  dir: string;
  file: string;

  query: (sql: string) => Array<Record<string, unknown>>;
  cleanup: () => Promise<void>;
};

export async function createTempDb(): Promise<TempDb> {
  const SqlJs = await sqlJs();
  const dir = mkdtempSync(path.join(os.tmpdir(), "budget-c2-test-"));
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

  reconcileWithTsSchema(db);

  writeFileSync(file, Buffer.from(db.export()));
  db.close();

  process.env.BUDGET_DB_PATH = file;
  await closeDb();

  return {
    dir,
    file,
    query: (sql: string) => {
      const image = readFileSync(file);
      const handle = new SqlJs.Database(image);
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
    },
    cleanup: async () => {
      await closeDb();
      delete process.env.BUDGET_DB_PATH;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function isTable(value: unknown): value is SQLiteTable {
  try {
    return Boolean(value) && typeof value === "object" && Boolean(getTableConfig(value as SQLiteTable).name);
  } catch {
    return false;
  }
}

/**
 * Bring the replayed schema up to whatever lib/db/schema currently declares.
 *
 * The journal is the source of truth for the REAL database, but during
 * development the TypeScript schema legitimately runs ahead of the migration
 * that implements it (another branch may be adding tables right now). Drizzle
 * names every column of a table in its INSERT statements, so a column that
 * exists in TS but not in the file breaks every insert with
 * "table X has no column named Y" — a fixture problem, not a bug in the code
 * under test.
 *
 * So: create any table the journal does not have yet, and add any missing
 * column as NULLABLE with no default. Deliberately permissive — these fixtures
 * exercise application logic, not constraint enforcement, and the tests that DO
 * care about constraints (lib/db/__tests__) build their own images.
 */
function reconcileWithTsSchema(db: Database) {
  const existingTables = new Set(
    (db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? []).map((row) =>
      String(row[0]),
    ),
  );

  for (const value of Object.values(schema)) {
    if (!isTable(value)) continue;
    const config = getTableConfig(value as SQLiteTable);

    if (!existingTables.has(config.name)) {
      const columns = config.columns.map((column) => {
        const parts = [`"${column.name}"`, column.getSQLType()];
        if (column.primary) parts.push("PRIMARY KEY");
        return parts.join(" ");
      });
      db.run(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
      existingTables.add(config.name);
      continue;
    }

    const present = new Set(
      (db.exec(`PRAGMA table_info("${config.name}")`)[0]?.values ?? []).map((row) => String(row[1])),
    );
    for (const column of config.columns) {
      if (present.has(column.name)) continue;
      db.run(`ALTER TABLE "${config.name}" ADD COLUMN "${column.name}" ${column.getSQLType()}`);
    }
  }
}

/** Insert a category directly, bypassing the action under test. */
export function seedCategory(
  temp: TempDb,
  values: { id?: number; name: string; type: string; monthlyLimitCents?: number | null },
) {
  execOn(temp, (db) => {
    db.run(
      "INSERT INTO categories (id, name, type, monthly_limit_cents, icon, color) VALUES (?, ?, ?, ?, 'Wallet', '#10b981')",
      [
        values.id ?? null,
        values.name,
        values.type,
        values.monthlyLimitCents ?? null,
      ],
    );
  });
}

/** Seed a draft, or atomically post a confirmed event-backed projection. */
export function seedTransaction(
  temp: TempDb,
  values: { categoryId: number; amountCents: number; dateKey: string; comment?: string | null; pending?: boolean },
) {
  const [y, m, d] = values.dateKey.split("-").map(Number);
  const seconds = Math.floor(new Date(y, m - 1, d).getTime() / 1000);
  execOn(temp, (db) => {
    db.run("BEGIN IMMEDIATE");
    try {
    db.run(
      `INSERT INTO transactions
        (date, category_id, account_id, amount_cents, direction, currency, comment, pending)
       VALUES (?, ?, NULL, ?, 'outflow', 'USD', ?, ?)`,
      [seconds, values.categoryId, values.amountCents, values.comment ?? null, values.pending ? 1 : 0],
    );
    if (!values.pending) {
      const id = Number(db.exec("SELECT last_insert_rowid()")[0].values[0][0]);
      const timestamp = Number(db.exec(
        `SELECT created_at FROM transactions WHERE id = ${id}`,
      )[0].values[0][0]);
      const snapshot = {
        id,
        date: seconds,
        categoryId: values.categoryId,
        accountId: null,
        transferAccountId: null,
        amountCents: values.amountCents,
        direction: "outflow" as const,
        currency: "USD",
        comment: values.comment ?? null,
        recurringId: null,
        recurringOccurrence: null,
        instrumentId: null,
        quantityDelta: null,
        transferPrincipalAmountCents: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const event = postLedgerEventRaw(db, {
        effectiveDate: values.dateKey,
        description: values.comment ?? "Fixture transaction",
        metadata: {
          projectionKey: id,
          transaction: buildTransactionProjection(snapshot),
          fixture: true,
        },
        movements: buildProjectedTransactionMovements(db, snapshot),
        recordedAt: timestamp,
      });
      db.run("UPDATE transactions SET current_event_id = ? WHERE id = ?", [event.eventId, id]);
    }
    db.run("COMMIT");
    } catch (error) {
      try { db.run("ROLLBACK"); } catch { /* keep the original fixture failure */ }
      throw error;
    }
  });
}

/** Insert a quick command directly. */
export function seedQuickCommand(
  temp: TempDb,
  values: { command: string; categoryName: string; amountCents: number; comment: string },
) {
  execOn(temp, (db) => {
    db.run(
      "INSERT INTO quick_commands (command, category_name, amount_cents, comment) VALUES (?, ?, ?, ?)",
      [values.command, values.categoryName, values.amountCents, values.comment],
    );
  });
}

/** Run raw statements against the file, then write it back. */
export function execOn(temp: TempDb, fn: (db: import("sql.js").Database) => void) {
  if (!SQL) throw new Error("createTempDb() must be awaited first");
  const handle = new SQL.Database(readFileSync(temp.file));
  try {
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
