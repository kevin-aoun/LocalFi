import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDomainDb,
  execOn,
  seedAccount,
  seedCategory,
  type DomainDb,
} from "@/app/actions/__tests__/support/domain-fixture";
import {
  readLedgerEventPayloadRaw,
  readLedgerExplorerPageRaw,
} from "@/lib/ledger/explorer";
import { shouldRequestLedgerEventPayload } from "@/lib/ledger/explorer-contract";
import { postLedgerEventRaw, registerLedgerAccount } from "@/lib/ledger";
import { verifyLedgerRaw } from "@/lib/ledger/verify";

let temp: DomainDb;

function journalSerialization(raw: import("sql.js").Database): string {
  return JSON.stringify({
    events: raw.exec(
      "SELECT sequence, event_id, canonical_payload, previous_hash, hash FROM ledger_events ORDER BY sequence",
    ),
    movements: raw.exec(
      "SELECT event_id, position, ledger_account_id, amount_minor, currency, quantity_delta FROM ledger_movements ORDER BY event_id, position",
    ),
  });
}

beforeAll(async () => {
  temp = await createDomainDb();
  seedAccount(temp, { id: 10, name: "Checking 123", kind: "asset", type: "Checking" });
  seedAccount(temp, { id: 11, name: "Euro reserve", kind: "asset", type: "Savings", currency: "EUR" });
  seedCategory(temp, { id: 20, name: "Groceries 24/7", type: "Expense" });

  execOn(temp, (raw) => {
    raw.run(
      `INSERT INTO instruments (id, kind, label, symbol, unit, category)
       VALUES ('instrument-gold', 'commodity', 'Gold position', 'XAU', 'oz', 'Precious metals')`,
    );
    const usdAccount = registerLedgerAccount(raw, {
      targetType: "real_account",
      targetRef: 10,
      currency: "USD",
    });
    const eurAccount = registerLedgerAccount(raw, {
      targetType: "real_account",
      targetRef: 11,
      currency: "EUR",
    });
    const usdCategory = registerLedgerAccount(raw, {
      targetType: "category",
      targetRef: 20,
      currency: "USD",
    });
    const eurCategory = registerLedgerAccount(raw, {
      targetType: "category",
      targetRef: 20,
      currency: "EUR",
    });
    const instrument = registerLedgerAccount(raw, {
      targetType: "instrument",
      targetRef: "instrument-gold",
      currency: "USD",
      instrumentId: "instrument-gold",
    });

    const eventIds: string[] = [];
    for (let index = 1; index <= 240; index += 1) {
      const date = new Date(Date.UTC(2026, 0, index - 1)).toISOString().slice(0, 10);
      const usesEuro = index % 10 === 0;
      const amount = index * 7;
      const event = postLedgerEventRaw(raw, {
        effectiveDate: date,
        description: index === 42 ? "Unique phoenix model 123" : `Synthetic event ${index}`,
        metadata: { fact: "synthetic", ordinal: index },
        movements: [
          {
            ledgerAccountId: usesEuro ? eurAccount : usdAccount,
            amountMinor: -amount,
            currency: usesEuro ? "EUR" : "USD",
          },
          {
            ledgerAccountId: usesEuro ? eurCategory : usdCategory,
            amountMinor: amount,
            currency: usesEuro ? "EUR" : "USD",
          },
        ],
        recordedAt: 1_770_000_000 + index,
      });
      eventIds.push(event.eventId);
    }

    postLedgerEventRaw(raw, {
      effectiveDate: "2026-09-01",
      description: "Exact quantity purchase",
      metadata: { fact: "instrument purchase" },
      movements: [
        { ledgerAccountId: usdAccount, amountMinor: -500, currency: "USD" },
        {
          ledgerAccountId: instrument,
          amountMinor: 500,
          currency: "USD",
          quantityDelta: "0.125",
        },
      ],
      recordedAt: 1_770_000_241,
    });

    postLedgerEventRaw(raw, {
      effectiveDate: "2026-09-02",
      description: "Correction keeps the earlier receipt",
      amendsEventId: eventIds[49],
      metadata: { fact: "manual correction" },
      movements: [
        { ledgerAccountId: usdAccount, amountMinor: 7, currency: "USD" },
        { ledgerAccountId: usdCategory, amountMinor: -7, currency: "USD" },
      ],
      recordedAt: 1_770_000_242,
    });
  });
});

afterAll(async () => {
  await temp.cleanup();
});

function inspect<T>(reader: (raw: import("sql.js").Database) => T): T {
  let result: T | undefined;
  execOn(temp, (raw) => {
    result = reader(raw);
  });
  return result as T;
}

