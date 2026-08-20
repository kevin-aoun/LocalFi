import { randomUUID } from "node:crypto";

import type { Database } from "sql.js";

import type { InstrumentKind } from "@/lib/db/schema/instruments";
import { pricedHolding, type PriceSymbol } from "@/lib/prices";

import { firstRow, type SqlRow } from "./sql";

export type InvestmentInstrument = {
  id: string;
  kind: InstrumentKind;
  label: string;
  symbol: string | null;
  unit: string;
  category: string | null;
  priceSource: string | null;
  priceCurrency: string | null;
  createdAt: number;
};

export type InstrumentDiscovery = Omit<InvestmentInstrument, "createdAt">;

function instrumentFromRow(row: SqlRow): InvestmentInstrument {
  return {
    id: String(row.id),
    kind: String(row.kind) as InstrumentKind,
    label: String(row.label),
    symbol: row.symbol == null ? null : String(row.symbol),
    unit: String(row.unit),
    category: row.category == null ? null : String(row.category),
    priceSource: row.price_source == null ? null : String(row.price_source),
    priceCurrency: row.price_currency == null ? null : String(row.price_currency),
    createdAt: Number(row.created_at),
  };
}

export function findInstrument(raw: Database, instrumentId: string): InvestmentInstrument | null {
  const row = firstRow(
    raw,
    `SELECT id, kind, label, symbol, unit, category, price_source, price_currency, created_at
       FROM instruments WHERE id = ?`,
    [instrumentId],
  );
  return row ? instrumentFromRow(row) : null;
}

export function discoverInstrument(symbol: string): InstrumentDiscovery {
  const spec = pricedHolding(symbol);
  if (!spec) throw new Error(`Unsupported investment instrument: ${JSON.stringify(symbol)}`);
  const kind: InstrumentKind = spec.assetCategory === "Commodities" ? "commodity" : "security";
  return {
    id: `instrument:${kind}:${spec.symbol}`,
    kind,
    label: spec.label,
    symbol: spec.symbol,
    unit: spec.defaultUnit,
    category: spec.assetCategory,
    priceSource: spec.provider,
    priceCurrency: spec.provider === null ? null : "USD",
  };
}


export function ensureInstrument(
  raw: Database,
  discovery: InstrumentDiscovery,
  createdAt = Math.floor(Date.now() / 1000),
): InvestmentInstrument {
  const existing = firstRow(
    raw,
    `SELECT id, kind, label, symbol, unit, category, price_source, price_currency, created_at
       FROM instruments WHERE id = ?`,
    [discovery.id],
  );
  if (existing) {
    const instrument = instrumentFromRow(existing);
    if (instrument.kind !== discovery.kind || instrument.unit !== discovery.unit) {
      throw new Error(
        `Instrument ${instrument.id} conflicts with the discovered kind or canonical unit`,
      );
    }
    return instrument;
  }

  raw.run(
    `INSERT INTO instruments
      (id, kind, label, symbol, unit, category, price_source, price_currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      discovery.id,
      discovery.kind,
      discovery.label,
      discovery.symbol,
      discovery.unit,
      discovery.category,
      discovery.priceSource,
      discovery.priceCurrency,
      createdAt,
    ],
  );
  const inserted = findInstrument(raw, discovery.id);
  if (!inserted) throw new Error("Instrument creation did not produce a row");
  return inserted;
}

export function ensurePricedInstrument(
  raw: Database,
  symbol: string,
  createdAt?: number,
): InvestmentInstrument {
  return ensureInstrument(raw, discoverInstrument(symbol), createdAt);
}


export function createManualInstrument(
  raw: Database,
  input: { label: string; category: string; currency: string; createdAt?: number },
): InvestmentInstrument {
  const label = input.label.trim() || input.category.trim() || "Manual asset";
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Manual valuation currency must be an ISO code");
  return ensureInstrument(
    raw,
    {
      id: `instrument:manual:${randomUUID()}`,
      kind: "manual",
      label,
      symbol: null,
      unit: "holding",
      category: input.category,
      priceSource: null,
      priceCurrency: currency,
    },
    input.createdAt,
  );
}

export function isSupportedPriceSymbol(value: string | null): value is PriceSymbol {
  return value !== null && pricedHolding(value) !== null;
}
