import { addCanonicalDecimals, canonicalDecimal, negateCanonicalDecimal } from "@/lib/ledger/decimal";
import type { CurrentLedgerMovement } from "@/lib/ledger/reads";
import { assertCents, sumCents, type Cents } from "@/lib/money";

function decimalParts(value: string) {
  const [whole, fraction = ""] = canonicalDecimal(value).split(".");
  return { units: BigInt(whole + fraction), scale: BigInt(10) ** BigInt(fraction.length) };
}

function allocatedCost(cost: Cents, sold: string, held: string): Cents {
  const a = decimalParts(sold);
  const b = decimalParts(held);
  const numerator = BigInt(cost) * a.units * b.scale;
  const denominator = b.units * a.scale;
  if (denominator <= BigInt(0)) throw new Error("A sale needs an existing holding");
  const rounded = Number(numerator / denominator + ((numerator % denominator) * BigInt(2) >= denominator ? BigInt(1) : BigInt(0)));
  assertCents(rounded);
  return rounded;
}

// Weighted average acquisition cost, including buy fees; proceeds already exclude sell fees.
export function readInvestmentReturns(current: readonly CurrentLedgerMovement[]) {
  const cashChains = new Set(current.filter((row) => row.targetType === "real_account").map((row) => row.chainRootEventId));
  const states = new Map<string, { quantity: string; remainingCostCents: Cents | null; realizedGainCents: Cents | null }>();
  const movements = current.filter((row) => row.targetType === "instrument" && row.quantityDelta !== null)
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey) || Number(a.quantityDelta!.startsWith("-")) - Number(b.quantityDelta!.startsWith("-")) || a.sequence - b.sequence);
  for (const row of movements) {
    const key = `${row.instrumentId}\u0000${row.currency}`;
    const state = states.get(key) ?? { quantity: "0", remainingCostCents: 0, realizedGainCents: 0 };
    const delta = row.quantityDelta!;
    if (!cashChains.has(row.chainRootEventId) && !(row.amountMinor === 0 && delta.startsWith("-"))) {
      state.remainingCostCents = null;
      state.realizedGainCents = null;
    } else if (state.remainingCostCents !== null && state.realizedGainCents !== null) {
      if (delta.startsWith("-")) {
        const cost = allocatedCost(state.remainingCostCents, negateCanonicalDecimal(delta), state.quantity);
        state.remainingCostCents = sumCents([state.remainingCostCents, -cost]);
        state.realizedGainCents = sumCents([state.realizedGainCents, -row.amountMinor, -cost]);
      } else {
        state.remainingCostCents = sumCents([state.remainingCostCents, row.amountMinor]);
      }
    }
    state.quantity = addCanonicalDecimals(state.quantity, delta);
    states.set(key, state);
  }
  return states;
}
