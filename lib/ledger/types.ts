import type { BudgetDb } from "@/lib/db/client";
import type { Database } from "sql.js";

export type CanonicalPrimitive = null | boolean | number | string;
export type CanonicalValue =
  | CanonicalPrimitive
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };
export type CanonicalMetadata = { [key: string]: CanonicalValue };

export type LedgerMovementInput = {
  ledgerAccountId: string;
  amountMinor: number;
  currency: string;
  quantityDelta?: string | null;
};

export type PositionedMovement = LedgerMovementInput & { position: number };

export type LedgerCanonicalPayload = {
  version: 1;
  eventId: string;
  effectiveDate: string;
  description: string;
  amendsEventId: string | null;
  metadata: CanonicalMetadata;
  movements: PositionedMovement[];
  previousHash: string | null;
  recordedAt: number;
};

export type LedgerEventInput = {
  eventId?: string;
  effectiveDate: string;
  description: string;
  amendsEventId?: string | null;
  metadata: CanonicalMetadata;
  movements: LedgerMovementInput[];
  recordedAt?: number | Date;
};

export type StoredLedgerEvent = {
  eventId: string;
  sequence: number;
  payloadVersion: 1;
  effectiveDate: string;
  description: string;
  amendsEventId: string | null;
  metadataJson: string;
  canonicalPayload: string;
  previousHash: string | null;
  hash: string;
  recordedAt: number;
};

export type LedgerProjectionCallback<T = void> = (
  db: BudgetDb,
  raw: Database,
  event: StoredLedgerEvent,
) => T | Promise<T>;

export type PostedLedgerEvent = StoredLedgerEvent & { movements: PositionedMovement[] };

export type LedgerFailure = {
  invariant: string;
  sequence?: number;
  eventId?: string;
};

export type LedgerVerificationResult = {
  ok: boolean;
  counts: {
    events: number;
    movements: number;
    ledgerAccounts: number;
    instruments: number;
    projectionRows: number;
  };
  failures: LedgerFailure[];
};
