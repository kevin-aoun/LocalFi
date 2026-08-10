import { randomUUID } from "node:crypto";

import type { Database } from "sql.js";

import { withDb } from "@/lib/db/client";
import { isDateKey } from "@/lib/dates";
import { assertCents } from "@/lib/money";

import { canonicalStringify, hashLedgerEvent } from "./canonical";
import { addCanonicalDecimals, canonicalDecimal } from "./decimal";
import { buildDeletionDelta, buildMovementDelta } from "./movements";
import type {
  LedgerEventInput,
  LedgerMovementInput,
  LedgerProjectionCallback,
  PositionedMovement,
  PostedLedgerEvent,
  StoredLedgerEvent,
} from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function epochSeconds(value: number | Date | undefined): number {
  const seconds = value instanceof Date
    ? Math.floor(value.getTime() / 1000)
    : value ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(seconds)) throw new Error("recordedAt must be integer epoch seconds");
  return seconds;
}

function normalizeMovements(movements: LedgerMovementInput[]): PositionedMovement[] {
  if (movements.length < 2) throw new Error("ledger events require at least two movements");
  const balances = new Map<string, number>();
  return movements.map((movement, position) => {
    assertCents(movement.amountMinor, "movement amount");
    const currency = movement.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("movement currency must be an ISO code");
    if (!movement.ledgerAccountId.trim()) throw new Error("movement target is required");
    const next = (balances.get(currency) ?? 0) + movement.amountMinor;
    if (!Number.isSafeInteger(next)) throw new Error("movement balance exceeds safe integer range");
    balances.set(currency, next);
    const quantityDelta = movement.quantityDelta == null
      ? null
      : canonicalDecimal(movement.quantityDelta);
    if (quantityDelta === "0") throw new Error("quantity delta cannot be zero");
    return {
      ledgerAccountId: movement.ledgerAccountId,
      amountMinor: movement.amountMinor,
      currency,
      quantityDelta,
      position,
    };
  }).map((movement, _position, normalized) => {
    if (_position === normalized.length - 1) {
      for (const balance of balances.values()) {
        if (balance !== 0) throw new Error("ledger event must balance exactly in every currency");
      }
    }
    return movement;
  });
}

function scalarHead(raw: Database): { sequence: number; hash: string | null } {
  const row = raw.exec(
    "SELECT sequence, hash FROM ledger_events ORDER BY sequence DESC LIMIT 1",
  )[0]?.values[0];
  return row ? { sequence: Number(row[0]), hash: String(row[1]) } : { sequence: 0, hash: null };
}

/** Low-level primitive used by migration while it owns an outer SQLite transaction. */
export function postLedgerEventRaw(raw: Database, input: LedgerEventInput): PostedLedgerEvent {
  const eventId = input.eventId ?? randomUUID();
  if (!UUID.test(eventId)) throw new Error("eventId must be a UUID");
  if (!isDateKey(input.effectiveDate)) throw new Error("effectiveDate must be a valid DateKey");
  if (typeof input.description !== "string") throw new Error("description must be a string");
  const amendsEventId = input.amendsEventId ?? null;
  if (amendsEventId !== null && !UUID.test(amendsEventId)) {
    throw new Error("amendsEventId must be a UUID");
  }
  const movements = normalizeMovements(input.movements);
  const recordedAt = epochSeconds(input.recordedAt);
  const head = scalarHead(raw);
  const metadataJson = canonicalStringify(input.metadata);
  const canonical = {
    version: 1 as const,
    eventId,
    effectiveDate: input.effectiveDate,
    description: input.description,
    amendsEventId,
    metadata: input.metadata,
    movements,
    previousHash: head.hash,
    recordedAt,
  };
  const canonicalPayload = canonicalStringify(canonical);
  const hash = hashLedgerEvent(canonical);
  const sequence = head.sequence + 1;

  raw.run(
    `INSERT INTO ledger_events
      (event_id, sequence, payload_version, effective_date, description, amends_event_id,
       metadata_json, canonical_payload, previous_hash, hash, recorded_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId,
      sequence,
      input.effectiveDate,
      input.description,
      amendsEventId,
      metadataJson,
      canonicalPayload,
      head.hash,
      hash,
      recordedAt,
    ],
  );

  // CONTRACT-013: exact positions are a same-transaction projection of
  // instrument-target movements, never a price-derived rewrite.
  for (const movement of movements) {
    const targetStatement = raw.prepare(
      "SELECT instrument_id FROM ledger_accounts WHERE id = ? AND target_type = 'instrument'",
    );
    let target: unknown[] | null = null;
    try {
      targetStatement.bind([movement.ledgerAccountId]);
      if (targetStatement.step()) target = targetStatement.get();
    } finally {
      targetStatement.free();
    }
    if (!target) continue;
    const instrumentId = String(target[0]);
    const existingStatement = raw.prepare(
      `SELECT quantity, book_amount_minor FROM instrument_positions
       WHERE instrument_id = ? AND currency = ?`,
    );
    let existing: unknown[] | null = null;
    try {
      existingStatement.bind([instrumentId, movement.currency]);
      if (existingStatement.step()) existing = existingStatement.get();
    } finally {
      existingStatement.free();
    }
    const quantity = addCanonicalDecimals(
      existing ? String(existing[0]) : "0",
      movement.quantityDelta ?? "0",
    );
    const bookAmount = (existing ? Number(existing[1]) : 0) + movement.amountMinor;
    if (!Number.isSafeInteger(bookAmount)) throw new Error("instrument position amount overflow");
    raw.run(
      `INSERT INTO instrument_positions
        (instrument_id, quantity, book_amount_minor, currency, current_event_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(instrument_id, currency) DO UPDATE SET
         quantity = excluded.quantity,
         book_amount_minor = excluded.book_amount_minor,
         current_event_id = excluded.current_event_id`,
      [instrumentId, quantity, bookAmount, movement.currency, eventId],
    );
  }

  const event: StoredLedgerEvent = {
    eventId,
    sequence,
    payloadVersion: 1,
    effectiveDate: input.effectiveDate,
    description: input.description,
    amendsEventId,
    metadataJson,
    canonicalPayload,
    previousHash: head.hash,
    hash,
    recordedAt,
  };
  return { ...event, movements };
}

/** CONTRACT-010: journal rows and their projection commit in one real SQLite transaction. */
export async function postLedgerEvent<T = void>(
  input: LedgerEventInput,
  applyProjection?: LedgerProjectionCallback<T>,
): Promise<{ event: PostedLedgerEvent; projection: T | undefined }> {
  return withDb(async (db, raw) => {
    const event = postLedgerEventRaw(raw, input);
    const projection = applyProjection ? await applyProjection(db, raw, event) : undefined;
    return { event, projection };
  });
}

export function correctLedgerEventInput(
  priorEventId: string,
  priorCurrentMovements: LedgerMovementInput[],
  nextCurrentMovements: LedgerMovementInput[],
  input: Omit<LedgerEventInput, "amendsEventId" | "movements">,
): LedgerEventInput {
  return {
    ...input,
    amendsEventId: priorEventId,
    movements: buildMovementDelta(priorCurrentMovements, nextCurrentMovements),
  };
}

export function deleteLedgerEventInput(
  priorEventId: string,
  priorCurrentMovements: LedgerMovementInput[],
  input: Omit<LedgerEventInput, "amendsEventId" | "movements">,
): LedgerEventInput {
  return {
    ...input,
    amendsEventId: priorEventId,
    movements: buildDeletionDelta(priorCurrentMovements),
  };
}
