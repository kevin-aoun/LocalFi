import type { Database } from "sql.js";

import type { LedgerAccountTargetType } from "@/lib/db/schema/ledger";

function currencyCode(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter ISO code");
  return currency;
}

export function ledgerAccountId(
  targetType: LedgerAccountTargetType,
  targetRef: string | number,
  currency: string,
): string {
  const ref = String(targetRef).trim();
  if (!ref) throw new Error("ledger target reference cannot be empty");
  return `${targetType}:${encodeURIComponent(ref)}:${currencyCode(currency)}`;
}

export type RegisterLedgerAccountInput = {
  targetType: LedgerAccountTargetType;
  targetRef: string | number;
  currency: string;
  instrumentId?: string | null;
  createdAt?: number;
};

/** Register or verify a target without creating a second domain identity. */
export function registerLedgerAccount(
  raw: Database,
  input: RegisterLedgerAccountInput,
): string {
  const currency = currencyCode(input.currency);
  const targetRef = String(input.targetRef).trim();
  const id = ledgerAccountId(input.targetType, targetRef, currency);
  const instrumentId = input.instrumentId ?? null;
  if ((input.targetType === "instrument") !== (instrumentId !== null)) {
    throw new Error("instrument targets must name exactly one registered instrument");
  }
  if (input.targetType === "real_account" || input.targetType === "category") {
    if (!/^[1-9]\d*$/.test(targetRef)) {
      throw new Error(`${input.targetType} target must use a positive integer reference`);
    }
    const table = input.targetType === "real_account" ? "accounts" : "categories";
    const statement = raw.prepare(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`);
    try {
      statement.bind([Number(targetRef)]);
      if (!statement.step()) throw new Error(`${input.targetType} target does not exist`);
    } finally {
      statement.free();
    }
  }
  raw.run(
    `INSERT INTO ledger_accounts
      (id, target_type, target_ref, currency, instrument_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [id, input.targetType, targetRef, currency, instrumentId, input.createdAt ?? Math.floor(Date.now() / 1000)],
  );
  const statement = raw.prepare(
    `SELECT target_type, target_ref, currency, instrument_id
     FROM ledger_accounts WHERE id = ?`,
  );
  try {
    statement.bind([id]);
    if (!statement.step()) throw new Error("ledger target registration failed");
    const row = statement.get();
    if (
      row[0] !== input.targetType || row[1] !== targetRef || row[2] !== currency ||
      (row[3] ?? null) !== instrumentId
    ) {
      throw new Error("ledger target id is already registered to a different target");
    }
  } finally {
    statement.free();
  }
  return id;
}
