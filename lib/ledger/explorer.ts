import type { Database, SqlValue } from "sql.js";

import { readDb } from "@/lib/db/client";
import { isDateKey, type DateKey } from "@/lib/dates";
import {
  ledgerAccountTargetTypes,
  type LedgerAccountTargetType,
} from "@/lib/db/schema/ledger";
import {
  LEDGER_EXPLORER_DEFAULT_PAGE_SIZE,
  LEDGER_EXPLORER_MAX_PAGE_SIZE,
  LEDGER_EXPLORER_MAX_PAYLOAD_CHARS,
  type LedgerEventPayload,
  type LedgerExplorerEvent,
  type LedgerExplorerMovement,
  type LedgerExplorerPage,
  type LedgerExplorerQuery,
} from "./explorer-contract";

type Row = Record<string, SqlValue>;

function rows(raw: Database, query: string, parameters: SqlValue[] = []): Row[] {
  const statement = raw.prepare(query);
  try {
    statement.bind(parameters);
    const result: Row[] = [];
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally {
    statement.free();
  }
}

function positiveInteger(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeDate(value: string | null | undefined, label: string): DateKey | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const normalized = value.trim();
  if (!isDateKey(normalized)) throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  return normalized;
}

function normalizeTargetType(value: string | null | undefined): LedgerAccountTargetType | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  if (!ledgerAccountTargetTypes.includes(value as LedgerAccountTargetType)) {
    throw new Error("targetType is not a supported ledger target type");
  }
  return value as LedgerAccountTargetType;
}

