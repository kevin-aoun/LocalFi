import { addCanonicalDecimals, canonicalDecimal, divideRoundHalfUp, negateCanonicalDecimal } from "@/lib/ledger/decimal";
import type { CurrentLedgerMovement } from "@/lib/ledger/reads";
import { assertCents, sumCents, type Cents } from "@/lib/money";

/** One holding is an instrument position in one currency. */
export function holdingKey(instrumentId: string | null, currency: string): string {
  return `${instrumentId}\u0000${currency}`;
}

export type HoldingReturns = {
  quantity: string;
  /**
   * Average acquisition cost, buy fees included, of the units still held.
   * Null once an opening position without a cash purchase is involved.
   */
  costBasisCents: Cents | null;
  /** Net sale proceeds minus the average cost of the units sold. Null when cost is unknown. */
  realizedGainCents: Cents | null;
};

function decimalParts(value: string) {
  const [whole, fraction = ""] = canonicalDecimal(value).split(".");
  return { units: BigInt(whole + fraction), scale: BigInt(10) ** BigInt(fraction.length) };
}

// cost × sold / held, rounded half up to a cent.
function allocatedCost(cost: Cents, sold: string, held: string): Cents {
  const a = decimalParts(sold);
  const b = decimalParts(held);
  const numerator = BigInt(cost) * a.units * b.scale;
  const denominator = b.units * a.scale;
  if (denominator <= BigInt(0)) throw new Error("A sale needs an existing holding");
  const rounded = Number(divideRoundHalfUp(numerator, denominator));
  assertCents(rounded);
  return rounded;
}

/**
 * Replays instrument movements with the weighted average cost method. Buys on a
 * calendar day pool before that day's sales. Instrument amounts carry the cash
 * sign: buys add what was paid, sales subtract net proceeds.
 */
export function readHoldingReturns(current: readonly CurrentLedgerMovement[]): Map<string, HoldingReturns> {
  const cashChains = new Set(current.filter((row) => row.targetType === "real_account").map((row) => row.chainRootEventId));
  const states = new Map<string, HoldingReturns>();
  const movements = current.filter((row) => row.targetType === "instrument" && row.quantityDelta !== null)
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey) || Number(a.quantityDelta!.startsWith("-")) - Number(b.quantityDelta!.startsWith("-")) || a.sequence - b.sequence);
  for (const row of movements) {
    const key = holdingKey(row.instrumentId, row.currency);
    const state = states.get(key) ?? { quantity: "0", costBasisCents: 0, realizedGainCents: 0 };
    const delta = row.quantityDelta!;
    const sale = delta.startsWith("-");
    // A zero amount has no cash leg left in the current movements: a gift in, or units given away.
    if (!cashChains.has(row.chainRootEventId) && row.amountMinor !== 0) {
      state.costBasisCents = null;
      state.realizedGainCents = null;
    } else if (state.costBasisCents !== null && state.realizedGainCents !== null) {
      if (sale) {
        const cost = allocatedCost(state.costBasisCents, negateCanonicalDecimal(delta), state.quantity);
        state.costBasisCents = sumCents([state.costBasisCents, -cost]);
        state.realizedGainCents = sumCents([state.realizedGainCents, -row.amountMinor, -cost]);
      } else {
        state.costBasisCents = sumCents([state.costBasisCents, row.amountMinor]);
      }
    }
    state.quantity = addCanonicalDecimals(state.quantity, delta);
    states.set(key, state);
  }
  return states;
}
