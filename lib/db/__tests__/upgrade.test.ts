import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { runDbUpgrade } from "../../../scripts/db-upgrade";
import { toDateKey } from "../../dates";
import {
  DatabaseUpgradeError,
  SCHEMA_JOURNAL_TABLE,
  upgradeDatabase,
} from "../upgrade";
import { acquireWriterLease, writerLeasePath } from "../writer-lease";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS = path.join(PROJECT_ROOT, "drizzle", "migrations");
const temporaryDirectories: string[] = [];
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

function migrationEntries(): Array<{ idx: number; tag: string }> {
  return JSON.parse(
    readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ).entries;
}

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(PROJECT_ROOT, "node_modules/sql.js/dist", file),
  });
});

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "localfi-upgrade-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "budget.db");
}

function replayThrough(db: Database, lastIndex: number) {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    if (entry.idx > lastIndex) break;
    const sql = readFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) db.exec(statement);
    }
  }
}

function createJournalThrough(db: Database, lastIndex: number, checksumOverrides = new Map<number, string>()) {
  db.run(
    `CREATE TABLE ${SCHEMA_JOURNAL_TABLE} (
      idx integer PRIMARY KEY NOT NULL,
      tag text NOT NULL UNIQUE,
      checksum text NOT NULL,
      origin text NOT NULL CHECK(origin IN ('adopted', 'applied')),
      applied_at integer DEFAULT (unixepoch()) NOT NULL
    )`,
  );
  for (const entry of migrationEntries()) {
    if (entry.idx > lastIndex) break;
    const checksum = checksumOverrides.get(entry.idx) ?? createHash("sha256")
      .update(readFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), "utf8"))
      .digest("hex");
    db.run(
      `INSERT INTO ${SCHEMA_JOURNAL_TABLE} (idx, tag, checksum, origin)
       VALUES (?, ?, ?, 'applied')`,
      [entry.idx, entry.tag, checksum],
    );
  }
}

function writePre0009Fixture(options: { mixedTransfer?: boolean } = {}): string {
  const dbPath = tempDbPath();
  const db = new SQL.Database();
  replayThrough(db, 8);
  db.run("UPDATE accounts SET created_at = strftime('%s', '2020-02-03T12:00:00Z') WHERE id = 1");
  db.run(
    "INSERT INTO accounts " +
      "(id, name, kind, type, opening_balance_cents, currency, archived, created_at) " +
      "VALUES (2, 'Savings', 'asset', 'Savings', -5000, ?, 0, " +
      "strftime('%s', '2021-04-05T23:00:00Z'))",
    [options.mixedTransfer ? "EUR" : "USD"],
  );
  db.run(
    "INSERT INTO categories (id, name, type, icon, color) VALUES " +
      "(1, 'Salary', 'Income', 'Wallet', '#0f0'), " +
      "(2, 'Food', 'Expense', 'Wallet', '#f00')",
  );
  db.run(
    "INSERT INTO transactions (id, date, category_id, account_id, amount_cents) VALUES " +
      "(1, 1, 1, 1, 10000), (2, 2, 2, 1, -2500)",
  );
  db.run(
    "INSERT INTO transactions " +
      "(id, date, category_id, account_id, transfer_account_id, amount_cents) " +
      "VALUES (3, 3, NULL, 1, 2, -3000)",
  );
  writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
  return dbPath;
}

function open(file: string): Database {
  return new SQL.Database(readFileSync(file));
}

async function runUpgrade(dbPath: string, dryRun = false) {
  const lease = await acquireWriterLease(dbPath);
  try {
    return await upgradeDatabase({ dbPath, dryRun, lease });
  } finally {
    await lease.release();
  }
}

