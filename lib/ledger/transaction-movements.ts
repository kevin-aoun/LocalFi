import type { Database } from "sql.js";

import { addCanonicalDecimals, canonicalDecimal } from "./decimal";
import { buildTransactionMovements } from "./movements";
import { ledgerAccountId, registerLedgerAccount } from "./targets";
import type { LedgerMovementInput } from "./types";

export type CurrentTransactionAllocation = {
  categoryId: number;
  amountCents: number;
};

export type CurrentTransactionFacts = {
  accountId: number | null;
  transferAccountId: number | null;
  categoryId: number | null;
  amountCents: number;
  direction: "inflow" | "outflow" | "transfer";
  currency: string;
  instrumentId: string | null;
  quantityDelta: string | null;
  transferPrincipalAmountCents: number | null;
};

type Target = {
  targetType: "real_account" | "category" | "instrument" | "system";
  targetRef: string | number;
  currency: string;
  instrumentId?: string | null;
};

function targetId(raw: Database | null, target: Target): string {
  return raw === null
    ? ledgerAccountId(target.targetType, target.targetRef, target.currency)
    : registerLedgerAccount(raw, target);
}

function accountTarget(raw: Database | null, id: number | null, currency: string): string {
  return id === null
    ? targetId(raw, { targetType: "system", targetRef: "legacy-unassigned-account", currency })
    : targetId(raw, { targetType: "real_account", targetRef: id, currency });
}

function categoryTarget(raw: Database | null, id: number | null, currency: string): string {
  return id === null
    ? targetId(raw, { targetType: "system", targetRef: "legacy-uncategorized", currency })
    : targetId(raw, { targetType: "category", targetRef: id, currency });
}

/**
 * Canonical full movement state for one confirmed transaction projection.
 * Passing a database registers its targets for posting; passing null is a
 * read-only derivation used by verification.
 */
export function buildProjectedTransactionMovements(
  raw: Database | null,
  row: CurrentTransactionFacts,
  allocations: readonly CurrentTransactionAllocation[] = [],
): LedgerMovementInput[] {
  const currency = row.currency.trim().toUpperCase();
  const sourceTargetId = accountTarget(raw, row.accountId, currency);
  if (row.direction === "transfer") {
    if (row.transferAccountId === null) throw new Error("A transfer requires a destination account");
    const destinationTargetId = accountTarget(raw, row.transferAccountId, currency);
    const principal = row.transferPrincipalAmountCents ?? row.amountCents;
    const allocationTotal = allocations.reduce((total, allocation) => {
      const next = total + allocation.amountCents;
      if (!Number.isSafeInteger(next)) throw new Error("Transfer allocation total is invalid");
      return next;
    }, 0);
    if (principal < 0 || principal > row.amountCents || principal + allocationTotal !== row.amountCents) {
      throw new Error("Transfer principal and allocations must equal the total source amount");
    }
    return [
      { ledgerAccountId: sourceTargetId, amountMinor: -row.amountCents, currency },
      { ledgerAccountId: destinationTargetId, amountMinor: principal, currency },
      ...allocations.map((allocation) => ({
        ledgerAccountId: categoryTarget(raw, allocation.categoryId, currency),
        amountMinor: allocation.amountCents,
        currency,
      })),
    ];
  }

  let instrumentTargetId: string | null = null;
  let instrumentBookCounterTargetId: string | null = null;
  if (row.instrumentId !== null || row.quantityDelta !== null) {
    if (row.instrumentId === null || row.quantityDelta === null) {
      throw new Error("Investment instrument and exact quantity must be stored together");
    }
    instrumentTargetId = targetId(raw, {
      targetType: "instrument",
      targetRef: row.instrumentId,
      currency,
      instrumentId: row.instrumentId,
    });
    instrumentBookCounterTargetId = targetId(raw, {
      targetType: "system",
      targetRef: `instrument-book:${row.instrumentId}`,
      currency,
    });
  }
  return buildTransactionMovements({
    direction: row.direction,
    amountMinor: row.amountCents,
    currency,
    accountTargetId: sourceTargetId,
    categoryTargetId: categoryTarget(raw, row.categoryId, currency),
    instrumentTargetId,
    instrumentBookCounterTargetId,
    quantityDelta: row.quantityDelta,
  });
}

/** Collapse duplicate target legs and omit a chain whose current state is zero. */
export function normalizeCurrentTransactionMovements(
  movements: readonly LedgerMovementInput[],
): LedgerMovementInput[] {
  const totals = new Map<string, LedgerMovementInput>();
  for (const movement of movements) {
    const key = `${movement.ledgerAccountId}\u0000${movement.currency}`;
    const prior = totals.get(key);
    const amountMinor = (prior?.amountMinor ?? 0) + movement.amountMinor;
    if (!Number.isSafeInteger(amountMinor)) throw new Error("Transaction movement total overflow");
    const quantityDelta = addCanonicalDecimals(
      prior?.quantityDelta ?? "0",
      movement.quantityDelta == null ? "0" : canonicalDecimal(movement.quantityDelta),
    );
    totals.set(key, {
      ledgerAccountId: movement.ledgerAccountId,
      amountMinor,
      currency: movement.currency,
      quantityDelta: quantityDelta === "0" ? null : quantityDelta,
    });
  }
  return [...totals.values()]
    .filter((movement) => movement.amountMinor !== 0 || movement.quantityDelta !== null)
    .sort((left, right) => left.currency.localeCompare(right.currency) ||
      left.ledgerAccountId.localeCompare(right.ledgerAccountId));
}
