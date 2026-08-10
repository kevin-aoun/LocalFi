import type { Database } from "sql.js";

import { withDb } from "@/lib/db/client";
import { projectAllPositionHoldings } from "@/lib/investments/positions";

import {
  deriveCashAssetProjectionFromJournal,
  deriveCurrentTransactions,
  deriveInstrumentPositions,
  expectedCashProjectionMarker,
  verifyLedgerRaw,
} from "./verify";

export type LedgerRebuildResult = {
  transactions: number;
  positions: number;
  assets: number;
  eventCount: number;
};

function insertTransaction(raw: Database, eventId: string, transaction: Record<string, unknown>): void {
  const nullableNumber = (value: unknown) => value == null ? null : Number(value);
  const nullableString = (value: unknown) => value == null ? null : String(value);
  raw.run(
    `INSERT INTO transactions
      (id, date, category_id, account_id, transfer_account_id, amount_cents, direction, currency,
       current_event_id, instrument_id, quantity_delta, transfer_principal_amount_cents, comment,
       pending, recurring_id, recurring_occurrence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      Number(transaction.id), Number(transaction.date), nullableNumber(transaction.categoryId),
      nullableNumber(transaction.accountId), nullableNumber(transaction.transferAccountId),
      Number(transaction.amountCents), String(transaction.direction), String(transaction.currency),
      eventId, nullableString(transaction.instrumentId), nullableString(transaction.quantityDelta),
      nullableNumber(transaction.transferPrincipalAmountCents), nullableString(transaction.comment),
      nullableNumber(transaction.recurringId), nullableString(transaction.recurringOccurrence),
      Number(transaction.createdAt), Number(transaction.updatedAt),
    ],
  );
  const allocations = Array.isArray(transaction.allocations) ? transaction.allocations : [];
  allocations.forEach((allocation, position) => {
    const item = allocation as Record<string, unknown>;
    raw.run(
      `INSERT INTO transaction_allocations (transaction_id, position, category_id, amount_cents)
       VALUES (?, ?, ?, ?)`,
      [Number(transaction.id), position, Number(item.categoryId), Number(item.amountCents)],
    );
  });
}

/** Repair only the provenance-marked Cash row; documented extras stay untouched. */
export function rebuildCashAssetProjectionRaw(raw: Database): void {
  const cash = deriveCashAssetProjectionFromJournal(raw);
  if (cash.kind === "invalid-marker") {
    throw new Error("Cash projection marker state is invalid");
  }
  let managedAssetId: number;
  if (cash.assetId === null) {
    raw.run(
      `INSERT INTO assets (category, current_value_cents, currency, notes)
       VALUES ('Cash', ?, ?, ?)`,
      [
        cash.currentValueCents,
        cash.currency,
        `Auto-calculated from ${cash.currency} transactions`,
      ],
    );
    managedAssetId = Number(raw.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0]);
  } else {
    raw.run(
      `UPDATE assets SET current_value_cents = ?, currency = ?, updated_at = unixepoch()
        WHERE id = ? AND category = 'Cash'`,
      [cash.currentValueCents, cash.currency, cash.assetId],
    );
    managedAssetId = cash.assetId;
  }
  const nextMarker = expectedCashProjectionMarker(cash, managedAssetId);
  if (cash.marker !== nextMarker) {
    raw.run(
      "INSERT INTO ledger_projection_state (projection, event_count) VALUES (?, 0)",
      [nextMarker],
    );
    if (cash.marker !== null) {
      raw.run("DELETE FROM ledger_projection_state WHERE projection = ?", [cash.marker]);
    }
  }
}

/** CONTRACT-014: raw projection rebuild used by the leased command and migration tests. */
export function rebuildLedgerProjectionsRaw(raw: Database): LedgerRebuildResult {
    const before = verifyLedgerRaw(raw);
    if (before.failures.some((item) => item.invariant === "projection.cash_marker")) {
      throw new Error("Cash projection marker verification failed; rebuild was refused");
    }
    if (before.failures.some((item) => !item.invariant.startsWith("projection."))) {
      throw new Error("journal verification failed; projection rebuild was refused");
    }
    const transactions = deriveCurrentTransactions(raw);
    const positions = deriveInstrumentPositions(raw);

    raw.run(
      `DELETE FROM transaction_allocations
       WHERE transaction_id IN (SELECT id FROM transactions WHERE pending = 0)`,
    );
    raw.run("DELETE FROM transactions WHERE pending = 0");
    for (const projected of transactions) {
      if (projected.transaction !== null) {
        insertTransaction(raw, projected.eventId, projected.transaction);
      }
    }

    rebuildCashAssetProjectionRaw(raw);

    raw.run("DELETE FROM instrument_positions");
    for (const position of positions) {
      raw.run(
        `INSERT INTO instrument_positions
          (instrument_id, quantity, book_amount_minor, currency, current_event_id)
         VALUES (?, ?, ?, ?, ?)`,
        [
          position.instrumentId,
          position.quantity,
          position.bookAmountMinor,
          position.currency,
          position.currentEventId,
        ],
      );
    }
    raw.run(
      `DELETE FROM assets
        WHERE category <> 'Cash'
          AND (instrument_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM instrument_positions p
             WHERE p.instrument_id = assets.instrument_id AND p.currency = assets.currency
          ))`,
    );
    raw.run(
      `DELETE FROM assets
        WHERE category <> 'Cash' AND instrument_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM instrument_positions p
             WHERE p.instrument_id = assets.instrument_id AND p.currency = assets.currency
               AND p.quantity = '0' AND p.book_amount_minor = 0
          )`,
    );
    const projectedAssets = projectAllPositionHoldings(raw);

    const head = raw.exec(
      "SELECT event_id, hash, sequence FROM ledger_events ORDER BY sequence DESC LIMIT 1",
    )[0]?.values[0];
    raw.run(
      `INSERT INTO ledger_projection_state
        (projection, last_event_id, last_event_hash, event_count, rebuilt_at)
       VALUES ('all', ?, ?, ?, unixepoch())
       ON CONFLICT(projection) DO UPDATE SET
         last_event_id = excluded.last_event_id,
         last_event_hash = excluded.last_event_hash,
         event_count = excluded.event_count,
         rebuilt_at = excluded.rebuilt_at`,
      [head?.[0] ?? null, head?.[1] ?? null, head?.[2] ?? 0],
    );
    const result = {
      transactions: transactions.filter((item) => item.transaction !== null).length,
      positions: positions.length,
      assets: projectedAssets.length,
      eventCount: before.counts.events,
    };
    const after = verifyLedgerRaw(raw);
    if (!after.ok) throw new Error("projection rebuild verification failed");
    return result;
}

/** CONTRACT-014: rebuilds projections only; journal tables are never mutated. */
export async function rebuildLedgerProjections(): Promise<LedgerRebuildResult> {
  return withDb((_db, raw) => rebuildLedgerProjectionsRaw(raw));
}
