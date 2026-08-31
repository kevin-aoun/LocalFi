import {
  percentageOfBudgetCents,
  reallocationMaximumCents,
} from "@/lib/budgets";
import { tryParseAmount, type Cents } from "@/lib/money";

export type ReallocationInputMode = "amount" | "percentage";

export function percentageBasisPoints(value: string): number | null {
  const raw = value.trim().replace(/%$/, "");
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return basisPoints >= 1 && basisPoints <= 10_000 ? basisPoints : null;
}

export function draftedReallocationCents(
  mode: ReallocationInputMode,
  value: string,
  budgetedCents: Cents | null,
): Cents | null {
  if (mode === "amount") return tryParseAmount(value);
  if (budgetedCents === null) return null;
  const basisPoints = percentageBasisPoints(value);
  return basisPoints === null ? null : percentageOfBudgetCents(budgetedCents, basisPoints);
}

export function reallocationOverflowCents(
  candidateCents: Cents | null,
  maximumCents: Cents | null,
): Cents | null {
  if (candidateCents === null || maximumCents === null || candidateCents <= maximumCents) {
    return null;
  }
  return (candidateCents - maximumCents) as Cents;
}

export { reallocationMaximumCents };
