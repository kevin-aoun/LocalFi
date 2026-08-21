import type { Database, SqlValue } from "sql.js";

import type { CashLedgerCategory, CashLedgerTransaction } from "@/lib/cash-balance";
import { readDb } from "@/lib/db/client";
import {
  cashProjectionMarker,
  deriveCashAssetProjection,
  selectCashProjectionTarget,
  type CashAssetProjection,
} from "@/lib/db/sync-cash";
import { toDateKey } from "@/lib/dates";
import { positionHoldingValues } from "@/lib/investments/positions";

import { canonicalStringify, sha256Hex } from "./canonical";
import { addCanonicalDecimals, canonicalDecimal } from "./decimal";
import { readCurrentMovements } from "./reads";
import {
  buildProjectedTransactionMovements,
  normalizeCurrentTransactionMovements,
  type CurrentTransactionAllocation,
  type CurrentTransactionFacts,
} from "./transaction-movements";
import type { CurrentLedgerMovement } from "./reads";
import type {
  CanonicalMetadata,
  LedgerCanonicalPayload,
  LedgerFailure,
  LedgerVerificationResult,
  PositionedMovement,
} from "./types";

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

function count(raw: Database, table: string): number {
  if (!/^[a-z_]+$/.test(table)) throw new Error("unsafe verification table");
  return Number(raw.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] ?? 0);
}

function failure(
  failures: LedgerFailure[],
  invariant: string,
  event?: { sequence: number; eventId: string },
): void {
  failures.push({ invariant, ...(event ?? {}) });
}

function isPayload(value: unknown): value is LedgerCanonicalPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== 1 || typeof payload.eventId !== "string" ||
    typeof payload.effectiveDate !== "string" || typeof payload.description !== "string" ||
    (payload.amendsEventId !== null && typeof payload.amendsEventId !== "string") ||
    typeof payload.metadata !== "object" || payload.metadata === null ||
    Array.isArray(payload.metadata) || !Array.isArray(payload.movements) ||
    (payload.previousHash !== null && typeof payload.previousHash !== "string") ||
    !Number.isSafeInteger(payload.recordedAt)
  ) return false;
  return payload.movements.every((movement, position) => {
    if (typeof movement !== "object" || movement === null || Array.isArray(movement)) return false;
    const item = movement as Record<string, unknown>;
    return item.position === position && typeof item.ledgerAccountId === "string" &&
      Number.isSafeInteger(item.amountMinor) && typeof item.currency === "string" &&
      (item.quantityDelta === null || typeof item.quantityDelta === "string");
  });
}

function parseMetadata(value: SqlValue): CanonicalMetadata | null {
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as CanonicalMetadata;
  } catch {
    return null;
  }
}

export type DerivedPosition = {
  instrumentId: string;
  currency: string;
  quantity: string;
  bookAmountMinor: number;
  currentEventId: string;
};

export function deriveInstrumentPositions(raw: Database): DerivedPosition[] {
  const values = new Map<string, DerivedPosition>();
  for (const row of rows(
    raw,
    `SELECT a.instrument_id, m.currency, m.amount_minor, m.quantity_delta, m.event_id
     FROM ledger_movements m
     JOIN ledger_accounts a ON a.id = m.ledger_account_id
     JOIN ledger_events e ON e.event_id = m.event_id
     WHERE a.target_type = 'instrument'
     ORDER BY e.sequence, m.position`,
  )) {
    const instrumentId = String(row.instrument_id);
    const currency = String(row.currency);
    const key = `${instrumentId}\u0000${currency}`;
    const previous = values.get(key);
    const bookAmountMinor = (previous?.bookAmountMinor ?? 0) + Number(row.amount_minor);
    if (!Number.isSafeInteger(bookAmountMinor)) throw new Error("position amount overflow");
    values.set(key, {
      instrumentId,
      currency,
      quantity: addCanonicalDecimals(
        previous?.quantity ?? "0",
        row.quantity_delta == null ? "0" : canonicalDecimal(String(row.quantity_delta)),
      ),
      bookAmountMinor,
      currentEventId: String(row.event_id),
    });
  }
  return [...values.values()].sort(
    (a, b) => a.instrumentId.localeCompare(b.instrumentId) || a.currency.localeCompare(b.currency),
  );
}