function normalizeCurrency(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter code");
  return currency;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function eventFact(metadata: Record<string, unknown> | null, isCorrection: boolean): string {
  const direct = metadata?.fact;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const provenance = metadata?.provenance;
  if (typeof provenance === "object" && provenance !== null && !Array.isArray(provenance)) {
    const fact = (provenance as Record<string, unknown>).fact;
    if (typeof fact === "string" && fact.trim()) return fact.trim();
  }
  if (metadata && Object.prototype.hasOwnProperty.call(metadata, "projectionKey")) {
    if (metadata.transaction === null) return "transaction deletion";
    return isCorrection ? "transaction correction" : "transaction";
  }
  return isCorrection ? "correction" : "journal event";
}

function friendlySystemLabel(targetRef: string): string {
  const words = targetRef.replace(/[:._-]+/g, " ").trim();
  return words ? words.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "System";
}

function targetLabel(row: Row): string {
  const targetType = String(row.target_type) as LedgerAccountTargetType;
  const targetRef = String(row.target_ref);
  const registered = row.target_name == null ? null : String(row.target_name).trim();
  if (registered) return registered;
  if (targetType === "system") return friendlySystemLabel(targetRef);
  return `${targetType.replace("_", " ")} ${targetRef}`;
}

function safeInteger(value: SqlValue, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} is outside the safe integer range`);
  return number;
}

function normalizeEventId(value: string): string {
  const eventId = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)) {
    throw new Error("eventId must be a UUID");
  }
  return eventId;
}

function boundedPayload(value: SqlValue, label: string): string {
  const serialized = String(value);
  if (serialized.length > LEDGER_EXPLORER_MAX_PAYLOAD_CHARS) {
    throw new Error(`${label} is too large to display`);
  }
  return serialized;
}


export function readLedgerExplorerPageRaw(
  raw: Database,
  input: LedgerExplorerQuery = {},
): LedgerExplorerPage {
  const beforeSequence = positiveInteger(input.beforeSequence, "beforeSequence");
  const requestedPageSize = positiveInteger(input.pageSize, "pageSize");
  const pageSize = Math.min(requestedPageSize ?? LEDGER_EXPLORER_DEFAULT_PAGE_SIZE, LEDGER_EXPLORER_MAX_PAGE_SIZE);
  const fromDate = normalizeDate(input.filters?.fromDate, "fromDate");
  const toDate = normalizeDate(input.filters?.toDate, "toDate");
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error("fromDate cannot be after toDate");
  }
  const currency = normalizeCurrency(input.filters?.currency);
  const targetType = normalizeTargetType(input.filters?.targetType);
  const search = input.filters?.search?.trim().slice(0, 200) ?? "";

  const where: string[] = [];
  const parameters: SqlValue[] = [];
  if (beforeSequence !== null) {
    where.push("e.sequence < ?");
    parameters.push(beforeSequence);
  }
  if (fromDate !== null) {
    where.push("e.effective_date >= ?");
    parameters.push(fromDate);
  }
  if (toDate !== null) {
    where.push("e.effective_date <= ?");
    parameters.push(toDate);
  }
  if (currency !== null) {
    where.push(
      "EXISTS (SELECT 1 FROM ledger_movements fm WHERE fm.event_id = e.event_id AND fm.currency = ?)",
    );
    parameters.push(currency);
  }
  if (targetType !== null) {
    where.push(
      "EXISTS (SELECT 1 FROM ledger_movements ftm " +
        "JOIN ledger_accounts fta ON fta.id = ftm.ledger_account_id " +
        "WHERE ftm.event_id = e.event_id AND fta.target_type = ?)",
    );
    parameters.push(targetType);
  }
  if (search) {
    const searchedSequence = /^\d+$/.test(search) ? Number(search) : null;
    if (searchedSequence !== null && Number.isSafeInteger(searchedSequence)) {
      where.push("e.sequence = ?");
      parameters.push(searchedSequence);
    } else {
      const pattern = `%${escapeLike(search.toLowerCase())}%`;
      where.push(`(
      lower(e.description) LIKE ? ESCAPE '\\'
      OR lower(e.event_id) LIKE ? ESCAPE '\\'
      OR lower(e.hash) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(e.previous_hash, '')) LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1
        FROM ledger_movements fsm
        JOIN ledger_accounts fsa ON fsa.id = fsm.ledger_account_id
        LEFT JOIN accounts fac
          ON fsa.target_type = 'real_account'
         AND CAST(fac.id AS TEXT) = fsa.target_ref
        LEFT JOIN categories fca
          ON fsa.target_type = 'category'
         AND CAST(fca.id AS TEXT) = fsa.target_ref
        LEFT JOIN instruments fin
          ON fsa.target_type = 'instrument'
         AND fin.id = fsa.instrument_id
        WHERE fsm.event_id = e.event_id
          AND lower(COALESCE(fac.name, fca.name, fin.label, fin.symbol, fsa.target_ref))
              LIKE ? ESCAPE '\\'
      )
    )`);
      parameters.push(pattern, pattern, pattern, pattern, pattern);
    }
  }

  const eventRows = rows(
    raw,
    `SELECT e.event_id, e.sequence, e.payload_version, e.effective_date,
            e.recorded_at, e.description, e.metadata_json, e.hash,
            e.previous_hash, e.amends_event_id,
            amended.sequence AS amends_sequence
       FROM ledger_events e
       LEFT JOIN ledger_events amended ON amended.event_id = e.amends_event_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY e.sequence DESC
      LIMIT ?`,
    [...parameters, pageSize + 1],
  );
  const hasMore = eventRows.length > pageSize;
  const pageRows = hasMore ? eventRows.slice(0, pageSize) : eventRows;
  const eventIds = pageRows.map((row) => String(row.event_id));
  const movementRows = eventIds.length === 0
    ? []
    : rows(
        raw,
        `SELECT m.*, a.target_type, a.target_ref,
                COALESCE(ac.name, ca.name, i.label, i.symbol) AS target_name,
                e.sequence AS event_sequence
           FROM ledger_movements m
           JOIN ledger_events e ON e.event_id = m.event_id
           JOIN ledger_accounts a ON a.id = m.ledger_account_id
           LEFT JOIN accounts ac
             ON a.target_type = 'real_account' AND CAST(ac.id AS TEXT) = a.target_ref
           LEFT JOIN categories ca
             ON a.target_type = 'category' AND CAST(ca.id AS TEXT) = a.target_ref
           LEFT JOIN instruments i
             ON a.target_type = 'instrument' AND i.id = a.instrument_id
          WHERE m.event_id IN (${eventIds.map(() => "?").join(",")})
          ORDER BY e.sequence DESC, m.position ASC`,
        eventIds,
      );

  const movementsByEvent = new Map<string, LedgerExplorerMovement[]>();
  for (const row of movementRows) {
    const eventId = String(row.event_id);
    const movement: LedgerExplorerMovement = {
      position: safeInteger(row.position, "movement position"),
      ledgerAccountId: String(row.ledger_account_id),
      targetType: String(row.target_type) as LedgerAccountTargetType,
      targetRef: String(row.target_ref),
      targetLabel: targetLabel(row),
      amountMinor: safeInteger(row.amount_minor, "movement amount"),
      currency: String(row.currency),
      quantityDelta: row.quantity_delta == null ? null : String(row.quantity_delta),
    };
    const bucket = movementsByEvent.get(eventId) ?? [];
    bucket.push(movement);
    movementsByEvent.set(eventId, bucket);
  }

  const events = pageRows.map((row): LedgerExplorerEvent => {
    const metadataJson = String(row.metadata_json);
    const metadata = parseObject(metadataJson);
    const movements = movementsByEvent.get(String(row.event_id)) ?? [];
    const balances = new Map<string, number>();
    for (const movement of movements) {
      const balance = (balances.get(movement.currency) ?? 0) + movement.amountMinor;
      if (!Number.isSafeInteger(balance)) throw new Error("movement balance is outside the safe integer range");
      balances.set(movement.currency, balance);
    }
    const recordedAt = safeInteger(row.recorded_at, "recorded_at");
    return {
      eventId: String(row.event_id),
      sequence: safeInteger(row.sequence, "event sequence"),
      payloadVersion: safeInteger(row.payload_version, "payload version"),
      effectiveDate: String(row.effective_date) as DateKey,
      recordedAt: new Date(recordedAt * 1000).toISOString(),
      description: String(row.description),
      eventFact: eventFact(metadata, row.amends_event_id != null),
      hash: String(row.hash),
      previousHash: row.previous_hash == null ? null : String(row.previous_hash),
      amendsEventId: row.amends_event_id == null ? null : String(row.amends_event_id),
      amendsSequence: row.amends_sequence == null
        ? null
        : safeInteger(row.amends_sequence, "amended event sequence"),
      movements,
      balances: [...balances.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([balanceCurrency, amountMinor]) => ({ currency: balanceCurrency, amountMinor })),
    };
  });

  const countRow = rows(
    raw,
    `SELECT
       (SELECT COUNT(*) FROM ledger_events) AS event_count,
       (SELECT COUNT(*) FROM ledger_movements) AS movement_count`,
  )[0];
  const head = rows(
    raw,
    "SELECT sequence, event_id, hash FROM ledger_events ORDER BY sequence DESC LIMIT 1",
  )[0];
  const currencies = rows(
    raw,
    "SELECT DISTINCT currency FROM ledger_movements ORDER BY currency",
  ).map((row) => String(row.currency));

  return {
    events,
    nextBeforeSequence: hasMore && events.length > 0
      ? events[events.length - 1].sequence
      : null,
    pageSize,
    stats: {
      eventCount: safeInteger(countRow?.event_count ?? 0, "event count"),
      movementCount: safeInteger(countRow?.movement_count ?? 0, "movement count"),
      chainHead: head
        ? {
            sequence: safeInteger(head.sequence, "chain head sequence"),
            eventId: String(head.event_id),
            hash: String(head.hash),
          }
        : null,
      currencies,
    },
  };
}

export function readLedgerExplorerPage(
  input: LedgerExplorerQuery = {},
): Promise<LedgerExplorerPage> {
  return readDb((_db, raw) => readLedgerExplorerPageRaw(raw, input));
}


export function readLedgerEventPayloadRaw(
  raw: Database,
  requestedEventId: string,
): LedgerEventPayload {
  const eventId = normalizeEventId(requestedEventId);
  const row = rows(
    raw,
    `SELECT event_id, metadata_json, canonical_payload
       FROM ledger_events
      WHERE event_id = ?
      LIMIT 1`,
    [eventId],
  )[0];
  if (!row) throw new Error("Ledger event was not found");

  const metadataJson = boundedPayload(row.metadata_json, "canonical metadata");
  return {
    eventId: String(row.event_id),
    metadataJson,
    canonicalPayload: boundedPayload(row.canonical_payload, "canonical payload"),
    metadataValid: parseObject(metadataJson) !== null,
  };
}

export function readLedgerEventPayload(eventId: string): Promise<LedgerEventPayload> {
  return readDb((_db, raw) => readLedgerEventPayloadRaw(raw, eventId));
}
