export type TransactionProjectionAllocation = {
  categoryId: number;
  amountCents: number;
};

export type TransactionProjectionSource = {
  id: number;
  date: Date | number;
  categoryId: number | null;
  accountId: number | null;
  transferAccountId: number | null;
  amountCents: number;
  direction: "inflow" | "outflow" | "transfer";
  currency: string;
  comment: string | null;
  recurringId: number | null;
  recurringOccurrence: string | null;
  instrumentId: string | null;
  quantityDelta: string | null;
  transferPrincipalAmountCents: number | null;
  createdAt: Date | number;
  updatedAt: Date | number;
};

export function projectionEpochSeconds(value: Date | number): number {
  const seconds = value instanceof Date ? Math.floor(value.getTime() / 1000) : value;
  if (!Number.isSafeInteger(seconds)) throw new Error("Transaction timestamp is invalid");
  return seconds;
}

/** Canonical current transaction snapshot shared by every confirmed producer. */
export function buildTransactionProjection(
  row: TransactionProjectionSource,
  allocations: readonly TransactionProjectionAllocation[] = [],
  overrides: { recurringId?: number | null } = {},
) {
  return {
    id: row.id,
    date: projectionEpochSeconds(row.date),
    categoryId: row.categoryId,
    accountId: row.accountId,
    transferAccountId: row.transferAccountId,
    amountCents: row.amountCents,
    direction: row.direction,
    currency: row.currency,
    comment: row.comment,
    pending: false,
    recurringId: overrides.recurringId === undefined ? row.recurringId : overrides.recurringId,
    recurringOccurrence: row.recurringOccurrence,
    instrumentId: row.instrumentId,
    quantityDelta: row.quantityDelta,
    transferPrincipalAmountCents: row.transferPrincipalAmountCents,
    allocations: allocations.map(({ categoryId, amountCents }) => ({ categoryId, amountCents })),
    createdAt: projectionEpochSeconds(row.createdAt),
    updatedAt: projectionEpochSeconds(row.updatedAt),
  };
}
