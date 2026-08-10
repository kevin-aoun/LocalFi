import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

import { instruments } from "./instruments";

/** DECISION: DEC-010 — all movement destinations use one registered abstraction. */
export const ledgerAccountTargetTypes = [
  "real_account",
  "category",
  "instrument",
  "system",
] as const;
export type LedgerAccountTargetType = (typeof ledgerAccountTargetTypes)[number];

export const ledgerAccounts = sqliteTable(
  "ledger_accounts",
  {
    id: text("id").primaryKey(),
    targetType: text("target_type", { enum: ledgerAccountTargetTypes }).notNull(),
    targetRef: text("target_ref").notNull(),
    currency: text("currency").notNull(),
    instrumentId: text("instrument_id").references(() => instruments.id, {
      onDelete: "restrict",
    }),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (table) => ({
    targetUnique: uniqueIndex("ledger_accounts_target_unique").on(
      table.targetType,
      table.targetRef,
      table.currency,
    ),
    targetIdx: index("ledger_accounts_target_idx").on(table.targetType, table.targetRef),
    typeValid: check(
      "ledger_accounts_type_valid",
      sql`${table.targetType} IN ('real_account', 'category', 'instrument', 'system')`,
    ),
    refValid: check("ledger_accounts_ref_valid", sql`length(trim(${table.targetRef})) > 0`),
    currencyValid: check(
      "ledger_accounts_currency_valid",
      sql`${table.currency} GLOB '[A-Z][A-Z][A-Z]'`,
    ),
    instrumentShape: check(
      "ledger_accounts_instrument_shape",
      sql`(${table.targetType} = 'instrument') = (${table.instrumentId} IS NOT NULL)`,
    ),
  }),
);

/** DECISION: DEC-014 — the UUID is the event identity; sequence is chain order only. */
export const ledgerEvents = sqliteTable(
  "ledger_events",
  {
    eventId: text("event_id").primaryKey(),
    sequence: integer("sequence").notNull(),
    payloadVersion: integer("payload_version").notNull(),
    effectiveDate: text("effective_date").notNull(),
    description: text("description").notNull(),
    amendsEventId: text("amends_event_id").references((): AnySQLiteColumn => ledgerEvents.eventId, {
      onDelete: "restrict",
    }),
    metadataJson: text("metadata_json").notNull(),
    canonicalPayload: text("canonical_payload").notNull(),
    previousHash: text("previous_hash"),
    hash: text("hash").notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (table) => ({
    sequenceUnique: uniqueIndex("ledger_events_sequence_unique").on(table.sequence),
    hashUnique: uniqueIndex("ledger_events_hash_unique").on(table.hash),
    amendedOnce: uniqueIndex("ledger_events_amended_once_unique")
      .on(table.amendsEventId)
      .where(sql`amends_event_id IS NOT NULL`),
    sequenceValid: check(
      "ledger_events_sequence_valid",
      sql`typeof(${table.sequence}) = 'integer' AND ${table.sequence} > 0`,
    ),
    versionValid: check(
      "ledger_events_payload_version_valid",
      sql`typeof(${table.payloadVersion}) = 'integer' AND ${table.payloadVersion} = 1`,
    ),
    effectiveDateValid: check(
      "ledger_events_effective_date_valid",
      sql`${table.effectiveDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(${table.effectiveDate}, '+0 days') = ${table.effectiveDate}`,
    ),
    previousHashValid: check(
      "ledger_events_previous_hash_valid",
      sql`${table.previousHash} IS NULL OR (length(${table.previousHash}) = 64 AND ${table.previousHash} NOT GLOB '*[^0-9a-f]*')`,
    ),
    hashValid: check(
      "ledger_events_hash_valid",
      sql`length(${table.hash}) = 64 AND ${table.hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
  }),
);

/** A movement is identified only by its owning event UUID and ordered position. */
export const ledgerMovements = sqliteTable(
  "ledger_movements",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => ledgerEvents.eventId, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    ledgerAccountId: text("ledger_account_id")
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    /** Exact canonical decimal text; never a binary floating-point quantity. */
    quantityDelta: text("quantity_delta"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.eventId, table.position] }),
    accountIdx: index("ledger_movements_account_idx").on(table.ledgerAccountId),
    positionValid: check(
      "ledger_movements_position_valid",
      sql`typeof(${table.position}) = 'integer' AND ${table.position} >= 0`,
    ),
    amountValid: check(
      "ledger_movements_amount_valid",
      sql`typeof(${table.amountMinor}) = 'integer'`,
    ),
    currencyValid: check(
      "ledger_movements_currency_valid",
      sql`${table.currency} GLOB '[A-Z][A-Z][A-Z]'`,
    ),
  }),
);

export const ledgerProjectionState = sqliteTable("ledger_projection_state", {
  projection: text("projection").primaryKey(),
  lastEventId: text("last_event_id").references(() => ledgerEvents.eventId, {
    onDelete: "restrict",
  }),
  lastEventHash: text("last_event_hash"),
  eventCount: integer("event_count").notNull().default(0),
  rebuiltAt: integer("rebuilt_at"),
  verifiedAt: integer("verified_at"),
});

export const instrumentPositions = sqliteTable("instrument_positions", {
  instrumentId: text("instrument_id")
    .notNull()
    .references(() => instruments.id, { onDelete: "restrict" }),
  quantity: text("quantity").notNull(),
  bookAmountMinor: integer("book_amount_minor").notNull(),
  currency: text("currency").notNull(),
  currentEventId: text("current_event_id")
    .notNull()
    .references(() => ledgerEvents.eventId, { onDelete: "restrict" }),
}, (table) => ({
  pk: primaryKey({ columns: [table.instrumentId, table.currency] }),
}));

export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type NewLedgerAccount = typeof ledgerAccounts.$inferInsert;
export type LedgerEvent = typeof ledgerEvents.$inferSelect;
export type NewLedgerEvent = typeof ledgerEvents.$inferInsert;
export type LedgerMovement = typeof ledgerMovements.$inferSelect;
export type NewLedgerMovement = typeof ledgerMovements.$inferInsert;