type ProjectedTransaction = {
  projectionKey: number;
  eventId: string;
  transaction: Record<string, unknown> | null;
};

export function deriveCurrentTransactions(raw: Database): ProjectedTransaction[] {
  const current = rows(
    raw,
    `SELECT e.event_id, e.metadata_json
     FROM ledger_events e
     WHERE NOT EXISTS (SELECT 1 FROM ledger_events n WHERE n.amends_event_id = e.event_id)
     ORDER BY e.sequence`,
  );
  const projected: ProjectedTransaction[] = [];
  for (const row of current) {
    const metadata = JSON.parse(String(row.metadata_json)) as CanonicalMetadata;
    if (!Object.prototype.hasOwnProperty.call(metadata, "projectionKey")) continue;
    const projectionKey = Number(metadata.projectionKey);
    if (!Number.isSafeInteger(projectionKey) || projectionKey <= 0) {
      throw new Error("invalid projection key in canonical metadata");
    }
    const transaction = metadata.transaction;
    if (transaction !== null && (typeof transaction !== "object" || Array.isArray(transaction))) {
      throw new Error("invalid transaction projection in canonical metadata");
    }
    projected.push({
      projectionKey,
      eventId: String(row.event_id),
      transaction: transaction as Record<string, unknown> | null,
    });
  }
  return projected;
}

export type DerivedCashAssetProjection =
  | { kind: "invalid-marker" }
  | (CashAssetProjection & {
      kind: "legacy" | "managed";
      assetId: number | null;
      marker: string | null;
    });


export function deriveCashAssetProjectionFromJournal(
  raw: Database,
): DerivedCashAssetProjection {
  const ledgerTransactions = deriveCurrentTransactions(raw)
    .flatMap((item) => item.transaction === null ? [] : [item.transaction])
    .map((transaction) => transaction as unknown as CashLedgerTransaction);
  const ledgerCategories = rows(raw, "SELECT id, type FROM categories ORDER BY id")
    .map((row): CashLedgerCategory => ({ id: Number(row.id), type: String(row.type) }));
  const cashAssets = rows(
    raw,
    `SELECT id, currency FROM assets
      WHERE category = 'Cash' ORDER BY id`,
  ).map((row) => ({ id: Number(row.id), currency: row.currency }));
  const projectionNames = rows(
    raw,
    `SELECT projection FROM ledger_projection_state
      WHERE projection LIKE 'cash:%' ORDER BY projection`,
  ).map((row) => String(row.projection));
  const target = selectCashProjectionTarget(projectionNames, cashAssets);
  if (target.kind === "invalid-marker") return target;
  return {
    kind: target.kind,
    assetId: target.asset?.id ?? null,
    marker: target.marker,
    ...deriveCashAssetProjection(
      ledgerTransactions,
      ledgerCategories,
      target.currency,
    ),
  };
}

export function expectedCashProjectionMarker(
  cash: Exclude<DerivedCashAssetProjection, { kind: "invalid-marker" }>,
  assetId: number,
): string {
  return cashProjectionMarker(cash.currency, assetId);
}

function cashProjectionIsRequired(raw: Database): boolean {
  const hasJournal = rows(
    raw,
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'localfi_schema_journal' LIMIT 1",
  ).length > 0;
  if (!hasJournal) return false;
  return rows(
    raw,
    `SELECT 1 FROM localfi_schema_journal
      WHERE idx = 12 AND tag = '0012_immutable-ledger' LIMIT 1`,
  ).length > 0;
}

