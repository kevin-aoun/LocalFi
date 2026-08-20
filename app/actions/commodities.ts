"use server";

import { fetchHoldingValueCents, priceSymbolForCommodityType } from "@/lib/prices";
import { type Cents } from "@/lib/money";

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
