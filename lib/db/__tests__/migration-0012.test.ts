import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";

import { toDateKey } from "../../dates";
import { applyImmutableLedgerMigration } from "../migrate-to-immutable-ledger";
import { verifyLedgerRaw } from "../../ledger/verify";
import { rebuildLedgerProjectionsRaw } from "../../ledger/rebuild";
import { ensurePricedInstrument } from "../../investments/instruments";
import { upgradeDatabase } from "../upgrade";
import { acquireWriterLease } from "../writer-lease";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "drizzle", "migrations");
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(ROOT, "node_modules/sql.js/dist", file),
  });
});

function runMigration(db: Database, tag: string) {
  const source = readFileSync(path.join(MIGRATIONS, `${tag}.sql`), "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

function pre0012Database(): Database {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const db = new SQL.Database();
  for (const entry of journal.entries) {
    if (entry.idx >= 12) break;
    runMigration(db, entry.tag);
  }
  return db;
}

describe.sequential("migration 0012", () => {
  it("keeps derived Cash out of positions and preserves two same-symbol legacy holdings", () => {
    const db = pre0012Database();
    try {
      db.run(
        `INSERT INTO accounts
          (id, name, kind, type, opening_balance_cents, opening_balance_date, currency,
           created_at, updated_at)
         VALUES (10, 'Cash source', 'asset', 'Checking', 500000, '2026-01-03', 'USD',
                 1767398400, 1767398400)`,
      );
      db.run(
        `INSERT INTO assets
          (id, category, current_value_cents, currency, quantity, unit, price_symbol,
           use_live_price, created_at)
         VALUES
          (40, 'Cash', 500000, 'USD', NULL, NULL, NULL, 0, 1767398400),
          (41, 'Crypto', 100000, 'USD', 0.01, 'coins', 'BTC', 1, 1767398401),
          (42, 'Crypto', 250000, 'USD', 0.02, 'coins', 'BTC', 1, 1767398402)`,
      );

      const sql = readFileSync(path.join(MIGRATIONS, "0012_immutable-ledger.sql"), "utf8");
      applyImmutableLedgerMigration(db, sql);

      expect(db.exec(
        "SELECT id, instrument_id FROM assets ORDER BY id",
      )[0].values).toEqual([
        [40, null],
        [41, "instrument:legacy-asset:41"],
        [42, "instrument:legacy-asset:42"],
      ]);
      expect(db.exec(
        `SELECT id, symbol FROM instruments
          WHERE symbol = 'BTC' ORDER BY id`,
      )[0].values).toEqual([
        ["instrument:legacy-asset:41", "BTC"],
        ["instrument:legacy-asset:42", "BTC"],
      ]);
      expect(ensurePricedInstrument(db, "BTC").id).toBe("instrument:security:BTC");
      expect(db.exec(
        `SELECT id FROM instruments WHERE symbol = 'BTC' ORDER BY id`,
      )[0].values).toEqual([
        ["instrument:legacy-asset:41"],
        ["instrument:legacy-asset:42"],
        ["instrument:security:BTC"],
      ]);
      expect(db.exec(
        `SELECT instrument_id, quantity, book_amount_minor
           FROM instrument_positions ORDER BY instrument_id`,
      )[0].values).toEqual([
        ["instrument:legacy-asset:41", "0.01", 100000],
        ["instrument:legacy-asset:42", "0.02", 250000],
      ]);
      expect(db.exec(
        `SELECT COUNT(*) FROM ledger_events
          WHERE json_extract(metadata_json, '$.provenance.legacyAssetId') = 40`,
      )[0].values).toEqual([[0]]);
      expect(db.exec(
        `SELECT COUNT(*) FROM ledger_events
          WHERE json_extract(metadata_json, '$.provenance.legacyAccountId') = 10`,
      )[0].values).toEqual([[1]]);
      expect(verifyLedgerRaw(db)).toMatchObject({ ok: true });
      const journalBefore = JSON.stringify({
        events: db.exec("SELECT * FROM ledger_events ORDER BY sequence")[0]?.values ?? [],
        movements: db.exec(
          "SELECT * FROM ledger_movements ORDER BY event_id, position",
        )[0]?.values ?? [],
      });
      rebuildLedgerProjectionsRaw(db);
      expect(db.exec("SELECT id, instrument_id FROM assets ORDER BY id")[0].values).toEqual([
        [40, null],
        [41, "instrument:legacy-asset:41"],
        [42, "instrument:legacy-asset:42"],
      ]);
      expect(JSON.stringify({
        events: db.exec("SELECT * FROM ledger_events ORDER BY sequence")[0]?.values ?? [],
        movements: db.exec(
          "SELECT * FROM ledger_movements ORDER BY event_id, position",
        )[0]?.values ?? [],
      })).toBe(journalBefore);
      expect(verifyLedgerRaw(db)).toMatchObject({ ok: true });
    } finally {
      db.close();
    }
  });

  it("backfills balanced category events and explicit opening positions deterministically", () => {
    const db = pre0012Database();
    try {
      db.run(
        `INSERT INTO categories (id, name, type, icon, color)
         VALUES (20, 'Food', 'Expense', 'Wallet', '#000')`,
      );
      db.run(
        `INSERT INTO accounts
          (id, name, kind, type, opening_balance_cents, opening_balance_date, currency, created_at)
         VALUES (10, 'Checking', 'asset', 'Checking', 5000, '2026-01-01', 'USD', 1767225600)`,
      );
      db.run(
        `INSERT INTO transactions
          (id, date, category_id, account_id, amount_cents, direction, currency, comment, pending,
           created_at, updated_at)
         VALUES
           (30, 1767312000, 20, 10, 1250, 'outflow', 'USD', 'private lunch', 0,
             1767312000, 1767312001),
           (31, 1767225600, 20, 10, 500, 'outflow', 'USD', 'earlier linked', 0,
             1767225600, 1767225601),
           (32, 1767139200, 20, 10, 200, 'outflow', 'USD', 'pending link', 1,
             1767139200, 1767139201)`,
      );
      db.run(
        `INSERT INTO assets
          (id, category, current_value_cents, currency, quantity, unit, price_symbol,
           linked_transaction_ids, created_at)
         VALUES (40, 'Crypto', 250000, 'USD', 0.123456789, 'coins', 'BTC',
           '[30,31,32,null,30,999]', 1767398400)`,
      );

      const sql = readFileSync(path.join(MIGRATIONS, "0012_immutable-ledger.sql"), "utf8");
      applyImmutableLedgerMigration(db, sql);

      expect(db.exec("SELECT current_event_id FROM transactions WHERE id = 30")[0].values[0][0])
        .toMatch(/^[0-9a-f-]{36}$/);
      const transactionEvent = db.exec(
        `SELECT e.event_id FROM ledger_events e
         WHERE json_extract(e.metadata_json, '$.projectionKey') = 30`,
      )[0].values[0][0];
      expect(
        db.exec(
          `SELECT a.target_type, m.amount_minor
           FROM ledger_movements m JOIN ledger_accounts a ON a.id = m.ledger_account_id
           WHERE m.event_id = ? ORDER BY m.position`,
          [transactionEvent],
        )[0].values,
      ).toEqual([["real_account", -1250], ["category", 1250]]);

      const opening = db.exec(
        `SELECT e.event_id FROM ledger_events e
         WHERE json_extract(e.metadata_json, '$.provenance.fact') = 'opening-position'`,
      )[0].values[0][0];
      expect(
        db.exec(
          "SELECT quantity_delta FROM ledger_movements WHERE event_id = ? ORDER BY position",
          [opening],
        )[0].values,
      ).toEqual([["0.123456789"], [null]]);
      const metadata = JSON.parse(String(
        db.exec("SELECT metadata_json FROM ledger_events WHERE event_id = ?", [opening])[0].values[0][0],
      )) as { provenance: Record<string, unknown> };
      const linkedDate = toDateKey(new Date(1767225600 * 1000));
      expect(metadata.provenance).toMatchObject({
        linkedTransactionIds: [30, 31, 32, 999],
        openingDateEvidence: {
          source: "linked-confirmed-transaction",
          transactionId: 31,
          effectiveDate: linkedDate,
        },
        quantityAllocation: "not-inferred",
      });
      expect(
        db.exec("SELECT effective_date FROM ledger_events WHERE event_id = ?", [opening])[0].values,
      ).toEqual([[linkedDate]]);
      expect(verifyLedgerRaw(db)).toMatchObject({ ok: true });
    } finally {
      db.close();
    }
  });

  it("preserves an exact legacy priced total when integer-cent unit price would lose a cent", () => {
    const db = pre0012Database();
    try {
      db.run(
        `INSERT INTO assets
          (id, category, current_value_cents, currency, quantity, unit, price_symbol, created_at)
         VALUES (40, 'Crypto', 10000, 'USD', 3, 'coins', 'BTC', 1767398400)`,
      );
      const sql = readFileSync(path.join(MIGRATIONS, "0012_immutable-ledger.sql"), "utf8");
      applyImmutableLedgerMigration(db, sql);

      expect(db.exec(
        `SELECT observation_kind, amount_minor
           FROM instrument_observations ORDER BY observation_kind`,
      )[0].values).toEqual([
        ["price", 3333],
        ["valuation", 10000],
      ]);
      expect(db.exec(
        `SELECT current_value_cents FROM assets WHERE id = 40`,
      )[0].values).toEqual([[10000]]);
      expect(verifyLedgerRaw(db)).toMatchObject({ ok: true });
    } finally {
      db.close();
    }
  });

  it("uses local DateKey semantics for opening-position fallback in UTC+14 and UTC-11", () => {
    const previousTimezone = process.env.TZ;
    try {
      for (const [timezone, expectedDate] of [
        ["Pacific/Kiritimati", "2026-01-03"],
        ["Pacific/Pago_Pago", "2026-01-02"],
      ] as const) {
        process.env.TZ = timezone;
        const db = pre0012Database();
        try {
          db.run(
            `INSERT INTO assets
              (id, category, current_value_cents, currency, quantity, unit,
               linked_transaction_ids, created_at)
             VALUES (40, 'Crypto', 250000, 'USD', 0.123, 'coins', '[999]', 1767398400)`,
          );
          const sql = readFileSync(path.join(MIGRATIONS, "0012_immutable-ledger.sql"), "utf8");
          applyImmutableLedgerMigration(db, sql);
          const row = db.exec(
            `SELECT effective_date, metadata_json FROM ledger_events
             WHERE json_extract(metadata_json, '$.provenance.fact') = 'opening-position'`,
          )[0].values[0];
          const metadata = JSON.parse(String(row[1])) as { provenance: Record<string, unknown> };
          expect(row[0]).toBe(expectedDate);
          expect(metadata.provenance).toMatchObject({
            linkedTransactionIds: [999],
            openingDateEvidence: {
              source: "asset-created-at",
              createdAt: 1767398400,
              effectiveDate: expectedDate,
            },
            quantityAllocation: "not-inferred",
          });
        } finally {
          db.close();
        }
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("repairs only migration-generated 0009 opening dates in UTC+14 and UTC-11", () => {
    const previousTimezone = process.env.TZ;
    try {
      for (const [timezone, instant] of [
        ["Pacific/Kiritimati", "2026-01-02T23:30:00Z"],
        ["Pacific/Niue", "2026-01-03T00:30:00Z"],
      ] as const) {
        process.env.TZ = timezone;
        const createdAt = Math.floor(Date.parse(instant) / 1000);
        const utcDate = new Date(instant).toISOString().slice(0, 10);
        const localDate = toDateKey(new Date(instant));
        const db = pre0012Database();
        try {
          db.run(
            `INSERT INTO accounts
              (id, name, kind, type, opening_balance_cents, opening_balance_date,
               currency, created_at, updated_at)
             VALUES
              (10, 'Generated date', 'asset', 'Checking', 5000, ?, 'USD', ?, ?),
              (11, 'User date', 'asset', 'Checking', 7000, ?, 'USD', ?, ?)`,
            [utcDate, createdAt, createdAt, utcDate, createdAt, createdAt + 60],
          );
          const sql = readFileSync(path.join(MIGRATIONS, "0012_immutable-ledger.sql"), "utf8");
          applyImmutableLedgerMigration(db, sql);

          expect(db.exec(
            "SELECT id, opening_balance_date FROM accounts WHERE id IN (10, 11) ORDER BY id",
          )[0].values).toEqual([[10, localDate], [11, utcDate]]);
          expect(db.exec(
            `SELECT json_extract(metadata_json, '$.provenance.legacyAccountId'), effective_date
               FROM ledger_events
              WHERE json_extract(metadata_json, '$.provenance.fact') = 'opening-balance'
              ORDER BY 1`,
          )[0].values).toEqual([[10, localDate], [11, utcDate]]);
        } finally {
          db.close();
        }
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("creates a recoverable backup and reopens idempotently", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "localfi-migration-0012-"));
    const dbPath = path.join(directory, "budget.db");
    const fixture = pre0012Database();
    writeFileSync(dbPath, Buffer.from(fixture.export()));
    fixture.close();
    const original = readFileSync(dbPath);
    try {
      const lease = await acquireWriterLease(dbPath);
      const first = await upgradeDatabase({ dbPath, lease });
      await lease.release();
      const supportedAfterFixture = (
        JSON.parse(readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
          entries: Array<{ idx: number; tag: string }>;
        }
      ).entries.filter((entry) => entry.idx >= 12).map((entry) => entry.tag);
      expect(first.applied).toEqual(supportedAfterFixture);
      expect(first.backupPath).toMatch(/pre-upgrade-0012_immutable-ledger\.db$/);
      expect(first.backupPath && existsSync(first.backupPath)).toBe(true);
      expect(readFileSync(first.backupPath!).equals(original)).toBe(true);

      const stamp = statSync(dbPath);
      const secondLease = await acquireWriterLease(dbPath);
      const second = await upgradeDatabase({ dbPath, lease: secondLease });
      await secondLease.release();
      expect(second).toMatchObject({ changed: false, applied: [], backupPath: null });
      expect(statSync(dbPath).mtimeMs).toBe(stamp.mtimeMs);

      const persisted = new SQL.Database(readFileSync(dbPath));
      expect(verifyLedgerRaw(persisted).ok).toBe(true);
      persisted.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
