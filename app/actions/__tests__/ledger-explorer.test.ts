import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getLedgerEventPayload,
  getLedgerExplorerPage,
  verifyLedgerIntegrity,
} from "@/app/actions/ledger";
import {
  createDomainDb,
  execOn,
  seedAccount,
  seedCategory,
  seedTransaction,
  type DomainDb,
} from "./support/domain-fixture";
import { postLedgerEventRaw, registerLedgerAccount } from "@/lib/ledger";

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  seedAccount(temp, { id: 10, name: "Everyday account", kind: "asset", type: "Checking" });
  seedCategory(temp, { id: 20, name: "Food", type: "Expense" });
  seedTransaction(temp, {
    id: 30,
    categoryId: 20,
    accountId: 10,
    amountCents: 4321,
    dateKey: "2026-08-09",
    comment: "Private lunch model 123",
  });
});

afterEach(async () => {
  await temp.cleanup();
});

function serializedJournal() {
  return {
    events: temp.query(
      "SELECT sequence, event_id, metadata_json, canonical_payload, previous_hash, hash FROM ledger_events ORDER BY sequence",
    ),
    movements: temp.query(
      "SELECT event_id, position, ledger_account_id, amount_minor, currency, quantity_delta FROM ledger_movements ORDER BY event_id, position",
    ),
  };
}

describe("Ledger explorer server actions", () => {
  it("returns a serializable display page over the raw event stream", async () => {
    const result = await getLedgerExplorerPage({ pageSize: 10 });
    if ("error" in result) throw new Error(result.error);

    expect(result.data.events).toHaveLength(1);
    expect(result.data.events[0]).toMatchObject({
      sequence: 1,
      effectiveDate: "2026-08-09",
      description: "Private lunch model 123",
      eventFact: "transaction",
      balances: [{ currency: "USD", amountMinor: 0 }],
    });
    expect(result.data.events[0].movements.map((movement) => movement.targetLabel)).toEqual([
      "Everyday account",
      "Food",
    ]);
    expect(() => structuredClone(result.data)).not.toThrow();

    const transmitted = JSON.parse(JSON.stringify(result)) as {
      data: { events: Array<Record<string, unknown>> };
    };
    expect(transmitted.data.events[0]).not.toHaveProperty("metadataJson");
    expect(transmitted.data.events[0]).not.toHaveProperty("canonicalPayload");
    expect(transmitted.data.events[0]).not.toHaveProperty("metadataValid");
    expect(JSON.stringify(transmitted)).not.toContain('"amountCents"');
  });

  it("keeps privacy-on browsing payload-free and exposes canonical bytes only by exact event action", async () => {
    const before = serializedJournal();
    const pageResult = await getLedgerExplorerPage({ pageSize: 10 });
    if ("error" in pageResult) throw new Error(pageResult.error);
    const transmittedWhilePrivate = JSON.stringify(pageResult);
    expect(transmittedWhilePrivate).not.toContain("metadataJson");
    expect(transmittedWhilePrivate).not.toContain("canonicalPayload");
    expect(transmittedWhilePrivate).not.toContain('"amountCents"');

    const payloadResult = await getLedgerEventPayload(pageResult.data.events[0].eventId);
    if ("error" in payloadResult) throw new Error(payloadResult.error);
    expect(payloadResult.data.metadataJson).toContain('"amountCents":4321');
    expect(payloadResult.data.canonicalPayload).toContain("Private lunch model 123");
    await expect(getLedgerEventPayload("not-an-event"))
      .resolves.toEqual({ error: "eventId must be a UUID" });
    expect(serializedJournal()).toEqual(before);
  });

  it("loads an amended event that is outside the current cursor page", async () => {
    execOn(temp, (raw) => {
      const amendedEventId = String(
        raw.exec("SELECT event_id FROM ledger_events WHERE sequence = 1")[0].values[0][0],
      );
      const account = registerLedgerAccount(raw, {
        targetType: "real_account",
        targetRef: 10,
        currency: "USD",
      });
      const category = registerLedgerAccount(raw, {
        targetType: "category",
        targetRef: 20,
        currency: "USD",
      });
      postLedgerEventRaw(raw, {
        effectiveDate: "2026-08-10",
        description: "Correction fixture",
        amendsEventId: amendedEventId,
        metadata: { fact: "test correction" },
        movements: [
          { ledgerAccountId: account, amountMinor: 99, currency: "USD" },
          { ledgerAccountId: category, amountMinor: -99, currency: "USD" },
        ],
      });
    });

    const currentPage = await getLedgerExplorerPage({ pageSize: 1 });
    if ("error" in currentPage) throw new Error(currentPage.error);
    expect(currentPage.data.events.map((event) => event.sequence)).toEqual([2]);
    const amendedEventId = currentPage.data.events[0].amendsEventId;
    expect(amendedEventId).toBeTruthy();

    const targetPage = await getLedgerExplorerPage({
      filters: { search: amendedEventId },
    });
    if ("error" in targetPage) throw new Error(targetPage.error);
    expect(targetPage.data.events.map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
    }))).toEqual([{ eventId: amendedEventId, sequence: 1 }]);
  });

  it("returns bounded validation failures without changing the journal", async () => {
    const before = serializedJournal();
    const result = await getLedgerExplorerPage({ beforeSequence: -1 });
    expect(result).toEqual({ error: "beforeSequence must be a positive integer" });
    expect(serializedJournal()).toEqual(before);
  });

  it("uses the existing verifier and leaves journal rows byte-for-byte equivalent", async () => {
    const before = serializedJournal();
    const result = await verifyLedgerIntegrity();
    if ("error" in result) throw new Error(result.error);

    expect(result.data).toMatchObject({
      ok: true,
      counts: { events: 1, movements: 2 },
      failures: [],
    });
    expect(result.data.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(serializedJournal()).toEqual(before);
  });

  it("reports verifier failures with invariant and event reference only", async () => {
    execOn(temp, (raw) => {
      const triggerSql = String(
        raw.exec(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'ledger_events_immutable_update'",
        )[0].values[0][0],
      );
      raw.run("DROP TRIGGER ledger_events_immutable_update");
      raw.run("UPDATE ledger_events SET hash = ? WHERE sequence = 1", ["0".repeat(64)]);
      raw.exec(triggerSql);
    });
    const before = serializedJournal();
    const result = await verifyLedgerIntegrity();
    if ("error" in result) throw new Error(result.error);

    expect(result.data.ok).toBe(false);
    expect(result.data.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ invariant: "hash.digest", sequence: 1 }),
    ]));
    const publicFailure = JSON.stringify(result.data.failures);
    expect(publicFailure).not.toContain("Private lunch");
    expect(publicFailure).not.toContain("4321");
    expect(serializedJournal()).toEqual(before);
  });
});