describe("raw Ledger explorer query", () => {
  it("pages newest first with an exclusive cursor and no gaps or duplicates", () => {
    const sequences: number[] = [];
    let beforeSequence: number | null = null;
    do {
      const page = inspect((raw) => readLedgerExplorerPageRaw(raw, {
        beforeSequence,
        pageSize: 37,
      }));
      sequences.push(...page.events.map((event) => event.sequence));
      beforeSequence = page.nextBeforeSequence;
    } while (beforeSequence !== null);

    expect(sequences).toHaveLength(242);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual(Array.from({ length: 242 }, (_, index) => 242 - index));
  });

  it("caps page size and rejects invalid cursors", () => {
    const page = inspect((raw) => readLedgerExplorerPageRaw(raw, { pageSize: 10_000 }));
    expect(page.events).toHaveLength(75);
    expect(page.pageSize).toBe(75);
    expect(() => inspect((raw) => readLedgerExplorerPageRaw(raw, { beforeSequence: 0 })))
      .toThrow(/positive integer/);
  });

  it("serializes base pages without canonical metadata or payload fields", () => {
    const serialized = JSON.parse(JSON.stringify(
      inspect((raw) => readLedgerExplorerPageRaw(raw, { pageSize: 75 })),
    )) as { events: Array<Record<string, unknown>> };

    expect(serialized.events).not.toHaveLength(0);
    for (const event of serialized.events) {
      expect(event).not.toHaveProperty("metadataJson");
      expect(event).not.toHaveProperty("canonicalPayload");
      expect(event).not.toHaveProperty("metadataValid");
    }
    expect(JSON.stringify(serialized)).not.toContain('"ordinal"');
  });

  it("reads one bounded payload only for an explicit non-private expansion", () => {
    const correction = inspect((raw) => readLedgerExplorerPageRaw(raw, { pageSize: 1 })).events[0];
    expect(shouldRequestLedgerEventPayload(true, false)).toBe(true);
    expect(shouldRequestLedgerEventPayload(true, true)).toBe(false);
    expect(shouldRequestLedgerEventPayload(false, false)).toBe(false);

    const payload = inspect((raw) => readLedgerEventPayloadRaw(raw, correction.eventId));
    expect(payload).toMatchObject({
      eventId: correction.eventId,
      metadataValid: true,
    });
    expect(payload.metadataJson).toContain('"fact":"manual correction"');
    expect(payload.canonicalPayload).toContain(correction.eventId);
    expect(() => inspect((raw) => readLedgerEventPayloadRaw(raw, "not-an-event")))
      .toThrow(/UUID/);
  });

  it("keeps raw movement order, exact quantity, per-currency balance, and friendly labels", () => {
    const page = inspect((raw) => readLedgerExplorerPageRaw(raw, { beforeSequence: 242, pageSize: 1 }));
    const event = page.events[0];
    expect(event.sequence).toBe(241);
    expect(event.movements.map((movement) => movement.position)).toEqual([0, 1]);
    expect(event.movements.map((movement) => movement.targetLabel)).toEqual([
      "Checking 123",
      "Gold position",
    ]);
    expect(event.movements[1].quantityDelta).toBe("0.125");
    expect(event.balances).toEqual([{ currency: "USD", amountMinor: 0 }]);
  });

  it("returns correction references without collapsing either event", () => {
    const correction = inspect((raw) => readLedgerExplorerPageRaw(raw, { pageSize: 1 })).events[0];
    expect(correction).toMatchObject({
      sequence: 242,
      amendsSequence: 50,
      eventFact: "manual correction",
    });
    expect(correction.amendsEventId).toMatch(/^[0-9a-f-]{36}$/);
    const amended = inspect((raw) => readLedgerExplorerPageRaw(raw, {
      filters: { search: correction.amendsEventId },
    }));
    expect(amended.events.map((event) => event.sequence)).toEqual([50]);
  });

  it("filters by DateKey range, currency, target type, description, hash, and exact sequence", () => {
    const range = inspect((raw) => readLedgerExplorerPageRaw(raw, {
      pageSize: 75,
      filters: { fromDate: "2026-02-01", toDate: "2026-02-28" },
    }));
    expect(range.events).toHaveLength(28);
    expect(range.events.every((event) => event.effectiveDate >= "2026-02-01" && event.effectiveDate <= "2026-02-28")).toBe(true);

    const euro = inspect((raw) => readLedgerExplorerPageRaw(raw, {
      pageSize: 75,
      filters: { currency: "eur", targetType: "real_account" },
    }));
    expect(euro.events).toHaveLength(24);
    expect(euro.events.every((event) => event.movements.every((movement) => movement.currency === "EUR"))).toBe(true);

    const prose = inspect((raw) => readLedgerExplorerPageRaw(raw, {
      filters: { search: "unique phoenix model 123" },
    }));
    expect(prose.events.map((event) => event.sequence)).toEqual([42]);

    const hash = prose.events[0].hash;
    const byHash = inspect((raw) => readLedgerExplorerPageRaw(raw, {
      filters: { search: hash.slice(0, 18) },
    }));
    expect(byHash.events.map((event) => event.eventId)).toContain(prose.events[0].eventId);
    expect(byHash.events.map((event) => event.sequence)).toContain(43);

    const bySequence = inspect((raw) => readLedgerExplorerPageRaw(raw, {
      filters: { search: "42" },
    }));
    expect(bySequence.events.map((event) => event.sequence)).toContain(42);
  });

  it("leaves serialized journal rows unchanged after queries and verification", () => {
    inspect((raw) => {
      const before = journalSerialization(raw);
      readLedgerExplorerPageRaw(raw, { pageSize: 75, filters: { search: "Synthetic" } });
      readLedgerExplorerPageRaw(raw, { beforeSequence: 180, pageSize: 50, filters: { currency: "USD" } });
      verifyLedgerRaw(raw);
      expect(journalSerialization(raw)).toBe(before);
    });
  });

  it("handles malformed metadata defensively without returning database objects", () => {
    inspect((raw) => {
      raw.run("DROP TRIGGER ledger_events_immutable_update");
      raw.run("UPDATE ledger_events SET metadata_json = 'not-json' WHERE sequence = 1");
      const event = readLedgerExplorerPageRaw(raw, {
        beforeSequence: 2,
        pageSize: 1,
      }).events[0];
      expect(event.eventFact).toBe("journal event");
      expect(Object.getPrototypeOf(event)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(event.movements[0])).toBe(Object.prototype);
      expect(readLedgerEventPayloadRaw(raw, event.eventId).metadataValid).toBe(false);
    });
  });
});
