import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, readDb, withDb } from "../client";
import {
  buildDeletionDelta,
  buildMovementDelta,
  buildTransactionMovements,
  canonicalStringify,
  postLedgerEvent,
  registerLedgerAccount,
  verifyLedger,
} from "../../ledger";
import { projectPositionHolding } from "../../investments";

let directory: string;

describe.sequential("immutable ledger kernel", () => {
  beforeEach(async () => {
    await closeDb();
    directory = mkdtempSync(path.join(os.tmpdir(), "localfi-ledger-kernel-"));
    process.env.BUDGET_DB_PATH = path.join(directory, "budget.db");
  });

  afterEach(async () => {
    await closeDb();
    delete process.env.BUDGET_DB_PATH;
    rmSync(directory, { recursive: true, force: true });
  });

  async function targets() {
    return withDb((_db, raw) => {
      raw.run(
        "INSERT OR IGNORE INTO instruments (id, kind, label, symbol, unit, price_currency) VALUES ('currency:USD', 'currency', 'USD', 'USD', 'minor', 'USD')",
      );
      raw.run(
        "INSERT OR IGNORE INTO categories (id, name, type, icon, color) VALUES (2, 'Ledger test', 'Expense', 'Wallet', '#000')",
      );
      return {
        cash: registerLedgerAccount(raw, {
          targetType: "real_account", targetRef: 1, currency: "USD",
        }),
        category: registerLedgerAccount(raw, {
          targetType: "category", targetRef: 2, currency: "USD",
        }),
      };
    });
  }

  it("posts ordered category-balanced movements with no second movement identity", async () => {
    const target = await targets();
    const movements = buildTransactionMovements({
      direction: "outflow",
      amountMinor: 12_345,
      currency: "USD",
      accountTargetId: target.cash,
      categoryTargetId: target.category,
    });
    const { event } = await postLedgerEvent({
      effectiveDate: "2026-08-09",
      description: "private test description",
      metadata: { test: "ordinary-expense" },
      movements,
      recordedAt: 1_786_233_600,
    });

    expect(event.movements).toEqual([
      expect.objectContaining({ position: 0, amountMinor: -12_345 }),
      expect.objectContaining({ position: 1, amountMinor: 12_345 }),
    ]);
    await readDb((_db, raw) => {
      const columns = raw.exec("PRAGMA table_info(ledger_movements)")[0].values.map((row) => row[1]);
      expect(columns).not.toContain("id");
      expect(
        raw.exec("SELECT event_id, position FROM ledger_movements ORDER BY position")[0].values,
      ).toEqual([[event.eventId, 0], [event.eventId, 1]]);
      expect(() => raw.run(
        `INSERT INTO ledger_movements
          (event_id, position, ledger_account_id, amount_minor, currency, quantity_delta)
         VALUES (?, 0, ?, -12345, 'USD', NULL)`,
        [event.eventId, target.cash],
      )).toThrow();
      expect(() => raw.run(
        `INSERT INTO ledger_movements
          (event_id, position, ledger_account_id, amount_minor, currency, quantity_delta)
         VALUES (?, 2, ?, 0, 'USD', NULL)`,
        [event.eventId, target.cash],
      )).toThrow(/sealed canonical event/i);
      expect(() => raw.run("UPDATE ledger_events SET description = 'changed'")).toThrow(/immutable/i);
      expect(() => raw.run("DELETE FROM ledger_events")).toThrow(/immutable/i);
      expect(() => raw.run("UPDATE ledger_movements SET amount_minor = 0")).toThrow(/immutable/i);
      expect(() => raw.run("DELETE FROM ledger_movements")).toThrow(/immutable/i);
    });
    expect((await verifyLedger()).ok).toBe(true);
  });

  it("rolls back an unbalanced or partial event without leaving journal rows", async () => {
    const target = await targets();
    await expect(postLedgerEvent({
      effectiveDate: "2026-08-09",
      description: "unbalanced",
      metadata: {},
      movements: [
        { ledgerAccountId: target.cash, amountMinor: -10, currency: "USD" },
        { ledgerAccountId: target.category, amountMinor: 9, currency: "USD" },
      ],
    })).rejects.toThrow(/balance/i);

    const invalidEventId = "zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz";
    const canonicalPayload = canonicalStringify({
      version: 1,
      eventId: invalidEventId,
      effectiveDate: "2026-08-09",
      description: "",
      amendsEventId: null,
      metadata: {},
      movements: [
        {
          position: 0, ledgerAccountId: target.cash, amountMinor: -10,
          currency: "USD", quantityDelta: null,
        },
        {
          position: 1, ledgerAccountId: target.category, amountMinor: 10,
          currency: "USD", quantityDelta: null,
        },
      ],
      previousHash: null,
      recordedAt: 1,
    });
    await expect(withDb((_db, raw) => {
      raw.run(
        `INSERT INTO ledger_events
          (event_id, sequence, payload_version, effective_date, description, metadata_json,
           canonical_payload, previous_hash, hash, recorded_at)
         VALUES (?, 1, 1, '2026-08-09', '', '{}', ?, NULL, ledger_sha256(?), 1)`,
        [invalidEventId, canonicalPayload, canonicalPayload],
      );
    })).rejects.toThrow(/UUID/i);

    await expect(withDb((_db, raw) => {
      raw.run(
        `INSERT INTO ledger_events
          (event_id, sequence, payload_version, effective_date, description, metadata_json,
           canonical_payload, previous_hash, hash, recorded_at)
         VALUES ('00000000-0000-4000-8000-000000000001', 1, 1, '2026-08-09', '', '{}',
           '{}', NULL, ledger_sha256('{}'), 1)`,
      );
    })).rejects.toThrow();

    await readDb((_db, raw) => {
      expect(raw.exec("SELECT COUNT(*) FROM ledger_events")[0].values[0][0]).toBe(0);
      expect(raw.exec("SELECT COUNT(*) FROM ledger_movements")[0].values[0][0]).toBe(0);
    });
  });

  it("appends correction and deletion deltas and rejects duplicate amendment", async () => {
    const target = await targets();
    const original = buildTransactionMovements({
      direction: "outflow", amountMinor: 100, currency: "USD",
      accountTargetId: target.cash, categoryTargetId: target.category,
    });
    const replacement = buildTransactionMovements({
      direction: "outflow", amountMinor: 70, currency: "USD",
      accountTargetId: target.cash, categoryTargetId: target.category,
    });
    const first = (await postLedgerEvent({
      effectiveDate: "2026-08-01", description: "", metadata: {}, movements: original,
    })).event;
    const correctionDelta = buildMovementDelta(original, replacement);
    const correction = (await postLedgerEvent({
      effectiveDate: "2026-08-02", description: "", metadata: {},
      amendsEventId: first.eventId, movements: correctionDelta,
    })).event;
    expect(correctionDelta.map((movement) => movement.amountMinor).sort()).toEqual([-30, 30]);

    await expect(postLedgerEvent({
      effectiveDate: "2026-08-03", description: "", metadata: {},
      amendsEventId: first.eventId, movements: correctionDelta,
    })).rejects.toThrow();

    await postLedgerEvent({
      effectiveDate: "2026-08-03", description: "", metadata: { transaction: null },
      amendsEventId: correction.eventId, movements: buildDeletionDelta(replacement),
    });
    expect((await verifyLedger()).ok).toBe(true);
  });

  it("posts an ordered balanced correction when only event metadata changes", async () => {
    const target = await targets();
    const current = buildTransactionMovements({
      direction: "outflow", amountMinor: 100, currency: "USD",
      accountTargetId: target.cash, categoryTargetId: target.category,
    });
    const first = (await postLedgerEvent({
      effectiveDate: "2026-08-01", description: "before", metadata: { comment: "before" },
      movements: current,
    })).event;
    const correction = buildMovementDelta(current, current);
    expect(correction.map(({ position, amountMinor }) => ({ position, amountMinor }))).toEqual([
      { position: 0, amountMinor: 100 },
      { position: 1, amountMinor: -100 },
      { position: 2, amountMinor: -100 },
      { position: 3, amountMinor: 100 },
    ]);
    await postLedgerEvent({
      effectiveDate: "2026-08-02", description: "after", metadata: { comment: "after" },
      amendsEventId: first.eventId, movements: correction,
    });
    expect((await verifyLedger()).ok).toBe(true);
  });

  it("preserves exact canonical instrument quantities", async () => {
    const target = await targets();
    const instrument = await withDb((_db, raw) => {
      raw.run(
        "INSERT INTO instruments (id, kind, label, symbol, unit, price_currency) VALUES ('instrument:BTC', 'security', 'Bitcoin', 'BTC', 'coins', 'USD')",
      );
      return {
        position: registerLedgerAccount(raw, {
          targetType: "instrument", targetRef: "BTC-position", currency: "USD",
          instrumentId: "instrument:BTC",
        }),
        bookCounter: registerLedgerAccount(raw, {
          targetType: "system", targetRef: "investment-book", currency: "USD",
        }),
      };
    });
    const event = (await postLedgerEvent({
      effectiveDate: "2026-08-09",
      description: "",
      metadata: {},
      movements: buildTransactionMovements({
        direction: "outflow", amountMinor: 100_00, currency: "USD",
        accountTargetId: target.cash, categoryTargetId: target.category,
        instrumentTargetId: instrument.position,
        instrumentBookCounterTargetId: instrument.bookCounter,
        quantityDelta: "1.23000000000000000001",
      }),
    })).event;
    expect(event.movements[2].quantityDelta).toBe("1.23000000000000000001");
    await readDb((_db, raw) => {
      expect(
        raw.exec(
          `SELECT a.target_type, m.amount_minor, m.quantity_delta
           FROM ledger_movements m
           JOIN ledger_accounts a ON a.id = m.ledger_account_id
           WHERE m.event_id = ? ORDER BY m.position`,
          [event.eventId],
        )[0].values,
      ).toEqual([
        ["real_account", -10000, null],
        ["category", 10000, null],
        ["instrument", 10000, "1.23000000000000000001"],
        ["system", -10000, null],
      ]);
      expect(
        raw.exec("SELECT quantity, book_amount_minor FROM instrument_positions")[0].values,
      ).toEqual([["1.23000000000000000001", 10000]]);
    });
    await withDb((_db, raw) => {
      const projected = projectPositionHolding(raw, "instrument:BTC", "USD");
      expect(projected.valueMinor).toBe(0);
    });
    expect((await verifyLedger()).ok).toBe(true);
  });

  it("balances each currency independently in one global event", async () => {
    const usd = await targets();
    const eur = await withDb((_db, raw) => {
      raw.run(
        "INSERT OR IGNORE INTO instruments (id, kind, label, symbol, unit, price_currency) VALUES ('currency:EUR', 'currency', 'EUR', 'EUR', 'minor', 'EUR')",
      );
      raw.run(
        `INSERT INTO accounts
          (id, name, kind, type, opening_balance_cents, opening_balance_date, currency)
         VALUES (103, 'EUR test', 'asset', 'Checking', 0, '2026-08-01', 'EUR')`,
      );
      raw.run(
        "INSERT INTO categories (id, name, type, icon, color) VALUES (104, 'EUR category', 'Expense', 'Wallet', '#000')",
      );
      return {
        account: registerLedgerAccount(raw, {
          targetType: "real_account", targetRef: 103, currency: "EUR",
        }),
        category: registerLedgerAccount(raw, {
          targetType: "category", targetRef: 104, currency: "EUR",
        }),
      };
    });
    await postLedgerEvent({
      effectiveDate: "2026-08-09", description: "", metadata: {},
      movements: [
        { ledgerAccountId: usd.cash, amountMinor: -100, currency: "USD" },
        { ledgerAccountId: usd.category, amountMinor: 100, currency: "USD" },
        { ledgerAccountId: eur.account, amountMinor: -200, currency: "EUR" },
        { ledgerAccountId: eur.category, amountMinor: 200, currency: "EUR" },
      ],
    });
    expect((await verifyLedger()).ok).toBe(true);
  });

  it("uses a real SQLite rollback before discarding the image", async () => {
    await expect(withDb((_db, raw) => {
      raw.run(
        "INSERT INTO categories (name, type, icon, color) VALUES ('rolled back', 'Expense', 'Wallet', '#000')",
      );
      throw new Error("late failure");
    })).rejects.toThrow("late failure");
    await readDb((_db, raw) => {
      expect(
        raw.exec("SELECT COUNT(*) FROM categories WHERE name = 'rolled back'")[0].values[0][0],
      ).toBe(0);
    });
  });
});
