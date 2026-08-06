"use server";

/** Compatibility wrapper for manual asset actions that still submit a metal name. */

import { fetchHoldingValueCents, priceSymbolForCommodityType } from "@/lib/prices";
import { type Cents } from "@/lib/money";

/** Value a metal in cents; null means unavailable and must never be saved as zero. */
export async function calculateCommodityValue(
  commodityType: string,
  quantity: number,
  unit: string,
): Promise<Cents | null> {
  const symbol = priceSymbolForCommodityType(commodityType);
  if (symbol === null) {
    console.error(`[prices] unknown commodity type: ${String(commodityType)}`);
    return null;
  }

  const result = await fetchHoldingValueCents(symbol, quantity, unit);
  if (!result.ok) {
    console.error(`[prices] ${commodityType}: ${result.error.code}, ${result.error.message}`);
    return null;
  }
  return result.valueCents;
}
