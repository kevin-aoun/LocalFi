import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, readDb, withDb } from "../client";
import {
  buildMovementDelta,
  buildTransactionMovements,
  postLedgerEvent,
  rebuildLedgerProjections,
  registerLedgerAccount,
  verifyLedger,
} from "../../ledger";

let directory: string;
const PRIVATE_DESCRIPTION = "Secret medical payment 987";
const EVENT_DATE = "2026-08-09";

function localEpoch(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Math.floor(new Date(year, month - 1, day).getTime() / 1000);
}

async function journalImage(): Promise<string> {
  return readDb((_db, raw) => JSON.stringify({
    events: raw.exec("SELECT * FROM ledger_events ORDER BY sequence")[0]?.values ?? [],
    movements: raw.exec(
      "SELECT * FROM ledger_movements ORDER BY event_id, position",
    )[0]?.values ?? [],
  }));
}

describe.sequential("ledger verification and recovery", () => {
  beforeEach(async () => {
    await closeDb();
    directory = mkdtempSync(path.join(os.tmpdir(), "localfi-ledger-recovery-"));
    process.env.BUDGET_DB_PATH = path.join(directory, "budget.db");

    const target = await withDb((_db, raw) => {
      raw.run(
        "INSERT INTO categories (id, name, type, icon, color) VALUES (91, 'Recovery', 'Expense', 'Wallet', '#000')",
      );
      raw.run(
        `INSERT INTO accounts
          (id, name, kind, type, opening_balance_cents, opening_balance_date, currency)
         VALUES (92, 'Recovery account', 'asset', 'Checking', 0, '2026-08-01', 'USD')`,
      );
      return {
        account: registerLedgerAccount(raw, {
          targetType: "real_account", targetRef: 92, currency: "USD",
        }),
        category: registerLedgerAccount(raw, {
          targetType: "category", targetRef: 91, currency: "USD",
        }),
      };
    });
    const eventEpoch = localEpoch(EVENT_DATE);
    const snapshot = {
      id: 93,
      date: eventEpoch,
      categoryId: 91,
      accountId: 92,
      transferAccountId: null,
      amountCents: 424_242,
      direction: "outflow",
      currency: "USD",
      comment: PRIVATE_DESCRIPTION,
      pending: false,
      recurringId: null,
      recurringOccurrence: null,
      instrumentId: null,
      quantityDelta: null,
      transferPrincipalAmountCents: null,
      allocations: [],
      createdAt: eventEpoch,
      updatedAt: eventEpoch,
    };
    await postLedgerEvent({
      effectiveDate: EVENT_DATE,
      description: PRIVATE_DESCRIPTION,
      metadata: { projectionKey: 93, transaction: snapshot },
      movements: buildTransactionMovements({
        direction: "outflow", amountMinor: 424_242, currency: "USD",
        accountTargetId: target.account, categoryTargetId: target.category,
      }),
      recordedAt: eventEpoch,
    }, (_db, raw, event) => {
      raw.run(
        `INSERT INTO transactions
          (id, date, category_id, account_id, amount_cents, direction, currency, current_event_id,
           comment, pending, created_at, updated_at)
         VALUES (93, ?, 91, 92, 424242, 'outflow', 'USD', ?, ?, 0, ?, ?)`,
        [snapshot.date, event.eventId, PRIVATE_DESCRIPTION, snapshot.createdAt, snapshot.updatedAt],
      );
      raw.run(
        `UPDATE assets SET current_value_cents = -424242, currency = 'USD'
          WHERE id = (SELECT id FROM assets WHERE category = 'Cash' ORDER BY id LIMIT 1)`,
      );
    });
  });

  afterEach(async () => {
    await closeDb();
    delete process.env.BUDGET_DB_PATH;
    rmSync(directory, { recursive: true, force: true });
  });

  it("rebuilds only projections and leaves journal bytes unchanged", async () => {
    const before = await journalImage();
    await withDb((_db, raw) => raw.run("UPDATE transactions SET amount_cents = 1 WHERE id = 93"));
    const corrupt = await verifyLedger();
    expect(corrupt.ok).toBe(false);
    expect(corrupt.failures.map((item) => item.invariant)).toContain("projection.transaction_content");
    const diagnostics = JSON.stringify(corrupt);
    expect(diagnostics).not.toContain(PRIVATE_DESCRIPTION);
    expect(diagnostics).not.toContain("424242");

    expect(await rebuildLedgerProjections()).toMatchObject({ transactions: 1, positions: 0 });
    const after = await journalImage();
    expect(after).toBe(before);
    expect((await verifyLedger()).ok).toBe(true);
  });

  it("lets a journaled NULL transaction head reach verify and rebuild", async () => {
    const journalBefore = await journalImage();
    await withDb((_db, raw) => {
      raw.run("UPDATE transactions SET current_event_id = NULL WHERE id = 93");
    });
    await closeDb();

    const corrupt = await verifyLedger();
    expect(corrupt.ok).toBe(false);
    expect(corrupt.failures.map((item) => item.invariant)).toContain(
      "projection.transaction_head",
    );
    expect(JSON.stringify(corrupt)).not.toContain(PRIVATE_DESCRIPTION);

    expect(await rebuildLedgerProjections()).toMatchObject({ transactions: 1, positions: 0 });
    expect(await journalImage()).toBe(journalBefore);
    expect(await verifyLedger()).toMatchObject({ ok: true });
  });

  it("reports and recreates a missing Cash projection without changing the journal", async () => {
    const journalBefore = await journalImage();
    await withDb((_db, raw) => raw.run("DELETE FROM assets WHERE category = 'Cash'"));

    const corrupt = await verifyLedger();
    expect(corrupt.ok).toBe(false);
    expect(corrupt.failures.map((item) => item.invariant)).toContain("projection.cash_missing");
    expect(JSON.stringify(corrupt)).not.toContain(PRIVATE_DESCRIPTION);
    expect(JSON.stringify(corrupt)).not.toContain("424242");

    expect(await rebuildLedgerProjections()).toMatchObject({ transactions: 1, positions: 0 });
    expect(await readDb((_db, raw) => raw.exec(
      "SELECT current_value_cents, currency FROM assets WHERE category = 'Cash' ORDER BY id",
    )[0]?.values ?? [])).toEqual([[-424_242, "USD"]]);
    expect(await journalImage()).toBe(journalBefore);
    expect(await verifyLedger()).toMatchObject({ ok: true });
  });

  it("repairs only the first Cash row in its denomination and ignores extras", async () => {
    const eurEpoch = localEpoch("2026-08-10");
    const target = await withDb((_db, raw) => ({
      account: registerLedgerAccount(raw, {
        targetType: "system", targetRef: "legacy-unassigned-account", currency: "EUR",
      }),
      category: registerLedgerAccount(raw, {
        targetType: "category", targetRef: 91, currency: "EUR",
      }),
    }));
    const eurSnapshot = {
      id: 94,
      date: eurEpoch,
      categoryId: 91,
      accountId: null,
      transferAccountId: null,
      amountCents: 12_345,
      direction: "outflow",
      currency: "EUR",
      comment: null,
      pending: false,
      recurringId: null,
      recurringOccurrence: null,
      instrumentId: null,
      quantityDelta: null,
      transferPrincipalAmountCents: null,
      allocations: [],
      createdAt: eurEpoch,
      updatedAt: eurEpoch,
    };
    await postLedgerEvent({
      effectiveDate: "2026-08-10",
      description: "",
      metadata: { projectionKey: 94, transaction: eurSnapshot },
      movements: buildTransactionMovements({
        direction: "outflow", amountMinor: 12_345, currency: "EUR",
        accountTargetId: target.account, categoryTargetId: target.category,
      }),
      recordedAt: eurEpoch,
    }, (_db, raw, event) => {
      raw.run(
        `INSERT INTO transactions
          (id, date, category_id, account_id, amount_cents, direction, currency, current_event_id,
           pending, created_at, updated_at)
         VALUES (94, ?, 91, NULL, 12345, 'outflow', 'EUR', ?, 0, ?, ?)`,
        [eurEpoch, event.eventId, eurEpoch, eurEpoch],
      );
      raw.run("UPDATE assets SET current_value_cents = 1 WHERE category = 'Cash'");
      raw.run(
        `INSERT INTO assets (category, current_value_cents, currency, notes)
         VALUES ('Cash', 777, 'EUR', 'Ignored compatibility extra')`,
      );
    });
    const journalBefore = await journalImage();

    const corrupt = await verifyLedger();
    expect(corrupt.failures.map((item) => item.invariant)).toContain("projection.cash_content");
    expect(JSON.stringify(corrupt)).not.toContain(PRIVATE_DESCRIPTION);
    expect(JSON.stringify(corrupt)).not.toContain("424242");
    await rebuildLedgerProjections();

    expect(await readDb((_db, raw) => raw.exec(
      "SELECT current_value_cents, currency, notes FROM assets WHERE category = 'Cash' ORDER BY id",
    )[0].values)).toEqual([
      [-424_242, "USD", "Auto-calculated from USD transactions"],
      [777, "EUR", "Ignored compatibility extra"],
    ]);
    expect(await journalImage()).toBe(journalBefore);
    expect(await verifyLedger()).toMatchObject({ ok: true });
  });

  it("recreates a deleted managed Cash row without touching the remaining extra", async () => {
    await rebuildLedgerProjections();
    const before = await readDb((_db, raw) => {
      const marker = String(raw.exec(
        "SELECT projection FROM ledger_projection_state WHERE projection LIKE 'cash:%'",
      )[0].values[0][0]);
      const match = /^cash:USD:([1-9][0-9]*)$/.exec(marker);
      if (!match) throw new Error("managed Cash marker was not established");
      return { marker, managedId: Number(match[1]) };
    });
    const extraBefore = await withDb((_db, raw) => {
      raw.run(
        `INSERT INTO transactions
          (id, date, category_id, account_id, amount_cents, direction, currency,
           pending, created_at, updated_at)
         VALUES (95, ?, 91, 92, 999, 'outflow', 'USD', 1, ?, ?)`,
        [localEpoch("2026-08-10"), localEpoch("2026-08-10"), localEpoch("2026-08-10")],
      );
      raw.run(
        `INSERT INTO instruments (id, kind, label, unit, category)
         VALUES ('instrument:recovery-observation', 'manual', 'Recovery observation', 'unit', 'Other')`,
      );
      raw.run(
        `INSERT INTO instrument_observations
          (instrument_id, observation_kind, observed_day, observed_at, amount_minor, currency, source)
         VALUES ('instrument:recovery-observation', 'valuation', '2026-08-10', ?, 54321, 'USD',
                 'recovery-fixture')`,
        [localEpoch("2026-08-10")],
      );
      raw.run(
        `INSERT INTO assets (category, current_value_cents, currency, notes)
         VALUES ('Cash', 777, 'EUR', 'Preserve this extra exactly')`,
      );
      const extraId = Number(raw.exec("SELECT last_insert_rowid()")[0].values[0][0]);
      const bytes = JSON.stringify(raw.exec("SELECT * FROM assets WHERE id = ?", [extraId])[0].values[0]);
      raw.run("DELETE FROM assets WHERE id = ?", [before.managedId]);
      return {
        extraId,
        bytes,
        pending: JSON.stringify(raw.exec("SELECT * FROM transactions WHERE id = 95")[0].values[0]),
        observations: JSON.stringify(raw.exec(
          "SELECT * FROM instrument_observations WHERE instrument_id = 'instrument:recovery-observation'",
        )[0].values),
      };
    });
    const journalBefore = await journalImage();

    const corrupt = await verifyLedger();
    expect(corrupt.failures.map((item) => item.invariant)).toContain("projection.cash_missing");
    expect(JSON.stringify(corrupt)).not.toContain("Preserve this extra exactly");
    await rebuildLedgerProjections();

    const after = await readDb((_db, raw) => {
      const marker = String(raw.exec(
        "SELECT projection FROM ledger_projection_state WHERE projection LIKE 'cash:%'",
      )[0].values[0][0]);
      const match = /^cash:USD:([1-9][0-9]*)$/.exec(marker);
      if (!match) throw new Error("managed Cash marker was not repaired");
      const managedId = Number(match[1]);
      return {
        marker,
        managedId,
        managed: raw.exec(
          "SELECT current_value_cents, currency FROM assets WHERE id = ?",
          [managedId],
        )[0].values,
        extra: JSON.stringify(
          raw.exec("SELECT * FROM assets WHERE id = ?", [extraBefore.extraId])[0].values[0],
        ),
        pending: JSON.stringify(raw.exec("SELECT * FROM transactions WHERE id = 95")[0].values[0]),
        observations: JSON.stringify(raw.exec(
          "SELECT * FROM instrument_observations WHERE instrument_id = 'instrument:recovery-observation'",
        )[0].values),
      };
    });
    expect(after.managedId).not.toBe(before.managedId);
    expect(after.marker).not.toBe(before.marker);
    expect(after.managed).toEqual([[-424_242, "USD"]]);
    expect(after.extra).toBe(extraBefore.bytes);
    expect(after.pending).toBe(extraBefore.pending);
    expect(after.observations).toBe(extraBefore.observations);
    expect(await journalImage()).toBe(journalBefore);
    expect(await verifyLedger()).toMatchObject({ ok: true });
  });

  it("adopts one legacy Cash row once and keeps the marker idempotently", async () => {
    await withDb((_db, raw) => {
      raw.run("DELETE FROM ledger_projection_state WHERE projection LIKE 'cash:%'");
    });
    const cashId = await readDb((_db, raw) => Number(raw.exec(
      "SELECT id FROM assets WHERE category = 'Cash' ORDER BY id LIMIT 1",
    )[0].values[0][0]));

    await rebuildLedgerProjections();
    const first = await readDb((_db, raw) => raw.exec(
      "SELECT projection FROM ledger_projection_state WHERE projection LIKE 'cash:%'",
    )[0].values);
    expect(first).toEqual([[`cash:USD:${cashId}`]]);
    await rebuildLedgerProjections();
    expect(await readDb((_db, raw) => raw.exec(
      "SELECT projection FROM ledger_projection_state WHERE projection LIKE 'cash:%'",
    )[0].values)).toEqual(first);
  });

  it("reports malformed or duplicate Cash marker state without guessing", async () => {
    await rebuildLedgerProjections();
    await withDb((_db, raw) => {
      raw.run(
        `INSERT INTO ledger_projection_state (projection, event_count)
         VALUES ('cash:EUR:999999', 0), ('cash:malformed', 0)`,
      );
    });
    const assetsBefore = await readDb((_db, raw) => JSON.stringify(
      raw.exec("SELECT * FROM assets ORDER BY id")[0].values,
    ));

    const corrupt = await verifyLedger();
    expect(corrupt.failures.map((item) => item.invariant)).toContain("projection.cash_marker");
    expect(JSON.stringify(corrupt)).not.toContain("cash:EUR:999999");
    await expect(rebuildLedgerProjections()).rejects.toThrow(/marker/i);
    expect(await readDb((_db, raw) => JSON.stringify(
      raw.exec("SELECT * FROM assets ORDER BY id")[0].values,
    ))).toBe(assetsBefore);
  });

  it("reports hash and guard corruption without descriptions or amounts", async () => {
    await withDb((_db, raw) => {
      raw.run("DROP TRIGGER ledger_events_immutable_update");
      raw.run("UPDATE ledger_events SET hash = ?", ["0".repeat(64)]);
    });
    const result = await verifyLedger();
    expect(result.ok).toBe(false);
    expect(result.failures.map((item) => item.invariant)).toEqual(
      expect.arrayContaining(["schema.guard.ledger_events_immutable_update", "hash.digest"]),
    );
    const diagnostics = JSON.stringify(result);
    expect(diagnostics).not.toContain(PRIVATE_DESCRIPTION);
    expect(diagnostics).not.toContain("424242");
  });

  it("returns private-safe failures for malformed canonical movement shapes", async () => {
    await withDb((_db, raw) => {
      raw.run("DROP TRIGGER ledger_events_immutable_update");
      raw.run("UPDATE ledger_events SET canonical_payload = ?", [
        '{"movements":{"unexpected":"shape"}}',
      ]);
    });
    const result = await verifyLedger();
    expect(result.ok).toBe(false);
    expect(result.failures.map((item) => item.invariant)).toEqual(
      expect.arrayContaining(["schema.guard.ledger_events_immutable_update", "hash.payload_invalid"]),
    );
    const diagnostics = JSON.stringify(result);
    expect(diagnostics).not.toContain(PRIVATE_DESCRIPTION);
    expect(diagnostics).not.toContain("424242");
  });

  it("requires deletion amendments to preserve the transaction projection key", async () => {
    const prior = await readDb((_db, raw) => {
      const eventId = String(
        raw.exec("SELECT current_event_id FROM transactions WHERE id = 93")[0].values[0][0],
      );
      const movements = raw.exec(
        `SELECT ledger_account_id, amount_minor, currency, quantity_delta
         FROM ledger_movements WHERE event_id = ? ORDER BY position`,
        [eventId],
      )[0].values.map((row) => ({
        ledgerAccountId: String(row[0]), amountMinor: Number(row[1]),
        currency: String(row[2]), quantityDelta: row[3] == null ? null : String(row[3]),
      }));
      return { eventId, movements };
    });
    await postLedgerEvent({
      effectiveDate: "2026-08-10",
      description: "",
      amendsEventId: prior.eventId,
      metadata: { projectionKey: 94, transaction: null },
      movements: buildMovementDelta(prior.movements, prior.movements),
    });
    const result = await verifyLedger();
    expect(result.ok).toBe(false);
    expect(result.failures.map((item) => item.invariant)).toContain("amendment.projection_key");
  });
});
