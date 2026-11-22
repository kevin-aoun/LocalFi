import type { Database } from "sql.js";
import { readCurrentMovements, readPortfolioMovements } from "@/lib/ledger/reads";
import { addCanonicalDecimals } from "@/lib/ledger/decimal";

export type InvestmentSide = "buy" | "sell";

// Check the whole effective-date timeline so edits/deletes cannot orphan later sales.
export function assertAvailableInvestmentUnits(raw: Database, instrumentId: string, currency: string): void {
  const days = new Map<string, string>();
  for (const movement of readPortfolioMovements(raw, readCurrentMovements(raw))) {
    if (movement.targetType !== "instrument" || movement.instrumentId !== instrumentId || movement.currency !== currency) continue;
    days.set(movement.dateKey, addCanonicalDecimals(days.get(movement.dateKey) ?? "0", movement.quantityDelta ?? "0"));
  }
  let quantity = "0";
  for (const day of [...days.keys()].sort()) {
    quantity = addCanonicalDecimals(quantity, days.get(day)!);
    if (quantity.startsWith("-")) throw new Error(`Not enough units on ${day}. Check the sale quantity, date, and earlier purchases.`);
  }
}
