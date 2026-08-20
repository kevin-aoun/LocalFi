import type { Database } from "sql.js";

import { isDateKey, type DateKey } from "@/lib/dates";
import { canonicalDecimal } from "@/lib/ledger/decimal";
import {
  correctLedgerEventInput,
  deleteLedgerEventInput,
  postLedgerEventRaw,
} from "@/lib/ledger/post-event";
import { readCurrentMovements } from "@/lib/ledger/reads";
import { registerLedgerAccount } from "@/lib/ledger/targets";
import type {
  CanonicalMetadata,
  LedgerMovementInput,
  PostedLedgerEvent,
} from "@/lib/ledger/types";
import { allRows } from "./sql";

type AssetOpeningChain = {
  rootEventId: string;
  headEventId: string;
  effectiveDate: DateKey;
  instrumentId: string;
  currency: string;
  metadata: CanonicalMetadata;
  movements: LedgerMovementInput[];
};

function parseMetadata(value: unknown): CanonicalMetadata {
  const parsed: unknown = JSON.parse(String(value));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Opening-position metadata is invalid");
  }
  return parsed as CanonicalMetadata;
}

function openingAssetId(metadata: CanonicalMetadata): number | null {
  if (metadata.fact === "opening-position" && Number.isSafeInteger(metadata.assetId)) {
    return Number(metadata.assetId);
  }
  const provenance = metadata.provenance;
  if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) return null;
  if (provenance.fact !== "opening-position" || !Number.isSafeInteger(provenance.legacyAssetId)) {
    return null;
  }
  return Number(provenance.legacyAssetId);
}

function stableOpeningProvenance(
  existing: CanonicalMetadata | undefined,
  source: PostAssetOpeningInput["source"],
): CanonicalMetadata {
  const provenance = existing?.provenance;
  if (typeof provenance === "object" && provenance !== null && !Array.isArray(provenance)) {
    return provenance as CanonicalMetadata;
  }
  return { source };
}

export function findAssetOpeningChain(raw: Database, assetId: number): AssetOpeningChain | null {
  const events = allRows(
    raw,
    `SELECT event_id, amends_event_id, effective_date, metadata_json
       FROM ledger_events ORDER BY sequence`,
  );
  const childByParent = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    if (event.amends_event_id != null) childByParent.set(String(event.amends_event_id), event);
  }
  const root = events.find((event) =>
    event.amends_event_id == null && openingAssetId(parseMetadata(event.metadata_json)) === assetId
  );
  if (!root) return null;
  let head = root;
  while (childByParent.has(String(head.event_id))) head = childByParent.get(String(head.event_id))!;
  const current = readCurrentMovements(raw)
    .filter((movement) => movement.chainRootEventId === String(root.event_id));
  const instrumentMovement = current.find((movement) => movement.targetType === "instrument");
  const rootInstrument = allRows(
    raw,
    `SELECT la.instrument_id, m.currency
       FROM ledger_movements m
       JOIN ledger_accounts la ON la.id = m.ledger_account_id
      WHERE m.event_id = ? AND la.target_type = 'instrument' LIMIT 1`,
    [String(root.event_id)],
  )[0];
  const instrumentId = instrumentMovement?.instrumentId ??
    (rootInstrument?.instrument_id == null ? null : String(rootInstrument.instrument_id));
  if (instrumentId === null) throw new Error(`Opening position for asset ${assetId} has no instrument`);
  const currency = instrumentMovement?.currency ?? String(rootInstrument.currency);
  return {
    rootEventId: String(root.event_id),
    headEventId: String(head.event_id),
    effectiveDate: String(head.effective_date) as DateKey,
    instrumentId,
    currency,
    metadata: parseMetadata(head.metadata_json),
    movements: current.map((movement) => ({
      ledgerAccountId: movement.ledgerAccountId,
      amountMinor: movement.amountMinor,
      currency: movement.currency,
      quantityDelta: movement.quantityDelta,
    })),
  };
}

function openingMovements(
  raw: Database,
  input: {
    assetId: number;
    instrumentId: string;
    currency: string;
    quantity: string;
    bookAmountMinor: number;
  },
): LedgerMovementInput[] {
  if (!Number.isSafeInteger(input.bookAmountMinor)) throw new Error("Opening value is invalid");
  const quantity = canonicalDecimal(input.quantity);
  if (quantity.startsWith("-")) throw new Error("Opening quantity cannot be negative");
  const instrumentTarget = registerLedgerAccount(raw, {
    targetType: "instrument",
    targetRef: `asset:${input.assetId}`,
    currency: input.currency,
    instrumentId: input.instrumentId,
  });
  const counterTarget = registerLedgerAccount(raw, {
    targetType: "system",
    targetRef: "opening-position",
    currency: input.currency,
  });
  return [
    {
      ledgerAccountId: instrumentTarget,
      amountMinor: input.bookAmountMinor,
      currency: input.currency,
      quantityDelta: quantity === "0" ? null : quantity,
    },
    {
      ledgerAccountId: counterTarget,
      amountMinor: -input.bookAmountMinor,
      currency: input.currency,
    },
  ];
}

export type PostAssetOpeningInput = {
  assetId: number;
  instrumentId: string;
  currency: string;
  quantity: string;
  bookAmountMinor: number;
  effectiveDate: DateKey;
  description: string;
  recordedAt?: number | Date;
  source: "manual-holding" | "manual-live-holding";
};


export function postAssetOpeningPosition(
  raw: Database,
  input: PostAssetOpeningInput,
): PostedLedgerEvent {
  if (!isDateKey(input.effectiveDate)) throw new Error("Opening position needs a valid DateKey");
  const currency = input.currency.trim().toUpperCase();
  const existing = findAssetOpeningChain(raw, input.assetId);
  if (existing && (existing.instrumentId !== input.instrumentId || existing.currency !== currency)) {
    throw new Error("A posted holding cannot change instrument or currency; create a new holding instead");
  }
  const movements = openingMovements(raw, { ...input, currency });
  const metadata: CanonicalMetadata = {
    ...(existing?.metadata ?? {}),
    fact: "opening-position",
    assetId: input.assetId,
    instrumentId: input.instrumentId,
    quantity: canonicalDecimal(input.quantity),
    bookAmountMinor: input.bookAmountMinor,
    currency,
    provenance: stableOpeningProvenance(existing?.metadata, input.source),
  };
  const common = {
    effectiveDate: existing?.effectiveDate ?? input.effectiveDate,
    description: input.description,
    metadata,
    recordedAt: input.recordedAt,
  };
  return existing
    ? postLedgerEventRaw(raw, correctLedgerEventInput(
        existing.headEventId,
        existing.movements,
        movements,
        common,
      ))
    : postLedgerEventRaw(raw, { ...common, movements });
}


export function deleteAssetOpeningPosition(
  raw: Database,
  assetId: number,
  recordedAt: number | Date = new Date(),
): PostedLedgerEvent | null {
  const existing = findAssetOpeningChain(raw, assetId);
  if (!existing || existing.movements.length === 0) return null;
  return postLedgerEventRaw(raw, deleteLedgerEventInput(existing.headEventId, existing.movements, {
    effectiveDate: existing.effectiveDate,
    description: "Delete opening position",
    metadata: {
      ...existing.metadata,
      fact: "opening-position",
      assetId,
      deleted: true,
    },
    recordedAt,
  }));
}
