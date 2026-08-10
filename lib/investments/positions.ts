import type { Database } from "sql.js";

import { canonicalDecimal } from "@/lib/ledger/decimal";
import { pricedHolding } from "@/lib/prices";

import { findInstrument } from "./instruments";
import { latestPositionObservation } from "./observations";
import { allRows, firstRow, type SqlRow } from "./sql";

export type ExactInstrumentPosition = {
  instrumentId: string;
  currency: string;
  quantity: string;
  bookAmountMinor: number;
  currentEventId: string;
};

export type PositionHoldingProjection = ExactInstrumentPosition & {
  assetId: number;
  valueMinor: number;
  observationKind: "price" | "valuation" | null;
};

export type PositionHoldingValues = {
  category: string;
  valueMinor: number;
  quantity: number;
  unit: "oz" | "grams" | "coins" | null;
  commodityType: string | null;
  priceSymbol: string | null;
  pricedAt: number | null;
  useLivePrice: boolean;
  observationKind: "price" | "valuation" | null;
};

function positionFromRow(row: SqlRow): ExactInstrumentPosition {
  const bookAmountMinor = Number(row.book_amount_minor);
  if (!Number.isSafeInteger(bookAmountMinor)) throw new Error("Instrument book amount is invalid");
  return {
    instrumentId: String(row.instrument_id),
    currency: String(row.currency),
    quantity: canonicalDecimal(String(row.quantity)),
    bookAmountMinor,
    currentEventId: String(row.current_event_id),
  };
}

export function getExactPosition(
  raw: Database,
  instrumentId: string,
  currency: string,
): ExactInstrumentPosition | null {
  const row = firstRow(
    raw,
    `SELECT instrument_id, currency, quantity, book_amount_minor, current_event_id
       FROM instrument_positions WHERE instrument_id = ? AND currency = ?`,
    [instrumentId, currency.trim().toUpperCase()],
  );
  return row ? positionFromRow(row) : null;
}

export function getExactPositions(raw: Database): ExactInstrumentPosition[] {
  return allRows(
    raw,
    `SELECT instrument_id, currency, quantity, book_amount_minor, current_event_id
       FROM instrument_positions ORDER BY instrument_id, currency`,
  ).map(positionFromRow);
}

/** Multiply canonical decimal quantity by integer minor-unit price with one half-up rounding. */
export function quantityValueMinor(quantity: string, unitPriceMinor: number): number {
  if (!Number.isSafeInteger(unitPriceMinor)) throw new Error("Unit price must be integer minor units");
  const canonical = canonicalDecimal(quantity);
  const negative = canonical.startsWith("-");
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [whole, fraction = ""] = unsigned.split(".");
  const scale = BigInt(10) ** BigInt(fraction.length);
  const quantityMinor = BigInt(`${whole}${fraction}`);
  const product = quantityMinor * BigInt(Math.abs(unitPriceMinor));
  let rounded = product / scale;
  if ((product % scale) * BigInt(2) >= scale) rounded += BigInt(1);
  const signed = (negative !== (unitPriceMinor < 0)) ? -rounded : rounded;
  const value = Number(signed);
  if (!Number.isSafeInteger(value)) throw new Error("Position value exceeds safe integer range");
  return value;
}

function assetCategory(category: string | null, kind: string): string {
  if (category) return category;
  if (kind === "commodity") return "Commodities";
  if (kind === "security") return "Investments";
  return "Other";
}

