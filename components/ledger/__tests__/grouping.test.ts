import { describe, expect, it } from "vitest";

import { groupLedgerEvents } from "@/components/ledger/ledger-explorer";
import type { LedgerExplorerEvent } from "@/lib/ledger/explorer-contract";

function ledgerEvent(
  eventId: string,
  sequence: number,
  amendsEventId: string | null = null,
): LedgerExplorerEvent {
  return {
    eventId,
    sequence,
    payloadVersion: 1,
    effectiveDate: "2026-08-10",
    recordedAt: "2026-08-10T10:00:00.000Z",
    description: `Event ${sequence}`,
    eventFact: "transaction",
    hash: `hash-${sequence}`,
    previousHash: sequence > 1 ? `hash-${sequence - 1}` : null,
    amendsEventId,
    amendsSequence: amendsEventId ? sequence - 1 : null,
    movements: [],
    balances: [],
  };
}

describe("ledger correction groups", () => {
  it("keeps a correction chain together with the newest version first", () => {
    const original = ledgerEvent("original", 10);
    const correction = ledgerEvent("correction", 14, original.eventId);
    const secondCorrection = ledgerEvent("second-correction", 18, correction.eventId);

    const groups = groupLedgerEvents([secondCorrection, original, correction]);

    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe(original.eventId);
    expect(groups[0].events.map((event) => event.eventId)).toEqual([
      secondCorrection.eventId,
      correction.eventId,
      original.eventId,
    ]);
  });

  it("orders unrelated chains by their newest event", () => {
    const older = ledgerEvent("older", 3);
    const correctedOriginal = ledgerEvent("corrected-original", 5);
    const correction = ledgerEvent("correction", 12, correctedOriginal.eventId);
    const newest = ledgerEvent("newest", 15);

    const groups = groupLedgerEvents([older, correction, newest, correctedOriginal]);

    expect(groups.map((group) => group.id)).toEqual([
      newest.eventId,
      correctedOriginal.eventId,
      older.eventId,
    ]);
  });

  it("keeps a correction usable when its parent is outside the loaded page", () => {
    const correction = ledgerEvent("correction", 30, "not-loaded");
    expect(groupLedgerEvents([correction])).toEqual([
      { id: correction.eventId, events: [correction] },
    ]);
  });
});
