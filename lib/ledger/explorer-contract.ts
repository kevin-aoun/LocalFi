import type { DateKey } from "@/lib/dates";
import type { LedgerAccountTargetType } from "@/lib/db/schema/ledger";

export const LEDGER_EXPLORER_DEFAULT_PAGE_SIZE = 30;
export const LEDGER_EXPLORER_MAX_PAGE_SIZE = 75;
export const LEDGER_EXPLORER_MAX_PAYLOAD_CHARS = 256_000;

export type LedgerExplorerFilters = {
  fromDate?: string | null;
  toDate?: string | null;
  currency?: string | null;
  targetType?: string | null;
  search?: string | null;
};

export type LedgerExplorerQuery = {
  beforeSequence?: number | null;
  pageSize?: number | null;
  filters?: LedgerExplorerFilters;
};

export type LedgerExplorerMovement = {
  position: number;
  ledgerAccountId: string;
  targetType: LedgerAccountTargetType;
  targetRef: string;
  targetLabel: string;
  amountMinor: number;
  currency: string;
  quantityDelta: string | null;
};

export type LedgerExplorerEvent = {
  eventId: string;
  sequence: number;
  payloadVersion: number;
  effectiveDate: DateKey;
  recordedAt: string;
  description: string;
  eventFact: string;
  hash: string;
  previousHash: string | null;
  amendsEventId: string | null;
  amendsSequence: number | null;
  movements: LedgerExplorerMovement[];
  balances: Array<{ currency: string; amountMinor: number }>;
};

export type LedgerEventPayload = {
  eventId: string;
  metadataJson: string;
  canonicalPayload: string;
  metadataValid: boolean;
};

export type LedgerExplorerPage = {
  events: LedgerExplorerEvent[];
  nextBeforeSequence: number | null;
  pageSize: number;
  stats: {
    eventCount: number;
    movementCount: number;
    chainHead: { sequence: number; eventId: string; hash: string } | null;
    currencies: string[];
  };
};

export function shouldRequestLedgerEventPayload(
  expanded: boolean,
  privacyActive: boolean,
): boolean {
  return expanded && !privacyActive;
}
