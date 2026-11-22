import type { PositionValuation } from "@/lib/ledger/reads";
import { negateCents, sumCents, type Cents } from "@/lib/money";

import { holdingKey } from "./returns";

type HoldingRow = {
  category: string;
  instrumentId: string | null;
  currency: string;
  currentValueCents: Cents;
  quantity: number | null;
};

/** Holdings rows as listed: ledger positions supply value, exact quantity, and cost basis. */
export function currentHoldings<T extends HoldingRow>(
  rows: readonly T[],
  valuations: readonly PositionValuation[],
) {
  const positions = new Map(valuations
    .map((position) => [holdingKey(position.instrumentId, position.currency), position]));
  return rows.flatMap((asset) => {
    const position = positions.get(holdingKey(asset.instrumentId, asset.currency));
    // Sold-out holdings leave the holdings list; Reports keep their history and realized gain.
    if (asset.category !== "Cash" && asset.instrumentId && (!position || position.quantity === "0")) return [];
    const currentValueCents = position ? position.valueMinor as Cents : asset.currentValueCents;
    const costBasisCents = position?.costBasisCents;
    const quantity = position ? Number(position.quantity) : asset.quantity;
    if (quantity !== null && !Number.isFinite(quantity)) throw new Error("Position quantity cannot be represented by assets");
    return [{
      ...asset,
      quantity,
      currentValueCents,
      quantityExact: position?.quantity ?? null,
      costBasisCents: costBasisCents ?? null,
      profitLossCents: costBasisCents == null
        ? null
        : sumCents([currentValueCents, negateCents(costBasisCents)]),
    }];
  });
}
