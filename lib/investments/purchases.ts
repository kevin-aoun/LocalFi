import type { Database } from "sql.js";

import { canonicalDecimal } from "@/lib/ledger/decimal";
import { registerLedgerAccount } from "@/lib/ledger/targets";

import { ensurePricedInstrument, type InvestmentInstrument } from "./instruments";
import { observationDay, recordInstrumentObservation } from "./observations";
import {
  syncPositionHoldingProjection,
  type PositionHoldingProjection,
} from "./positions";

export type PreparedInvestmentPurchase = {
  instrument: InvestmentInstrument;
  instrumentId: string;
  instrumentTargetId: string;
  instrumentBookCounterTargetId: string;
  quantityDelta: string;
  frozenUnitPriceMinor: number;
  currency: string;
};

export type PrepareInvestmentPurchaseInput = {
  symbol: string;
  currency: string;
  quantity: string;
  unit?: string;
  unitPriceMinor: number;
  unitPrice?: string;
  observedAt?: number;
  observedDay?: string;
  source?: string | null;
};

export function prepareInvestmentPurchase(
  raw: Database,
  input: PrepareInvestmentPurchaseInput,
): PreparedInvestmentPurchase {
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Purchase currency must be an ISO code");
  if (!Number.isSafeInteger(input.unitPriceMinor) || (input.unitPrice ? input.unitPriceMinor < 0 : input.unitPriceMinor <= 0)) {
    throw new Error("A confirmed investment purchase requires a positive frozen unit price");
  }
  const quantityDelta = canonicalDecimal(input.quantity);
  if (quantityDelta === "0" || quantityDelta.startsWith("-")) {
    throw new Error("A confirmed purchase quantity must be positive");
  }

  const instrument = ensurePricedInstrument(raw, input.symbol);
  if (input.unit && input.unit.trim().toLowerCase() !== instrument.unit) {
    throw new Error(`Unsupported ${instrument.label} quantity unit: ${input.unit}`);
  }
  if (instrument.priceCurrency && instrument.priceCurrency !== currency) {
    throw new Error(
      `${instrument.label} quotes are ${instrument.priceCurrency}; ${currency} needs an FX model`,
    );
  }
  const observedAt = input.observedAt ?? Math.floor(Date.now() / 1000);
  recordInstrumentObservation(raw, {
    instrumentId: instrument.id,
    observationKind: "price",
    observedDay: input.observedDay ?? observationDay(observedAt),
    observedAt,
    amountMinor: input.unitPriceMinor,
    unitPrice: input.unitPrice,
    currency,
    source: input.source ?? instrument.priceSource,
  });

  const instrumentTargetId = registerLedgerAccount(raw, {
    targetType: "instrument",
    targetRef: instrument.id,
    currency,
    instrumentId: instrument.id,
  });
  const instrumentBookCounterTargetId = registerLedgerAccount(raw, {
    targetType: "system",
    targetRef: `instrument-book:${instrument.id}`,
    currency,
  });
  return {
    instrument,
    instrumentId: instrument.id,
    instrumentTargetId,
    instrumentBookCounterTargetId,
    quantityDelta,
    frozenUnitPriceMinor: input.unitPriceMinor,
    currency,
  };
}


export function projectInvestmentPurchase(
  raw: Database,
  purchase: Pick<PreparedInvestmentPurchase, "instrumentId" | "currency">,
): PositionHoldingProjection | null {
  return syncPositionHoldingProjection(raw, purchase.instrumentId, purchase.currency);
}
