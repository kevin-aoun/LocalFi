import type { Database } from "sql.js";

import { isDateKey, type DateKey } from "@/lib/dates";
import { quantityValueMinor } from "@/lib/investments/positions";
import { addCanonicalDecimals, canonicalDecimal } from "./decimal";

type SqlValue = string | number | Uint8Array | null;
type Row = Record<string, SqlValue>;

function rows(raw: Database, sql: string, params: Array<string | number> = []): Row[] {
  const statement = raw.prepare(sql);
  try {
    statement.bind(params);
    const out: Row[] = [];
    while (statement.step()) out.push(statement.getAsObject() as Row);
    return out;
  } finally {
    statement.free();
  }
}

function safeInteger(value: SqlValue, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is not a safe integer`);
  return parsed;
}

function targetId(value: SqlValue, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function validateRange(fromKey?: DateKey, toKey?: DateKey): void {
  if (fromKey !== undefined && !isDateKey(fromKey)) throw new Error(`Invalid fromKey: ${fromKey}`);
  if (toKey !== undefined && !isDateKey(toKey)) throw new Error(`Invalid toKey: ${toKey}`);
}

export type CurrentLedgerMovement = {
  chainRootEventId: string;
  eventId: string;
  sequence: number;
  position: number;
  dateKey: DateKey;
  ledgerAccountId: string;
  targetType: "real_account" | "category" | "instrument" | "system";
  targetRef: string;
  instrumentId: string | null;
  amountMinor: number;
  currency: string;
  quantityDelta: string | null;
};

function movementsInRange(
  movements: readonly CurrentLedgerMovement[],
  fromKey?: DateKey,
  toKey?: DateKey,
): CurrentLedgerMovement[] {
  return movements.filter((movement) =>
    (fromKey === undefined || movement.dateKey >= fromKey) &&
    (toKey === undefined || movement.dateKey <= toKey)
  );
}

type ChainEvent = {
  eventId: string;
  sequence: number;
  effectiveDate: DateKey;
  amendsEventId: string | null;
};


export function readCurrentMovements(
  raw: Database,
  options: { fromKey?: DateKey; toKey?: DateKey } = {},
): CurrentLedgerMovement[] {
  validateRange(options.fromKey, options.toKey);
  const events = rows(
    raw,
    `SELECT event_id, sequence, effective_date, amends_event_id
       FROM ledger_events ORDER BY sequence`,
  ).map((row): ChainEvent => ({
    eventId: String(row.event_id),
    sequence: safeInteger(row.sequence, "ledger sequence"),
    effectiveDate: String(row.effective_date) as DateKey,
    amendsEventId: row.amends_event_id == null ? null : String(row.amends_event_id),
  }));
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  const childByParent = new Map<string, ChainEvent>();
  for (const event of events) {
    if (event.amendsEventId === null) continue;
    if (!eventById.has(event.amendsEventId)) {
      throw new Error(`Ledger amendment ${event.eventId} targets a missing event`);
    }
    if (childByParent.has(event.amendsEventId)) {
      throw new Error(`Ledger event ${event.amendsEventId} has multiple amendments`);
    }
    childByParent.set(event.amendsEventId, event);
  }

  const movementRows = rows(
    raw,
    `SELECT m.event_id, m.position, m.ledger_account_id, m.amount_minor, m.currency,
            m.quantity_delta, la.target_type, la.target_ref, la.instrument_id
       FROM ledger_movements m
       JOIN ledger_events e ON e.event_id = m.event_id
       JOIN ledger_accounts la ON la.id = m.ledger_account_id
      ORDER BY e.sequence, m.position`,
  );
  const movementsByEvent = new Map<string, Row[]>();
  for (const movement of movementRows) {
    const eventId = String(movement.event_id);
    const bucket = movementsByEvent.get(eventId) ?? [];
    bucket.push(movement);
    movementsByEvent.set(eventId, bucket);
  }

  const current: CurrentLedgerMovement[] = [];
  const visited = new Set<string>();
  for (const root of events) {
    if (root.amendsEventId !== null) continue;
    const chain: ChainEvent[] = [];
    let cursor: ChainEvent | undefined = root;
    while (cursor) {
      if (visited.has(cursor.eventId)) throw new Error("Ledger amendment chain contains a cycle");
      visited.add(cursor.eventId);
      chain.push(cursor);
      cursor = childByParent.get(cursor.eventId);
    }
    const head = chain[chain.length - 1];
    if (options.fromKey && head.effectiveDate < options.fromKey) continue;
    if (options.toKey && head.effectiveDate > options.toKey) continue;

    const totals = new Map<string, Omit<CurrentLedgerMovement, "position">>();
    for (const event of chain) {
      for (const movement of movementsByEvent.get(event.eventId) ?? []) {
        const ledgerAccountId = String(movement.ledger_account_id);
        const currency = String(movement.currency);
        const key = `${ledgerAccountId}\u0000${currency}`;
        const previous = totals.get(key);
        const amountMinor = (previous?.amountMinor ?? 0) +
          safeInteger(movement.amount_minor, "movement amount");
        if (!Number.isSafeInteger(amountMinor)) throw new Error("Current movement amount overflow");
        const quantityDelta = addCanonicalDecimals(
          previous?.quantityDelta ?? "0",
          movement.quantity_delta == null ? "0" : canonicalDecimal(String(movement.quantity_delta)),
        );
        const targetType = String(movement.target_type);
        if (![
          "real_account",
          "category",
          "instrument",
          "system",
        ].includes(targetType)) throw new Error(`Unknown ledger target type ${targetType}`);
        totals.set(key, {
          chainRootEventId: root.eventId,
          eventId: head.eventId,
          sequence: head.sequence,
          dateKey: head.effectiveDate,
          ledgerAccountId,
          targetType: targetType as CurrentLedgerMovement["targetType"],
          targetRef: String(movement.target_ref),
          instrumentId: movement.instrument_id == null ? null : String(movement.instrument_id),
          amountMinor,
          currency,
          quantityDelta: quantityDelta === "0" ? null : quantityDelta,
        });
      }
    }
    [...totals.values()]
      .filter((movement) => movement.amountMinor !== 0 || movement.quantityDelta !== null)
      .sort((a, b) => a.currency.localeCompare(b.currency) ||
        a.ledgerAccountId.localeCompare(b.ledgerAccountId))
      .forEach((movement, position) => current.push({ ...movement, position }));
  }
  if (visited.size !== events.length) throw new Error("Ledger contains an amendment without a root");
  return current.sort(
    (a, b) => a.dateKey.localeCompare(b.dateKey) || a.sequence - b.sequence || a.position - b.position,
  );
}

export type SignedAccountMovement = {
  chainRootEventId: string;
  eventId: string;
  sequence: number;
  position: number;
  dateKey: DateKey;
  accountId: number;
  amountCents: number;
  currency: string;
};

export type SignedCategoryMovement = {
  chainRootEventId: string;
  eventId: string;
  sequence: number;
  position: number;
  dateKey: DateKey;
  categoryId: number;

  movementCents: number;
  currency: string;
};


export function readUnassignedAccountMovements(
  raw: Database,
  options: {
    fromKey?: DateKey;
    toKey?: DateKey;
    currentMovements?: readonly CurrentLedgerMovement[];
  } = {},
): Omit<SignedAccountMovement, "accountId">[] {
  validateRange(options.fromKey, options.toKey);
  const current = options.currentMovements
    ? movementsInRange(options.currentMovements, options.fromKey, options.toKey)
    : readCurrentMovements(raw, options);
  return current
    .filter((movement) =>
      movement.targetType === "system" && movement.targetRef === "legacy-unassigned-account"
    ).map((movement) => ({
    chainRootEventId: movement.chainRootEventId,
    eventId: movement.eventId,
    sequence: movement.sequence,
    position: movement.position,
    dateKey: movement.dateKey,
    amountCents: movement.amountMinor,
    currency: movement.currency,
  }));
}

function readTargetMovements(
  raw: Database,
  targetType: "real_account" | "category",
  fromKey?: DateKey,
  toKey?: DateKey,
): CurrentLedgerMovement[] {
  return readCurrentMovements(raw, { fromKey, toKey })
    .filter((movement) => movement.targetType === targetType);
}


export function readAccountMovements(
  raw: Database,
  options: { fromKey?: DateKey; toKey?: DateKey } = {},
): SignedAccountMovement[] {
  return readTargetMovements(raw, "real_account", options.fromKey, options.toKey).map((row) => ({
    chainRootEventId: row.chainRootEventId,
    eventId: row.eventId,
    sequence: row.sequence,
    position: row.position,
    dateKey: row.dateKey,
    accountId: targetId(row.targetRef, "real-account target"),
    amountCents: row.amountMinor,
    currency: row.currency,
  }));
}


export function readCategoryMovements(
  raw: Database,
  options: { fromKey?: DateKey; toKey?: DateKey } = {},
): SignedCategoryMovement[] {
  return readTargetMovements(raw, "category", options.fromKey, options.toKey).map((row) => ({
    chainRootEventId: row.chainRootEventId,
    eventId: row.eventId,
    sequence: row.sequence,
    position: row.position,
    dateKey: row.dateKey,
    categoryId: targetId(row.targetRef, "category target"),
    movementCents: row.amountMinor,
    currency: row.currency,
  }));
}

export type LedgerAccountBalance = {
  accountId: number;
  currency: string;
  balanceCents: number;
  openingCents: number;
  activityCents: number;
};


export function readAccountBalances(
  raw: Database,
  options: {
    asOfKey?: DateKey;
    currentMovements?: readonly CurrentLedgerMovement[];
  } = {},
): LedgerAccountBalance[] {
  const current = options.currentMovements
    ? movementsInRange(options.currentMovements, undefined, options.asOfKey)
    : readCurrentMovements(raw, { toKey: options.asOfKey });
  const movements = current
    .filter((movement) => movement.targetType === "real_account")
    .map((row) => ({
      chainRootEventId: row.chainRootEventId,
      eventId: row.eventId,
      sequence: row.sequence,
      position: row.position,
      dateKey: row.dateKey,
      accountId: targetId(row.targetRef, "real-account target"),
      amountCents: row.amountMinor,
      currency: row.currency,
    }));
  const openingChains = new Set(
    current
      .filter((movement) =>
        movement.targetType === "system" && movement.targetRef === "opening-balance"
      )
      .map((movement) => movement.chainRootEventId),
  );
  const balances = new Map<string, LedgerAccountBalance>();
  for (const movement of movements) {
    const key = `${movement.accountId}\u0000${movement.currency}`;
    const balance = balances.get(key) ?? {
      accountId: movement.accountId,
      currency: movement.currency,
      balanceCents: 0,
      openingCents: 0,
      activityCents: 0,
    };
    balance.balanceCents += movement.amountCents;
    if (openingChains.has(movement.chainRootEventId)) balance.openingCents += movement.amountCents;
    else balance.activityCents += movement.amountCents;
    if (!Number.isSafeInteger(balance.balanceCents)) throw new Error("Account balance overflow");
    balances.set(key, balance);
  }
  return [...balances.values()].sort(
    (a, b) => a.accountId - b.accountId || a.currency.localeCompare(b.currency),
  );
}

export type ExactPositionState = {
  instrumentId: string;
  currency: string;
  quantity: string;
  bookAmountMinor: number;
};


export function readPositionStates(
  raw: Database,
  asOfKey?: DateKey,
  currentMovements?: readonly CurrentLedgerMovement[],
): ExactPositionState[] {
  if (asOfKey !== undefined && !isDateKey(asOfKey)) throw new Error(`Invalid asOfKey: ${asOfKey}`);
  const current = currentMovements
    ? movementsInRange(currentMovements, undefined, asOfKey)
    : readCurrentMovements(raw, { toKey: asOfKey });
  const movementRows = current
    .filter((movement) => movement.targetType === "instrument");
  const states = new Map<string, ExactPositionState>();
  for (const row of movementRows) {
    if (row.instrumentId === null) throw new Error("Instrument movement has no instrument id");
    const instrumentId = row.instrumentId;
    const currency = row.currency;
    const key = `${instrumentId}\u0000${currency}`;
    const state = states.get(key) ?? { instrumentId, currency, quantity: "0", bookAmountMinor: 0 };
    state.bookAmountMinor += row.amountMinor;
    state.quantity = addCanonicalDecimals(
      state.quantity,
      row.quantityDelta ?? "0",
    );
    if (!Number.isSafeInteger(state.bookAmountMinor)) throw new Error("Position amount overflow");
    states.set(key, state);
  }
  return [...states.values()].sort(
    (a, b) => a.instrumentId.localeCompare(b.instrumentId) || a.currency.localeCompare(b.currency),
  );
}

export type PositionValuation = ExactPositionState & {
  assetId: number | null;
  archived: boolean;
  label: string;
  category: string;
  observationKind: "price" | "valuation";
  observedDay: DateKey | null;
  valueMinor: number;
};


export function readPositionValuations(
  raw: Database,
  asOfKey: DateKey,
  currentMovements?: readonly CurrentLedgerMovement[],
): PositionValuation[] {
  if (!isDateKey(asOfKey)) throw new Error(`Invalid asOfKey: ${asOfKey}`);
  const out: PositionValuation[] = [];
  for (const state of readPositionStates(raw, asOfKey, currentMovements)) {
    const instrument = rows(
      raw,
      "SELECT kind, label, category FROM instruments WHERE id = ? LIMIT 1",
      [state.instrumentId],
    )[0];
    if (!instrument) throw new Error(`Missing instrument ${state.instrumentId}`);
    const observation = rows(
      raw,
      `SELECT observation_kind, observed_day, amount_minor
         FROM instrument_observations
        WHERE instrument_id = ? AND currency = ?
          AND observed_day <= ?
        ORDER BY observed_day DESC, observed_at DESC,
                 CASE observation_kind WHEN 'valuation' THEN 0 ELSE 1 END
        LIMIT 1`,
      [state.instrumentId, state.currency, asOfKey],
    )[0];
    const projection = rows(
      raw,
      `SELECT id, archived FROM assets
        WHERE instrument_id = ? AND currency = ? ORDER BY id LIMIT 1`,
      [state.instrumentId, state.currency],
    )[0];
    const observedAmount = observation
      ? safeInteger(observation.amount_minor, "observation amount")
      : 0;
    const observationKind = observation?.observation_kind === "valuation" ? "valuation" : "price";
    out.push({
      ...state,
      assetId: projection ? targetId(projection.id, "asset projection") : null,
      archived: projection ? Number(projection.archived) === 1 : false,
      label: String(instrument.label),
      category: instrument.category == null ? "Other" : String(instrument.category),
      observationKind,
      observedDay: observation ? String(observation.observed_day) as DateKey : null,
      valueMinor: !observation
        ? 0
        : observationKind === "valuation"
        ? observedAmount
        : quantityValueMinor(state.quantity, observedAmount),
    });
  }
  return out;
}

export type PositionHistoryPoint = PositionValuation & { dateKey: DateKey };


export function readPositionHistory(raw: Database): PositionHistoryPoint[] {
  const days = [...new Set([
    ...readCurrentMovements(raw)
      .filter((movement) => movement.targetType === "instrument")
      .map((movement) => movement.dateKey),
    ...rows(raw, "SELECT observed_day FROM instrument_observations")
      .map((row) => String(row.observed_day) as DateKey),
  ])].sort();
  return days.flatMap((dateKey) =>
    readPositionValuations(raw, dateKey).map((valuation) => ({ ...valuation, dateKey })),
  );
}