const REQUIRED_GUARDS = [
  "ledger_accounts_validate_insert",
  "ledger_events_validate_insert",
  "ledger_movements_validate_insert",
  "ledger_events_seal_movements",
  "ledger_events_immutable_update",
  "ledger_events_immutable_delete",
  "ledger_movements_immutable_update",
  "ledger_movements_immutable_delete",
  "ledger_accounts_protect_update",
  "ledger_accounts_protect_delete",
  "instruments_protect_ledger_update",
];


export function verifyLedgerRaw(raw: Database): LedgerVerificationResult {
  const failures: LedgerFailure[] = [];
  const triggers = new Set(
    rows(raw, "SELECT name FROM sqlite_master WHERE type = 'trigger'").map((row) => String(row.name)),
  );
  for (const guard of REQUIRED_GUARDS) {
    if (!triggers.has(guard)) failure(failures, `schema.guard.${guard}`);
  }
  const targetRows = rows(
    raw,
    "SELECT id, target_type, target_ref, currency, instrument_id FROM ledger_accounts",
  );
  const targets = new Map(targetRows.map((row) => [String(row.id), row]));
  for (const target of targetRows) {
    const type = String(target.target_type);
    if (type === "instrument") {
      if (
        target.instrument_id == null ||
        rows(raw, "SELECT 1 FROM instruments WHERE id = ? LIMIT 1", [target.instrument_id]).length === 0
      ) {
        failure(failures, "target.instrument_registration");
      }
    }
  }
  const events = rows(raw, "SELECT * FROM ledger_events ORDER BY sequence");
  const eventsById = new Map(events.map((row) => [String(row.event_id), row]));
  const metadataByEventId = new Map(
    events.map((row) => [String(row.event_id), parseMetadata(row.metadata_json)]),
  );
  const amendmentTargets = new Set<string>();
  let previousHash: string | null = null;
  let movementCount = 0;

  for (let index = 0; index < events.length; index += 1) {
    const row = events[index];
    const event = { sequence: Number(row.sequence), eventId: String(row.event_id) };
    if (event.sequence !== index + 1) failure(failures, "chain.sequence", event);
    if ((row.previous_hash ?? null) !== previousHash) failure(failures, "chain.previous_hash", event);
    const amends = row.amends_event_id == null ? null : String(row.amends_event_id);
    if (amends !== null) {
      if (amendmentTargets.has(amends)) failure(failures, "amendment.duplicate", event);
      amendmentTargets.add(amends);
      const target = eventsById.get(amends);
      if (!target || Number(target.sequence) >= event.sequence) failure(failures, "amendment.order", event);
      const metadata = metadataByEventId.get(event.eventId);
      const targetMetadata = metadataByEventId.get(amends);
      const hasProjection = metadata != null &&
        Object.prototype.hasOwnProperty.call(metadata, "projectionKey");
      const targetHasProjection = targetMetadata != null &&
        Object.prototype.hasOwnProperty.call(targetMetadata, "projectionKey");
      if (hasProjection || targetHasProjection) {
        const projectionKey = hasProjection ? Number(metadata?.projectionKey) : null;
        const targetProjectionKey = targetHasProjection ? Number(targetMetadata?.projectionKey) : null;
        if (
          !Number.isSafeInteger(projectionKey) || !Number.isSafeInteger(targetProjectionKey) ||
          projectionKey === null || projectionKey <= 0 ||
          targetProjectionKey === null || targetProjectionKey <= 0 ||
          projectionKey !== targetProjectionKey
        ) failure(failures, "amendment.projection_key", event);
      }
    }

    let payload: LedgerCanonicalPayload | null = null;
    try {
      const parsed: unknown = JSON.parse(String(row.canonical_payload));
      if (!isPayload(parsed)) throw new Error("payload shape");
      payload = parsed;
      if (canonicalStringify(parsed) !== String(row.canonical_payload)) {
        failure(failures, "hash.payload_not_canonical", event);
      }
      if (sha256Hex(String(row.canonical_payload)) !== String(row.hash)) {
        failure(failures, "hash.digest", event);
      }
      if (
        payload.version !== 1 || payload.eventId !== event.eventId ||
        payload.effectiveDate !== row.effective_date || payload.description !== row.description ||
        payload.amendsEventId !== amends || payload.previousHash !== (row.previous_hash ?? null) ||
        payload.recordedAt !== Number(row.recorded_at) ||
        canonicalStringify(payload.metadata) !== String(row.metadata_json)
      ) {
        failure(failures, "hash.header_payload", event);
      }
    } catch {
      failure(failures, "hash.payload_invalid", event);
    }

    const movementRows = rows(
      raw,
      "SELECT * FROM ledger_movements WHERE event_id = ? ORDER BY position",
      [event.eventId],
    );
    movementCount += movementRows.length;
    if (movementRows.length < 2) failure(failures, "movement.minimum", event);
    const balances = new Map<string, number>();
    const normalized: PositionedMovement[] = [];
    movementRows.forEach((movement, position) => {
      if (Number(movement.position) !== position) failure(failures, "movement.position", event);
      const currency = String(movement.currency);
      const amountMinor = Number(movement.amount_minor);
      const target = targets.get(String(movement.ledger_account_id));
      if (!target || String(target.currency) !== currency) failure(failures, "movement.target", event);
      const next = (balances.get(currency) ?? 0) + amountMinor;
      if (!Number.isSafeInteger(next)) failure(failures, "movement.amount_range", event);
      balances.set(currency, next);
      let quantityDelta: string | null = null;
      if (movement.quantity_delta != null) {
        try {
          quantityDelta = canonicalDecimal(String(movement.quantity_delta));
          if (quantityDelta !== movement.quantity_delta || quantityDelta === "0") {
            failure(failures, "movement.quantity_canonical", event);
          }
          if (target?.target_type !== "instrument") failure(failures, "movement.quantity_target", event);
        } catch {
          failure(failures, "movement.quantity_invalid", event);
        }
      }
      normalized.push({
        position,
        ledgerAccountId: String(movement.ledger_account_id),
        amountMinor,
        currency,
        quantityDelta,
      });
    });
    for (const balance of balances.values()) {
      if (balance !== 0) failure(failures, "movement.currency_balance", event);
    }
    if (payload) {
      try {
        if (canonicalStringify(payload.movements) !== canonicalStringify(normalized)) {
          failure(failures, "hash.movement_payload", event);
        }
      } catch {
        failure(failures, "hash.movement_payload", event);
      }
    }
    previousHash = String(row.hash);
  }

  let currentMovements: CurrentLedgerMovement[] = [];
  try {
    currentMovements = readCurrentMovements(raw);
  } catch {
    failure(failures, "amendment.chain");
  }

  try {
    const expectedTransactions = deriveCurrentTransactions(raw);
    const expected = new Map(expectedTransactions.map((item) => [item.projectionKey, item]));
    const currentByHead = new Map<string, CurrentLedgerMovement[]>();
    for (const movement of currentMovements) {
      const bucket = currentByHead.get(movement.eventId) ?? [];
      bucket.push(movement);
      currentByHead.set(movement.eventId, bucket);
    }
    for (const item of expectedTransactions) {
      const actualCurrent = normalizeCurrentTransactionMovements(
        (currentByHead.get(item.eventId) ?? []).map((movement) => ({
          ledgerAccountId: movement.ledgerAccountId,
          amountMinor: movement.amountMinor,
          currency: movement.currency,
          quantityDelta: movement.quantityDelta,
        })),
      );
      if (item.transaction === null) {
        if (actualCurrent.length !== 0) failure(failures, "projection.transaction_deleted_movements");
        continue;
      }
      const snapshot = item.transaction as CurrentTransactionFacts & {
        date: number;
        allocations?: CurrentTransactionAllocation[];
      };
      const expectedCurrent = normalizeCurrentTransactionMovements(
        buildProjectedTransactionMovements(null, snapshot, snapshot.allocations ?? []),
      );
      if (canonicalStringify(expectedCurrent) !== canonicalStringify(actualCurrent)) {
        failure(failures, "projection.transaction_movements");
      }
      const eventRow = eventsById.get(item.eventId);
      const projectedInstant = new Date(snapshot.date * 1000);
      const localDateKey = Number.isSafeInteger(snapshot.date)
        ? toDateKey(projectedInstant)
        : null;
      const utcDateKey = Number.isSafeInteger(snapshot.date)
        ? projectedInstant.toISOString().slice(0, 10)
        : null;
      const effectiveDate = eventRow ? String(eventRow.effective_date) : null;
      // Transaction calendar days have historically been encoded as local-midnight epochs.
      // UTC-normalized portable databases use the equally valid UTC calendar interpretation.
      if (
        !Number.isSafeInteger(snapshot.date) || !eventRow ||
        (effectiveDate !== localDateKey && effectiveDate !== utcDateKey)
      ) {
        failure(failures, "projection.transaction_effective_date");
      }
    }
    const actual = rows(
      raw,
      `SELECT id, date, category_id, account_id, transfer_account_id, amount_cents, direction,
              currency, comment, pending, recurring_id, recurring_occurrence, instrument_id,
              quantity_delta, transfer_principal_amount_cents, created_at, updated_at, current_event_id
       FROM transactions WHERE pending = 0 ORDER BY id`,
    );
    if (actual.length !== [...expected.values()].filter((item) => item.transaction !== null).length) {
      failure(failures, "projection.transaction_count");
    }
    for (const row of actual) {
      const item = expected.get(Number(row.id));
      if (!item || item.transaction === null || item.eventId !== row.current_event_id) {
        failure(failures, "projection.transaction_head");
        continue;
      }
      const snapshot = {
        id: Number(row.id), date: Number(row.date),
        categoryId: row.category_id == null ? null : Number(row.category_id),
        accountId: row.account_id == null ? null : Number(row.account_id),
        transferAccountId: row.transfer_account_id == null ? null : Number(row.transfer_account_id),
        amountCents: Number(row.amount_cents), direction: String(row.direction),
        currency: String(row.currency), comment: row.comment == null ? null : String(row.comment),
        pending: false, recurringId: row.recurring_id == null ? null : Number(row.recurring_id),
        recurringOccurrence: row.recurring_occurrence == null ? null : String(row.recurring_occurrence),
        instrumentId: row.instrument_id == null ? null : String(row.instrument_id),
        quantityDelta: row.quantity_delta == null ? null : String(row.quantity_delta),
        transferPrincipalAmountCents: row.transfer_principal_amount_cents == null
          ? null : Number(row.transfer_principal_amount_cents),
        allocations: rows(
          raw,
          `SELECT category_id, amount_cents FROM transaction_allocations
           WHERE transaction_id = ? ORDER BY position`,
          [Number(row.id)],
        ).map((allocation) => ({
          categoryId: Number(allocation.category_id),
          amountCents: Number(allocation.amount_cents),
        })),
        createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      };
      if (canonicalStringify(snapshot) !== canonicalStringify(item.transaction)) {
        failure(failures, "projection.transaction_content");
      }
    }

    const expectedCash = deriveCashAssetProjectionFromJournal(raw);
    if (expectedCash.kind === "invalid-marker") {
      failure(failures, "projection.cash_marker");
    } else if (cashProjectionIsRequired(raw)) {
      if (expectedCash.assetId === null) {
        failure(failures, "projection.cash_missing");
      } else {
        const actualCash = rows(
          raw,
          `SELECT current_value_cents, currency FROM assets
            WHERE id = ? AND category = 'Cash'`,
          [expectedCash.assetId],
        )[0];
        if (
          actualCash === undefined ||
          Number(actualCash.current_value_cents) !== expectedCash.currentValueCents ||
          String(actualCash.currency) !== expectedCash.currency
        ) {
          failure(failures, "projection.cash_content");
        }
      }
    }

    const expectedPositions = deriveInstrumentPositions(raw);
    const actualPositions = rows(
      raw,
      `SELECT instrument_id, currency, quantity, book_amount_minor, current_event_id
       FROM instrument_positions ORDER BY instrument_id, currency`,
    ).map((row) => ({
      instrumentId: String(row.instrument_id), currency: String(row.currency),
      quantity: String(row.quantity), bookAmountMinor: Number(row.book_amount_minor),
      currentEventId: String(row.current_event_id),
    }));
    if (canonicalStringify(expectedPositions) !== canonicalStringify(actualPositions)) {
      failure(failures, "projection.instrument_positions");
    }

    const expectedPositionByKey = new Map(
      expectedPositions.map((position) => [`${position.instrumentId}\u0000${position.currency}`, position]),
    );
    const assetRows = rows(
      raw,
      `SELECT id, category, current_value_cents, currency, instrument_id, commodity_type,
              quantity, unit, price_symbol, priced_at, use_live_price
         FROM assets WHERE category <> 'Cash' ORDER BY id`,
    );
    const assetsByPosition = new Map<string, Row[]>();
    for (const asset of assetRows) {
      if (asset.instrument_id == null) {
        failure(failures, "projection.asset_opening_provenance");
        continue;
      }
      const key = `${String(asset.instrument_id)}\u0000${String(asset.currency)}`;
      if (!expectedPositionByKey.has(key)) {
        failure(failures, "projection.asset_without_position");
        continue;
      }
      const bucket = assetsByPosition.get(key) ?? [];
      bucket.push(asset);
      assetsByPosition.set(key, bucket);
    }
    for (const position of expectedPositions) {
      const key = `${position.instrumentId}\u0000${position.currency}`;
      const projected = assetsByPosition.get(key) ?? [];
      const isZero = position.quantity === "0" && position.bookAmountMinor === 0;
      if (isZero && projected.length > 0) {
        failure(failures, "projection.asset_zero_visible");
        continue;
      }
      if (projected.length === 0) {
        if (!isZero) failure(failures, "projection.asset_missing");
        continue;
      }
      if (projected.length !== 1) {
        failure(failures, "projection.asset_duplicate");
        continue;
      }
      const values = positionHoldingValues(raw, position);
      const actual = projected[0];
      const expectedProjection = {
        category: values.category,
        currentValueCents: values.valueMinor,
        currency: position.currency,
        instrumentId: position.instrumentId,
        commodityType: values.commodityType,
        quantity: canonicalDecimal(String(values.quantity)),
        unit: values.unit,
        priceSymbol: values.priceSymbol,
        pricedAt: values.pricedAt,
        useLivePrice: values.useLivePrice,
      };
      const actualProjection = {
        category: String(actual.category),
        currentValueCents: Number(actual.current_value_cents),
        currency: String(actual.currency),
        instrumentId: String(actual.instrument_id),
        commodityType: actual.commodity_type == null ? null : String(actual.commodity_type),
        quantity: actual.quantity == null ? null : canonicalDecimal(String(actual.quantity)),
        unit: actual.unit == null ? null : String(actual.unit),
        priceSymbol: actual.price_symbol == null ? null : String(actual.price_symbol),
        pricedAt: actual.priced_at == null ? null : Number(actual.priced_at),
        useLivePrice: Number(actual.use_live_price) === 1,
      };
      if (canonicalStringify(expectedProjection) !== canonicalStringify(actualProjection)) {
        failure(failures, "projection.asset_content");
      }
    }
  } catch {
    failure(failures, "projection.replay_invalid");
  }

  const result: LedgerVerificationResult = {
    ok: failures.length === 0,
    counts: {
      events: events.length,
      movements: movementCount,
      ledgerAccounts: targetRows.length,
      instruments: count(raw, "instruments"),
      projectionRows: count(raw, "transactions") + count(raw, "instrument_positions") +
        count(raw, "assets"),
    },
    failures,
  };
  return result;
}

export function verifyLedger(): Promise<LedgerVerificationResult> {
  return readDb((_db, raw) => verifyLedgerRaw(raw));
}
