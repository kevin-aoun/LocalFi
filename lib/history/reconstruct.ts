import { fromDateKey, isDateKey, toDateKey, type DateKey } from "@/lib/dates";
import type { Cents } from "@/lib/money";
import type { PriceSymbol } from "@/lib/prices";

/** Compatibility input retained for the history command's public option shape. */
export type HistoryAsset = {
  id: number;
  category: string;
  currentValueCents: Cents;
  currency?: string | null;
  archived?: boolean | null;
  quantity?: number | null;
  unit?: string | null;
  priceSymbol?: string | null;
  notes?: string | null;
  createdAt: Date | number;
};

/** Empty in journal-native plans; retained so the dry-run formatter stays compatible. */
export type HoldingPlan = {
  assetId: number;
  label: string;
  category: string;
  symbol: PriceSymbol | null;
  quantity: number | null;
  unit: string | null;
  storedValueCents: Cents;
  currency: string;
  acquiredOn: DateKey;
  acquisitionSource: "ledger" | "asset_created_at";
  acquisitionTxId: number | null;
  valuationReason: string;
};

export type PurchaseContinuity = {
  assetId: number;
  label: string;
  dateKey: DateKey;
  paidCents: Cents;
  valuedCents: Cents;
  residualCents: Cents;
};

export type ReconstructionWarning = { code: string; message: string };

export type HoldingDayValue = {
  assetId: number;
  label: string;
  symbol: PriceSymbol | null;
  currency: string;
  held: boolean;
  valueCents: Cents;
  priceUsd: number | null;
  priceAsOfKey: DateKey | null;
  priceCarriedForward: boolean;
  basis: "priced" | "carried-stored-value" | "not-held";
};

export type ReconstructedDay = {
  dateKey: DateKey;
  currency: string;
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
  accountsCents: Cents;
  holdingsCents: Cents;
  holdings: HoldingDayValue[];
  sourceNote: string;
};

/** Every local calendar day in an inclusive range. */
export function eachDay(fromKey: DateKey, toKey: DateKey): DateKey[] {
  if (!isDateKey(fromKey)) throw new Error(`Invalid fromKey: ${String(fromKey)}`);
  if (!isDateKey(toKey)) throw new Error(`Invalid toKey: ${String(toKey)}`);
  const days: DateKey[] = [];
  let cursor = fromDateKey(fromKey);
  const end = fromDateKey(toKey);
  while (cursor.getTime() <= end.getTime()) {
    days.push(toDateKey(cursor));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }
  return days;
}
