import type { Database } from "sql.js";

import type { InstrumentObservationKind } from "@/lib/db/schema/instruments";
import { canonicalDecimal } from "@/lib/ledger/decimal";
import { parseAmount } from "@/lib/money";

import { firstRow, type SqlRow } from "./sql";

export type InvestmentObservation = {
  instrumentId: string;
  observationKind: InstrumentObservationKind;
  observedDay: string;
  observedAt: number;
  amountMinor: number;
  unitPrice?: string | null;
  currency: string;
  source: string | null;
};

export type ObservationInput = InvestmentObservation;

function validDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

export function observationDay(observedAt: number | Date): string {
  const date = observedAt instanceof Date ? observedAt : new Date(observedAt * 1000);
  if (Number.isNaN(date.getTime())) throw new Error("Observation time is invalid");
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function observationFromRow(row: SqlRow): InvestmentObservation {
  return {
    instrumentId: String(row.instrument_id),
    observationKind: String(row.observation_kind) as InstrumentObservationKind,
    observedDay: String(row.observed_day),
    observedAt: Number(row.observed_at),
    amountMinor: Number(row.amount_minor),
    unitPrice: row.unit_price == null ? null : String(row.unit_price),
    currency: String(row.currency),
    source: row.source == null ? null : String(row.source),
  };
}


export function recordInstrumentObservation(
  raw: Database,
  input: ObservationInput,
): InvestmentObservation {
  if (!input.instrumentId.trim()) throw new Error("Observation instrument is required");
  if (input.observationKind !== "price" && input.observationKind !== "valuation") {
    throw new Error("Observation kind must be price or valuation");
  }
  if (!validDay(input.observedDay)) throw new Error("Observation day must be a real YYYY-MM-DD day");
  if (!Number.isSafeInteger(input.observedAt)) {
    throw new Error("Observation time must be integer epoch seconds");
  }
  if (!Number.isSafeInteger(input.amountMinor)) {
    throw new Error("Observation amount must be integer minor units");
  }
  const unitPrice = input.unitPrice == null ? null : canonicalDecimal(input.unitPrice);
  if (unitPrice !== null && (input.observationKind !== "price" || unitPrice === "0" || unitPrice.startsWith("-"))) {
    throw new Error("An exact unit price requires a positive price observation");
  }
  if (unitPrice !== null && parseAmount(unitPrice) !== input.amountMinor) {
    throw new Error("The rounded price must match the exact unit price");
  }
  if (input.observationKind === "price" && (unitPrice === null ? input.amountMinor <= 0 : input.amountMinor < 0)) {
    throw new Error("A unit-price observation must be positive");
  }
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Observation currency must be an ISO code");
  // Legacy ledger backfills run before the exact-price column is migrated.
  const hasExactPrice = raw.exec("PRAGMA table_info(instrument_observations)")[0]?.values
    .some((column) => column[1] === "unit_price") ?? false;

  raw.run(
    `INSERT INTO instrument_observations
      (instrument_id, observation_kind, observed_day, observed_at, amount_minor, currency, source${hasExactPrice ? ", unit_price" : ""})
     VALUES (?, ?, ?, ?, ?, ?, ?${hasExactPrice ? ", ?" : ""})
     ON CONFLICT(instrument_id, observation_kind, observed_day) DO UPDATE SET
       observed_at = excluded.observed_at,
       amount_minor = excluded.amount_minor,
       currency = excluded.currency,
       source = excluded.source${hasExactPrice ? ", unit_price = excluded.unit_price" : ""}
     WHERE excluded.observed_at >= instrument_observations.observed_at`,
    [
      input.instrumentId,
      input.observationKind,
      input.observedDay,
      input.observedAt,
      input.amountMinor,
      currency,
      input.source,
      ...(hasExactPrice ? [unitPrice] : []),
    ],
  );

  const stored = firstRow(
    raw,
    `SELECT *
       FROM instrument_observations
      WHERE instrument_id = ? AND observation_kind = ? AND observed_day = ?`,
    [input.instrumentId, input.observationKind, input.observedDay],
  );
  if (!stored) throw new Error("Observation write did not produce a row");
  return observationFromRow(stored);
}

export function latestInstrumentObservation(
  raw: Database,
  instrumentId: string,
  observationKind: InstrumentObservationKind,
  currency?: string,
): InvestmentObservation | null {
  const normalizedCurrency = currency?.trim().toUpperCase();
  const row = firstRow(
    raw,
    `SELECT *
       FROM instrument_observations
      WHERE instrument_id = ? AND observation_kind = ?
        ${normalizedCurrency ? "AND currency = ?" : ""}
      ORDER BY observed_day DESC, observed_at DESC
      LIMIT 1`,
    normalizedCurrency
      ? [instrumentId, observationKind, normalizedCurrency]
      : [instrumentId, observationKind],
  );
  return row ? observationFromRow(row) : null;
}


export function latestPositionObservation(
  raw: Database,
  instrumentId: string,
  currency: string,
): InvestmentObservation | null {
  const row = firstRow(
    raw,
    `SELECT *
       FROM instrument_observations
      WHERE instrument_id = ? AND currency = ?
      ORDER BY observed_day DESC, observed_at DESC,
               CASE observation_kind WHEN 'valuation' THEN 0 ELSE 1 END
      LIMIT 1`,
    [instrumentId, currency.trim().toUpperCase()],
  );
  return row ? observationFromRow(row) : null;
}
