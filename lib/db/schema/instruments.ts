import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const instrumentKinds = ["currency", "security", "commodity", "manual"] as const;
export type InstrumentKind = (typeof instrumentKinds)[number];

export const instruments = sqliteTable(
  "instruments",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: instrumentKinds }).notNull(),
    label: text("label").notNull(),
    symbol: text("symbol"),
    unit: text("unit").notNull(),
    category: text("category"),
    priceSource: text("price_source"),
    priceCurrency: text("price_currency"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (table) => ({
    kindSymbolIdx: index("instruments_kind_symbol_idx")
      .on(table.kind, table.symbol)
      .where(sql`symbol IS NOT NULL`),
    kindIdx: index("instruments_kind_idx").on(table.kind),
    kindValid: check(
      "instruments_kind_valid",
      sql`${table.kind} IN ('currency', 'security', 'commodity', 'manual')`,
    ),
    labelValid: check("instruments_label_valid", sql`length(trim(${table.label})) > 0`),
    unitValid: check("instruments_unit_valid", sql`length(trim(${table.unit})) > 0`),
    priceCurrencyValid: check(
      "instruments_price_currency_valid",
      sql`${table.priceCurrency} IS NULL OR ${table.priceCurrency} GLOB '[A-Z][A-Z][A-Z]'`,
    ),
  }),
);

export const instrumentObservationKinds = ["price", "valuation"] as const;
export type InstrumentObservationKind = (typeof instrumentObservationKinds)[number];

export const instrumentObservations = sqliteTable(
  "instrument_observations",
  {
    instrumentId: text("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "restrict" }),
    observationKind: text("observation_kind", { enum: instrumentObservationKinds }).notNull(),
    observedDay: text("observed_day").notNull(),
    observedAt: integer("observed_at").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    source: text("source"),
  },
  (table) => ({
    latestDayUnique: uniqueIndex("instrument_observations_latest_day_unique").on(
      table.instrumentId,
      table.observationKind,
      table.observedDay,
    ),
    observedAtIdx: index("instrument_observations_observed_at_idx").on(table.observedAt),
    kindValid: check(
      "instrument_observations_kind_valid",
      sql`${table.observationKind} IN ('price', 'valuation')`,
    ),
    dayValid: check(
      "instrument_observations_day_valid",
      sql`${table.observedDay} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(${table.observedDay}, '+0 days') = ${table.observedDay}`,
    ),
    amountValid: check(
      "instrument_observations_amount_valid",
      sql`typeof(${table.amountMinor}) = 'integer'`,
    ),
    currencyValid: check(
      "instrument_observations_currency_valid",
      sql`${table.currency} GLOB '[A-Z][A-Z][A-Z]'`,
    ),
  }),
);

export type Instrument = typeof instruments.$inferSelect;
export type NewInstrument = typeof instruments.$inferInsert;
export type InstrumentObservation = typeof instrumentObservations.$inferSelect;
export type NewInstrumentObservation = typeof instrumentObservations.$inferInsert;

export function currencyInstrumentId(currency: string): string {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(`Invalid ledger currency: ${JSON.stringify(currency)}`);
  }
  return `currency:${code}`;
}