export function positionHoldingValues(
  raw: Database,
  position: ExactInstrumentPosition,
): PositionHoldingValues {
  const instrument = findInstrument(raw, position.instrumentId);
  if (!instrument) throw new Error(`No instrument ${position.instrumentId}`);
  const observation = latestPositionObservation(raw, position.instrumentId, position.currency);
  const valueMinor = observation === null
    ? 0
    : observation.observationKind === "valuation"
      ? observation.amountMinor
      : quantityValueMinor(position.quantity, observation.amountMinor);
  const quantity = Number(position.quantity);
  if (!Number.isFinite(quantity)) throw new Error("Position quantity cannot be represented by assets");
  const spec = instrument.symbol ? pricedHolding(instrument.symbol) : null;
  const unit = instrument.unit === "oz" || instrument.unit === "grams" || instrument.unit === "coins"
    ? instrument.unit
    : null;
  return {
    category: assetCategory(instrument.category, instrument.kind),
    valueMinor,
    quantity,
    unit,
    commodityType: spec?.commodityType ?? null,
    priceSymbol: spec?.symbol ?? null,
    pricedAt: observation?.observationKind === "price" ? observation.observedAt : null,
    useLivePrice: Boolean(instrument.priceSource),
    observationKind: observation?.observationKind ?? null,
  };
}

/** Mirror one exact ledger position into the current compatibility asset projection. */
export function projectPositionHolding(
  raw: Database,
  instrumentId: string,
  currency: string,
): PositionHoldingProjection {
  const normalizedCurrency = currency.trim().toUpperCase();
  const position = getExactPosition(raw, instrumentId, normalizedCurrency);
  if (!position) throw new Error(`No ${normalizedCurrency} position for instrument ${instrumentId}`);
  const instrument = findInstrument(raw, instrumentId);
  if (!instrument) throw new Error(`No instrument ${instrumentId}`);
  const values = positionHoldingValues(raw, position);
  const now = Math.floor(Date.now() / 1000);
  const existing = firstRow(
    raw,
    `SELECT id FROM assets
      WHERE instrument_id = ? AND currency = ?
      ORDER BY id LIMIT 1`,
    [instrumentId, normalizedCurrency],
  );

  let assetId: number;
  if (existing) {
    assetId = Number(existing.id);
    raw.run(
      `UPDATE assets SET
         category = ?, current_value_cents = ?, quantity = ?, unit = ?,
         commodity_type = ?, price_symbol = ?, priced_at = ?, use_live_price = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        values.category,
        values.valueMinor,
        values.quantity,
        values.unit,
        values.commodityType,
        values.priceSymbol,
        values.pricedAt,
        values.useLivePrice ? 1 : 0,
        now,
        assetId,
      ],
    );
  } else {
    raw.run(
      `INSERT INTO assets
        (category, current_value_cents, currency, instrument_id, notes,
         commodity_type, quantity, unit, price_symbol, priced_at, use_live_price,
         archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        values.category,
        values.valueMinor,
        normalizedCurrency,
        instrumentId,
        instrument.label,
        values.commodityType,
        values.quantity,
        values.unit,
        values.priceSymbol,
        values.pricedAt,
        values.useLivePrice ? 1 : 0,
        now,
        now,
      ],
    );
    const inserted = firstRow(raw, "SELECT last_insert_rowid() AS id");
    assetId = Number(inserted?.id);
  }
  if (!Number.isInteger(assetId) || assetId <= 0) throw new Error("Asset projection failed");

  return {
    ...position,
    assetId,
    valueMinor: values.valueMinor,
    observationKind: values.observationKind,
  };
}

/** Keep the compatibility asset projection absent when its exact position is fully zero. */
export function syncPositionHoldingProjection(
  raw: Database,
  instrumentId: string,
  currency: string,
): PositionHoldingProjection | null {
  const normalizedCurrency = currency.trim().toUpperCase();
  const position = getExactPosition(raw, instrumentId, normalizedCurrency);
  if (!position || (position.quantity === "0" && position.bookAmountMinor === 0)) {
    raw.run(
      `DELETE FROM assets
        WHERE category <> 'Cash' AND instrument_id = ? AND currency = ?`,
      [instrumentId, normalizedCurrency],
    );
    return null;
  }
  return projectPositionHolding(raw, instrumentId, normalizedCurrency);
}

export function projectAllPositionHoldings(raw: Database): PositionHoldingProjection[] {
  return getExactPositions(raw).flatMap((position) => {
    const projected = syncPositionHoldingProjection(raw, position.instrumentId, position.currency);
    return projected ? [projected] : [];
  });
}
