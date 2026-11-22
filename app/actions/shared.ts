// Shared Server Action plumbing. Deliberately not "use server": these helpers are not endpoints.

import { isDateKey, type DateKey } from "@/lib/dates";
import type { Cents } from "@/lib/money";

export type ActionResult<T> = { success: true; data: T } | { error: string };

export function str(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export function requireDateKey(value: string | null, label: string): DateKey {
  if (!isDateKey(value)) {
    throw new Error(`Invalid ${label}: expected 'YYYY-MM-DD', received ${JSON.stringify(value)}`);
  }
  return value;
}

export function requireMagnitude(cents: Cents, label = "Amount"): Cents {
  if (cents < 0) throw new Error(`${label} cannot be negative`);
  return cents;
}