describe("journaled pre-open upgrade", () => {
  it("accepts the pinned pre-correction 0009 checksum and repairs its generated date", async () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "Pacific/Niue";
    try {
      const dbPath = tempDbPath();
      const db = new SQL.Database();
      replayThrough(db, 11);
      const createdAt = Math.floor(Date.parse("2026-01-03T00:30:00Z") / 1000);
      db.run(
        `INSERT INTO accounts
          (id, name, kind, type, opening_balance_cents, opening_balance_date, currency,
           created_at, updated_at)
         VALUES (71, 'Old 0009 opening', 'asset', 'Checking', 12345, '2026-01-03', 'USD',
                 ?, ?)`,
        [createdAt, createdAt],
      );
      createJournalThrough(db, 11, new Map([
        [9, "d4b22ffa8ffa059a5bd703a3473dfa4e681d75cdbd583a6bf28f41cf69ae18d5"],
      ]));
      writeFileSync(dbPath, Buffer.from(db.export()));
      db.close();

      expect(await runUpgrade(dbPath)).toMatchObject({
        applied: [
          "0012_immutable-ledger",
          "0013_ledger-explorer",
          "0014_category-order",
          "0015_budget-order",
        ],
      });
      const upgraded = open(dbPath);
      try {
        expect(upgraded.exec(
          "SELECT opening_balance_date FROM accounts WHERE id = 71",
        )[0].values).toEqual([["2026-01-02"]]);
        expect(upgraded.exec(
          `SELECT effective_date FROM ledger_events
            WHERE json_extract(metadata_json, '$.provenance.legacyAccountId') = 71`,
        )[0].values).toEqual([["2026-01-02"]]);
      } finally {
        upgraded.close();
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("fails closed instead of adopting a populated SQL-only 0012 schema", async () => {
    const dbPath = tempDbPath();
    const db = new SQL.Database();
    replayThrough(db, 11);
    db.run(
      `INSERT INTO accounts
        (id, name, kind, type, opening_balance_cents, opening_balance_date, currency, created_at)
       VALUES (71, 'SQL-only opening', 'asset', 'Checking', 12345, '2026-01-02', 'USD', 1767312000)`,
    );
    const sql = readFileSync(path.join(MIGRATIONS, "0012_immutable-ledger.sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) db.exec(statement);
    }
    writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();
    const original = readFileSync(dbPath);

    await expect(runUpgrade(dbPath)).rejects.toThrow(
      /0012_immutable-ledger.*semantic backfill.*restore.*upgrade/i,
    );
    expect(readFileSync(dbPath).equals(original)).toBe(true);
  });

  it("accepts structural projection damage after a valid journal records 0012", async () => {
    const dbPath = writePre0009Fixture();
    await runUpgrade(dbPath);
    const db = open(dbPath);
    db.run("UPDATE transactions SET current_event_id = NULL WHERE id = 1");
    writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();
    const damaged = readFileSync(dbPath);

    expect(await runUpgrade(dbPath)).toMatchObject({
      changed: false,
      adopted: [],
      applied: [],
    });
    expect(readFileSync(dbPath).equals(damaged)).toBe(true);
  });

  it("backs up a pre-0009 database, preserves data, journals, and verifies 0009", async () => {
    const dbPath = writePre0009Fixture();
    const original = readFileSync(dbPath);

    const result = await runUpgrade(dbPath);

    expect(result.changed).toBe(true);
    const supported = migrationEntries();
    expect(result.applied).toEqual(supported.slice(9).map((entry) => entry.tag));
    expect(result.adopted).toHaveLength(9);
    expect(result.backupPath).toMatch(/pre-upgrade-0009_ledger-semantics\.db$/);
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
    expect(readFileSync(result.backupPath!).equals(original)).toBe(true);

    const db = open(dbPath);
    try {
      expect(
        db.exec(
          "SELECT id, opening_balance_cents, opening_balance_date FROM accounts ORDER BY id",
        )[0].values,
      ).toEqual([
        [1, 0, toDateKey(new Date("2020-02-03T12:00:00Z"))],
        [2, 5000, toDateKey(new Date("2021-04-05T23:00:00Z"))],
      ]);
      expect(
        db.exec(
          "SELECT id, account_id, transfer_account_id, amount_cents, direction, currency " +
            "FROM transactions ORDER BY id",
        )[0].values,
      ).toEqual([
        [1, 1, null, 10000, "inflow", "USD"],
        [2, 1, null, 2500, "inflow", "USD"],
        [3, 2, 1, 3000, "transfer", "USD"],
      ]);
      const journalRows = db.exec(
        `SELECT idx, tag, origin FROM ${SCHEMA_JOURNAL_TABLE} ORDER BY idx`,
      )[0].values;
      expect(journalRows).toHaveLength(supported.length);
      expect(journalRows.slice(0, 9).every((row) => row[2] === "adopted")).toBe(true);
      expect(journalRows[9]).toEqual([9, "0009_ledger-semantics", "applied"]);
      expect(journalRows[10]).toEqual([10, "0010_currency-safe-holdings", "applied"]);
      expect(journalRows[11]).toEqual([11, "0011_budget-goals", "applied"]);
      expect(journalRows[12]).toEqual([12, "0012_immutable-ledger", "applied"]);
      expect(journalRows[13]).toEqual([13, "0013_ledger-explorer", "applied"]);
      expect(journalRows[14]).toEqual([14, "0014_category-order", "applied"]);
      expect(journalRows[15]).toEqual([15, "0015_budget-order", "applied"]);
      for (const [idx, tag] of [[9, "0009_ledger-semantics"], [12, "0012_immutable-ledger"]] as const) {
        const expectedChecksum = createHash("sha256")
          .update(readFileSync(path.join(MIGRATIONS, `${tag}.sql`), "utf8"))
          .digest("hex");
        expect(
          db.exec(`SELECT checksum FROM ${SCHEMA_JOURNAL_TABLE} WHERE idx = ?`, [idx])[0]
            .values,
        ).toEqual([[expectedChecksum]]);
      }
      expect(db.exec("SELECT show_ledger FROM settings")[0]?.values ?? []).toEqual([]);
      expect(
        db.exec("SELECT goal_name, goal_amount_cents FROM budgets")[0]?.values ?? [],
      ).toEqual([]);
      expect(db.exec("PRAGMA integrity_check")[0].values).toEqual([["ok"]]);
      expect(db.exec("PRAGMA foreign_key_check")[0]?.values ?? []).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("reopens idempotently without another backup or file replacement", async () => {
    const dbPath = writePre0009Fixture();
    await runUpgrade(dbPath);
    const before = statSync(dbPath);
    const backupDirectory = path.join(path.dirname(dbPath), "backups");
    const backupsBefore = readdirSync(backupDirectory);

    const second = await runUpgrade(dbPath);

    expect(second.changed).toBe(false);
    expect(second.applied).toEqual([]);
    expect(second.adopted).toEqual([]);
    expect(second.backupPath).toBeNull();
    expect(statSync(dbPath).ino).toBe(before.ino);
    expect(statSync(dbPath).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(backupDirectory)).toEqual(backupsBefore);
  });

  it("replays the complete journal for a fresh database", async () => {
    const dbPath = tempDbPath();
    const result = await runUpgrade(dbPath);

    expect(result.backupPath).toBeNull();
    expect(result.adopted).toEqual([]);
    const migrationCount = migrationEntries().length;
    expect(result.applied).toHaveLength(migrationCount);
    const db = open(dbPath);
    try {
      expect(
        Number(
          db.exec(`SELECT COUNT(*) FROM ${SCHEMA_JOURNAL_TABLE}`)[0]?.values[0]?.[0] ?? 0,
        ),
      ).toBe(migrationCount);
      expect(
        (db.exec("PRAGMA table_info(transactions)")[0]?.values ?? []).map((row) => row[1]),
      ).toEqual(expect.arrayContaining(["direction", "currency"]));
    } finally {
      db.close();
    }
  });

  it("dry-runs the whole pipeline without writing a database or backup", async () => {
    const dbPath = writePre0009Fixture();
    const original = readFileSync(dbPath);
    const result = await runUpgrade(dbPath, true);

    expect(result.dryRun).toBe(true);
    expect(result.pending).toEqual(migrationEntries().slice(9).map((entry) => entry.tag));
    expect(result.backupPath).toBeNull();
    expect(readFileSync(dbPath).equals(original)).toBe(true);
    expect(existsSync(path.join(path.dirname(dbPath), "backups"))).toBe(false);
  });

  it("uses migration 0009's prerequisite refusal and leaves the original recoverable", async () => {
    const dbPath = writePre0009Fixture({ mixedTransfer: true });
    const original = readFileSync(dbPath);
    let failure: DatabaseUpgradeError | null = null;
    try {
      await runUpgrade(dbPath);
    } catch (error) {
      failure = error as DatabaseUpgradeError;
    }

    expect(failure).toBeInstanceOf(DatabaseUpgradeError);
    expect(failure?.message).toMatch(/cross-currency/i);
    expect(failure?.backupPath && existsSync(failure.backupPath)).toBe(true);
    expect(readFileSync(dbPath).equals(original)).toBe(true);
    expect(readFileSync(failure!.backupPath!).equals(original)).toBe(true);
  });

  it("runs the supported CLI path and releases its lease", async () => {
    const dbPath = tempDbPath();
    const result = await runDbUpgrade(["--db", dbPath]);

    expect(result?.changed).toBe(true);
    expect(result?.dbPath).toBe(dbPath);
    expect(existsSync(writerLeasePath(dbPath))).toBe(false);
    expect((await runDbUpgrade(["--db", dbPath]))?.changed).toBe(false);
  });
});
