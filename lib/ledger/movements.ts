import { assertCents } from "@/lib/money";

import { addCanonicalDecimals, canonicalDecimal, negateCanonicalDecimal } from "./decimal";
import type { LedgerMovementInput, PositionedMovement } from "./types";

export type TransactionMovementFacts = {
  pending?: boolean;
  direction: "inflow" | "outflow" | "transfer";
  amountMinor: number;
  currency: string;
  accountTargetId: string;
  categoryTargetId?: string | null;
  transferTargetId?: string | null;
  instrumentTargetId?: string | null;
  instrumentBookCounterTargetId?: string | null;
  quantityDelta?: string | null;
};

function currencyCode(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter ISO code");
  return currency;
}

export function buildTransactionMovements(facts: TransactionMovementFacts): LedgerMovementInput[] {
  if (facts.pending) throw new Error("pending drafts cannot produce ledger movements");
  assertCents(facts.amountMinor);
  if (facts.amountMinor < 0) throw new Error("amount must be a non-negative magnitude");
  const currency = currencyCode(facts.currency);

  if (facts.direction === "transfer") {
    if (!facts.transferTargetId || facts.transferTargetId === facts.accountTargetId) {
      throw new Error("a transfer requires two different registered account targets");
    }
    if (facts.categoryTargetId) throw new Error("a pure transfer has no category movement");
    return [
      { ledgerAccountId: facts.accountTargetId, amountMinor: -facts.amountMinor, currency },
      { ledgerAccountId: facts.transferTargetId, amountMinor: facts.amountMinor, currency },
    ];
  }

  if (!facts.categoryTargetId) {
    throw new Error("ordinary income and expense require a registered category target");
  }
  const accountAmount = facts.direction === "inflow" ? facts.amountMinor : -facts.amountMinor;
  const movements: LedgerMovementInput[] = [
    { ledgerAccountId: facts.accountTargetId, amountMinor: accountAmount, currency },
    { ledgerAccountId: facts.categoryTargetId, amountMinor: -accountAmount, currency },
  ];
  if (facts.instrumentTargetId || facts.quantityDelta != null) {
    if (!facts.instrumentTargetId || facts.quantityDelta == null) {
      throw new Error("instrument target and exact quantity must be supplied together");
    }
    if (facts.direction !== "outflow") {
      throw new Error("this release supports confirmed instrument purchases only");
    }
    if (!facts.instrumentBookCounterTargetId) {
      throw new Error("instrument purchases require a registered book counter-target");
    }
    const quantityDelta = canonicalDecimal(facts.quantityDelta);
    if (quantityDelta === "0") throw new Error("instrument quantity delta cannot be zero");
    movements.push({
      ledgerAccountId: facts.instrumentTargetId,
      amountMinor: facts.amountMinor,
      currency,
      quantityDelta,
    });
    movements.push({
      ledgerAccountId: facts.instrumentBookCounterTargetId,
      amountMinor: -facts.amountMinor,
      currency,
    });
  }
  return movements;
}

function key(movement: LedgerMovementInput): string {
  return `${movement.currency}\u0000${movement.ledgerAccountId}`;
}


export function buildMovementDelta(
  before: LedgerMovementInput[],
  after: LedgerMovementInput[],
): PositionedMovement[] {
  const totals = new Map<string, LedgerMovementInput>();
  const add = (movement: LedgerMovementInput, sign: 1 | -1) => {
    assertCents(movement.amountMinor);
    const movementCurrency = currencyCode(movement.currency);
    const movementKey = key({ ...movement, currency: movementCurrency });
    const previous = totals.get(movementKey);
    const signedQuantity = movement.quantityDelta == null
      ? null
      : sign === 1
        ? canonicalDecimal(movement.quantityDelta)
        : negateCanonicalDecimal(movement.quantityDelta);
    totals.set(movementKey, {
      ledgerAccountId: movement.ledgerAccountId,
      currency: movementCurrency,
      amountMinor: (previous?.amountMinor ?? 0) + sign * movement.amountMinor,
      quantityDelta: signedQuantity == null
        ? previous?.quantityDelta ?? null
        : addCanonicalDecimals(previous?.quantityDelta ?? "0", signedQuantity),
    });
  };
  before.forEach((movement) => add(movement, -1));
  after.forEach((movement) => add(movement, 1));

  const deltas = [...totals.values()].filter(
    (movement) => movement.amountMinor !== 0 || (movement.quantityDelta ?? "0") !== "0",
  );
  if (deltas.length === 0) {
    const negateBefore = before.map((movement) => ({
      ledgerAccountId: movement.ledgerAccountId,
      amountMinor: -movement.amountMinor,
      currency: currencyCode(movement.currency),
      quantityDelta: movement.quantityDelta == null
        ? null
        : negateCanonicalDecimal(movement.quantityDelta),
    }));
    const reapplyAfter = after.map((movement) => ({
      ledgerAccountId: movement.ledgerAccountId,
      amountMinor: movement.amountMinor,
      currency: currencyCode(movement.currency),
      quantityDelta: movement.quantityDelta == null
        ? null
        : canonicalDecimal(movement.quantityDelta),
    }));
    const replacement = [...negateBefore, ...reapplyAfter];
    if (replacement.length < 2) {
      throw new Error("a correction delta must contain at least two movements");
    }
    return replacement.map((movement, position) => ({ ...movement, position }));
  }
  if (deltas.length === 1) {
    const [quantityOnly] = deltas;
    if (quantityOnly.amountMinor !== 0 || quantityOnly.quantityDelta == null) {
      throw new Error("a correction delta must contain at least two movements");
    }
    const companion = [...after, ...before].find((movement) =>
      currencyCode(movement.currency) === quantityOnly.currency &&
      key({ ...movement, currency: quantityOnly.currency }) !== key(quantityOnly)
    );
    if (!companion) throw new Error("a quantity-only correction needs a balancing companion");
    deltas.push({
      ledgerAccountId: companion.ledgerAccountId,
      amountMinor: 0,
      currency: quantityOnly.currency,
      quantityDelta: null,
    });
  }
  if (deltas.length < 2) {
    throw new Error("a correction delta must contain at least two movements");
  }
  return deltas
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.ledgerAccountId.localeCompare(b.ledgerAccountId))
    .map((movement, position) => ({
      ...movement,
      quantityDelta: movement.quantityDelta === "0" ? null : movement.quantityDelta,
      position,
    }));
}

export function buildDeletionDelta(current: LedgerMovementInput[]): PositionedMovement[] {
  return buildMovementDelta(current, []);
}
