import { createHash } from "node:crypto";

import type { Database, SqlValue } from "sql.js";

import { toDateKey } from "@/lib/dates";
import { canonicalDecimal } from "@/lib/ledger/decimal";
import { canonicalStringify } from "@/lib/ledger/canonical";
import { buildTransactionMovements } from "@/lib/ledger/movements";
import { postLedgerEventRaw } from "@/lib/ledger/post-event";
import { recordInstrumentObservation } from "@/lib/investments/observations";
import { projectAllPositionHoldings } from "@/lib/investments/positions";
import { registerLedgerAccount } from "@/lib/ledger/targets";

type Row = Record<string, SqlValue>;

function rows(raw: Database, query: string, parameters: SqlValue[] = []): Row[] {
  const statement = raw.prepare(query);
  try {
    statement.bind(parameters);
    const result: Row[] = [];
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally {
    statement.free();
  }
}

function executeMigrationSql(raw: Database, sql: string): void {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) raw.exec(statement);
  }
}

function deterministicUuid(key: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`localfi-ledger-v1:${key}`).digest());
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isoCurrency(value: SqlValue): string {
  const currency = String(value ?? "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("migration found an invalid currency code");
  return currency;
}

function dateKey(epochSeconds: number): string {
  if (!Number.isSafeInteger(epochSeconds)) throw new Error("migration found an invalid event date");
  return toDateKey(new Date(epochSeconds * 1000));
}

function utcDateKey(epochSeconds: number): string {
  if (!Number.isSafeInteger(epochSeconds)) throw new Error("migration found an invalid event date");
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function parseLinkedTransactionIds(value: SqlValue): number[] {
  if (value == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: number[] = [];
  for (const item of parsed) {
    if (typeof item === "number" && Number.isSafeInteger(item) && !ids.includes(item)) {
      ids.push(item);
    }
  }
  return ids;
}

type OpeningDateEvidence = {
  effectiveDate: string;
  source: "linked-confirmed-transaction" | "asset-created-at";
  transactionId?: number;
  createdAt?: number;
};

function openingDateEvidence(
  raw: Database,
  linkedTransactionIds: number[],
  createdAt: number,
): OpeningDateEvidence {
  if (linkedTransactionIds.length > 0) {
    const placeholders = linkedTransactionIds.map(() => "?").join(", ");
    const candidates = rows(
      raw,
      `SELECT id, date FROM transactions
       WHERE pending = 0 AND id IN (${placeholders})
       ORDER BY date, id`,
      linkedTransactionIds,
    ).flatMap((transaction) => {
      try {
        const id = asSafeInteger(transaction.id, "linked transaction id");
        return [{ id, effectiveDate: dateKey(Number(transaction.date)) }];
      } catch {
        return [];
      }
    }).sort(
      (left, right) => left.effectiveDate.localeCompare(right.effectiveDate) || left.id - right.id,
    );
    const earliest = candidates[0];
    if (earliest) {
      return {
        source: "linked-confirmed-transaction",
        transactionId: earliest.id,
        effectiveDate: earliest.effectiveDate,
      };
    }
  }
  return { source: "asset-created-at", createdAt, effectiveDate: dateKey(createdAt) };
}

function asSafeInteger(value: SqlValue, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`migration found an invalid ${label}`);
  return number;
}

function currencyInstrument(raw: Database, currency: string, createdAt: number): string {
  const id = `currency:${currency}`;
  raw.run(
    `INSERT INTO instruments (id, kind, label, symbol, unit, price_currency, created_at)
     VALUES (?, 'currency', ?, ?, 'minor', ?, ?) ON CONFLICT(id) DO NOTHING`,
    [id, currency, currency, currency, createdAt],
  );
  return id;
}

function systemTarget(raw: Database, ref: string, currency: string, createdAt: number): string {
  return registerLedgerAccount(raw, {
    targetType: "system",
    targetRef: ref,
    currency,
    createdAt,
  });
}

function accountTarget(raw: Database, id: number | null, currency: string, createdAt: number): string {
  if (id === null) return systemTarget(raw, "legacy-unassigned-account", currency, createdAt);
  return registerLedgerAccount(raw, {
    targetType: "real_account",
    targetRef: id,
    currency,
    createdAt,
  });
}

function categoryTarget(raw: Database, id: number | null, currency: string, createdAt: number): string {
  if (id === null) return systemTarget(raw, "legacy-uncategorized", currency, createdAt);
  return registerLedgerAccount(raw, {
    targetType: "category",
    targetRef: id,
    currency,
    createdAt,
  });
}

function backfillAccounts(raw: Database): void {
  for (const account of rows(
    raw,
    `SELECT id, kind, opening_balance_cents, opening_balance_date, currency, created_at, updated_at
     FROM accounts ORDER BY opening_balance_date, id`,
  )) {
    const id = asSafeInteger(account.id, "account id");
    const amount = asSafeInteger(account.opening_balance_cents, "opening balance");
    const createdAt = asSafeInteger(account.created_at, "account creation time");
    const updatedAt = asSafeInteger(account.updated_at, "account update time");
    const storedOpeningDate = String(account.opening_balance_date);
    const createdLocalDate = dateKey(createdAt);
    const createdUtcDate = utcDateKey(createdAt);
    const hasMigrationGeneratedUtcDate = storedOpeningDate === createdUtcDate &&
      createdLocalDate !== createdUtcDate && updatedAt === createdAt;
    const effectiveDate = hasMigrationGeneratedUtcDate ? createdLocalDate : storedOpeningDate;
    if (hasMigrationGeneratedUtcDate) {
      raw.run("UPDATE accounts SET opening_balance_date = ? WHERE id = ?", [effectiveDate, id]);
    }
    const currency = isoCurrency(account.currency);
    currencyInstrument(raw, currency, createdAt);
    const realTarget = accountTarget(raw, id, currency, createdAt);
    if (amount === 0) continue;
    const signed = account.kind === "liability" ? -amount : amount;
    const openingTarget = systemTarget(raw, "opening-balance", currency, createdAt);
    postLedgerEventRaw(raw, {
      eventId: deterministicUuid(`account-opening:${id}`),
      effectiveDate,
      description: "Imported account opening balance",
      metadata: {
        provenance: {
          migration: "0012",
          legacyAccountId: id,
          fact: "opening-balance",
          openingDateEvidence: hasMigrationGeneratedUtcDate
            ? {
                source: "migration-0009-utc-created-at",
                storedDate: storedOpeningDate,
                createdAt,
                effectiveDate,
              }
            : { source: "stored-opening-balance-date", effectiveDate },
        },
      },
      movements: [
        { ledgerAccountId: realTarget, amountMinor: signed, currency },
        { ledgerAccountId: openingTarget, amountMinor: -signed, currency },
      ],
      recordedAt: createdAt,
    });
  }
}

function instrumentKind(category: string): "security" | "commodity" | "manual" {
  if (category === "Crypto") return "security";
  if (category === "Commodities") return "commodity";
  return "manual";
}

function backfillAssets(raw: Database): void {
  for (const asset of rows(
    raw,
    `SELECT id, category, current_value_cents, currency, quantity, unit, price_symbol,
            linked_transaction_ids, created_at
     FROM assets ORDER BY created_at, id`,
  )) {
    const id = asSafeInteger(asset.id, "asset id");
    if (String(asset.category) === "Cash") continue;
    const amount = asSafeInteger(asset.current_value_cents, "asset value");
    const createdAt = asSafeInteger(asset.created_at, "asset creation time");
    const linkedTransactionIds = parseLinkedTransactionIds(asset.linked_transaction_ids);
    const dateEvidence = openingDateEvidence(raw, linkedTransactionIds, createdAt);
    const currency = isoCurrency(asset.currency);
    currencyInstrument(raw, currency, createdAt);
    const legacySymbol = asset.price_symbol == null ? null : String(asset.price_symbol).toUpperCase();
    const quantity = asset.quantity == null ? null : canonicalDecimal(Number(asset.quantity));
    const symbol = legacySymbol && quantity !== null && quantity !== "0" ? legacySymbol : null;
    const instrumentId = `instrument:legacy-asset:${id}`;
    const unit = asset.unit == null ? "position" : String(asset.unit);
    raw.run(
      `INSERT INTO instruments
        (id, kind, label, symbol, unit, category, price_source, price_currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      [
        instrumentId,
        instrumentKind(String(asset.category)),
        symbol ?? `${String(asset.category)} position`,
        symbol,
        unit,
        String(asset.category),
        symbol ? "legacy-live-price" : null,
        symbol ? "USD" : null,
        createdAt,
      ],
    );
    raw.run("UPDATE assets SET instrument_id = ? WHERE id = ?", [instrumentId, id]);
    const instrumentTarget = registerLedgerAccount(raw, {
      targetType: "instrument",
      targetRef: `asset:${id}`,
      currency,
      instrumentId,
      createdAt,
    });
    const openingTarget = systemTarget(raw, "opening-position", currency, createdAt);
    postLedgerEventRaw(raw, {
      eventId: deterministicUuid(`asset-opening:${id}`),
      effectiveDate: dateEvidence.effectiveDate,
      description: "Imported opening position",
      metadata: {
        provenance: {
          migration: "0012",
          legacyAssetId: id,
          fact: "opening-position",
          linkedTransactionIds,
          openingDateEvidence: dateEvidence,
          quantityAllocation: "not-inferred",
        },
      },
      movements: [
        {
          ledgerAccountId: instrumentTarget,
          amountMinor: amount,
          currency,
          quantityDelta: quantity === "0" ? null : quantity,
        },
        { ledgerAccountId: openingTarget, amountMinor: -amount, currency },
      ],
      recordedAt: createdAt,
    });
    if (symbol) {
      const quantityNumber = Number(quantity);
      const unitPrice = Math.round(amount / quantityNumber);
      if (Number.isSafeInteger(unitPrice) && unitPrice > 0) {
        recordInstrumentObservation(raw, {
          instrumentId,
          observationKind: "price",
          observedDay: dateEvidence.effectiveDate,
          observedAt: createdAt,
          amountMinor: unitPrice,
          currency,
          source: "migration-0012-stored-valuation",
        });
      }
    }
    if (!symbol || amount !== 0) {
      recordInstrumentObservation(raw, {
        instrumentId,
        observationKind: "valuation",
        observedDay: dateEvidence.effectiveDate,
        observedAt: createdAt,
        amountMinor: amount,
        currency,
        source: "migration-0012-stored-valuation",
      });
    }
  }
  projectAllPositionHoldings(raw);
}

function backfillTransactions(raw: Database): void {
  const accountCurrencies = new Map<number, string>(
    rows(raw, "SELECT id, currency FROM accounts").map((row) => [
      asSafeInteger(row.id, "account id"),
      isoCurrency(row.currency),
    ]),
  );
  for (const transaction of rows(
    raw,
    `SELECT id, date, category_id, account_id, transfer_account_id, amount_cents,
            direction, currency, comment, pending, recurring_id, recurring_occurrence,
            created_at, updated_at
     FROM transactions ORDER BY date, id`,
  )) {
    if (Number(transaction.pending) === 1) continue;
    const id = asSafeInteger(transaction.id, "transaction id");
    const occurredAt = asSafeInteger(transaction.date, "transaction date");
    const createdAt = asSafeInteger(transaction.created_at, "transaction creation time");
    const updatedAt = asSafeInteger(transaction.updated_at, "transaction update time");
    const amountMinor = asSafeInteger(transaction.amount_cents, "transaction amount");
    const currency = isoCurrency(transaction.currency);
    currencyInstrument(raw, currency, createdAt);
    const accountId = transaction.account_id == null
      ? null
      : asSafeInteger(transaction.account_id, "source account id");
    const transferId = transaction.transfer_account_id == null
      ? null
      : asSafeInteger(transaction.transfer_account_id, "destination account id");
    if (transferId !== null && accountCurrencies.get(transferId) !== currency) {
      throw new Error("migration found a cross-currency transfer");
    }
    const categoryId = transaction.category_id == null
      ? null
      : asSafeInteger(transaction.category_id, "category id");
    const direction = String(transaction.direction) as "inflow" | "outflow" | "transfer";
    const movements = buildTransactionMovements({
      direction,
      amountMinor,
      currency,
      accountTargetId: accountTarget(raw, accountId, currency, createdAt),
      categoryTargetId: direction === "transfer"
        ? null
        : categoryTarget(raw, categoryId, currency, createdAt),
      transferTargetId: transferId === null
        ? null
        : accountTarget(raw, transferId, currency, createdAt),
    });
    const event = postLedgerEventRaw(raw, {
      eventId: deterministicUuid(`transaction:${id}`),
      effectiveDate: dateKey(occurredAt),
      description: transaction.comment == null ? "" : String(transaction.comment),
      metadata: {
        projectionKey: id,
        transaction: {
          id,
          date: occurredAt,
          categoryId,
          accountId,
          transferAccountId: transferId,
          amountCents: amountMinor,
          direction,
          currency,
          comment: transaction.comment == null ? null : String(transaction.comment),
          pending: false,
          recurringId: transaction.recurring_id == null
            ? null
            : asSafeInteger(transaction.recurring_id, "recurring id"),
          recurringOccurrence: transaction.recurring_occurrence == null
            ? null
            : String(transaction.recurring_occurrence),
          instrumentId: null,
          quantityDelta: null,
          transferPrincipalAmountCents: null,
          allocations: [],
          createdAt,
          updatedAt,
        },
        provenance: { migration: "0012", legacyTransactionId: id },
      },
      movements,
      recordedAt: updatedAt,
    });
    raw.run("UPDATE transactions SET current_event_id = ? WHERE id = ?", [event.eventId, id]);
  }
}

export function assertImmutableLedgerBackfill(raw: Database): void {
  const unlinked = Number(
    raw.exec("SELECT COUNT(*) FROM transactions WHERE pending = 0 AND current_event_id IS NULL")[0]
      ?.values[0]?.[0] ?? 0,
  );
  if (unlinked !== 0) throw new Error("confirmed transaction projection is missing a ledger event");
  const undersized = Number(
    raw.exec(
      `SELECT COUNT(*) FROM ledger_events e
       WHERE (SELECT COUNT(*) FROM ledger_movements m WHERE m.event_id = e.event_id) < 2`,
    )[0]?.values[0]?.[0] ?? 0,
  );
  if (undersized !== 0) throw new Error("a migrated ledger event has fewer than two movements");
  const missingHoldingProvenance = Number(
    raw.exec(
      `SELECT COUNT(*) FROM assets
       WHERE category <> 'Cash' AND instrument_id IS NULL`,
    )[0]?.values[0]?.[0] ?? 0,
  );
  if (missingHoldingProvenance !== 0) {
    throw new Error("a legacy holding is missing its imported instrument identity");
  }
  const cashInstrumentPositions = Number(
    raw.exec("SELECT COUNT(*) FROM assets WHERE category = 'Cash' AND instrument_id IS NOT NULL")[0]
      ?.values[0]?.[0] ?? 0,
  );
  if (cashInstrumentPositions !== 0) {
    throw new Error("derived Cash cannot be migrated as an instrument position");
  }
}

/** Apply schema plus deterministic provenance backfill to an upgrade-owned image. */
export function applyImmutableLedgerMigration(raw: Database, migrationSql: string): void {
  raw.create_function("ledger_sha256", (value: unknown) => {
    if (typeof value !== "string") throw new Error("ledger_sha256 requires text");
    return createHash("sha256").update(value).digest("hex");
  });
  raw.create_function("ledger_canonical_json", (value: unknown) => {
    if (typeof value !== "string") throw new Error("ledger_canonical_json requires text");
    return canonicalStringify(JSON.parse(value));
  });
  raw.create_function("ledger_canonical_decimal", (value: unknown) => {
    if (typeof value !== "string") throw new Error("ledger_canonical_decimal requires text");
    return canonicalDecimal(value);
  });
  raw.run("BEGIN IMMEDIATE");
  try {
    executeMigrationSql(raw, migrationSql);
    backfillAccounts(raw);
    backfillAssets(raw);
    backfillTransactions(raw);
    assertImmutableLedgerBackfill(raw);
    raw.run("COMMIT");
  } catch (error) {
    try { raw.run("ROLLBACK"); } catch { /* preserve the original failure */ }
    throw error;
  }
}
