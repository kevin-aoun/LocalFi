/**
 * Recurrence math for recurring transactions — pure, timezone-safe, anchored.
 *
 * WHY THIS IS ANCHORED AND NOT INCREMENTAL: the obvious implementation advances
 * the previous occurrence by one month. That is wrong. "Rent on the 31st" then
 * becomes Jan 31 -> Feb 28 -> Mar 28 -> Apr 28 and the user's rent day silently
 * drifts to the 28th forever. Every occurrence here is computed from the ANCHOR
 * (`startDate`) by index, so a short month is clamped for that month only and the
 * next long month restores the anchor day. The same rule recovers Feb 29 on the
 * following leap year for a yearly rule.
 *
 * Everything in and out is a `DateKey` ('YYYY-MM-DD'), which compares
 * lexicographically in calendar order, so no Date instance ever crosses this
 * module's boundary and `toISOString()` is never involved.
 */
import { fromDateKey, isDateKey, toDateKey, type DateKey } from "./dates";

export const frequencies = ["daily", "weekly", "monthly", "yearly"] as const;
export type Frequency = (typeof frequencies)[number];

export type RecurrenceRule = {
  frequency: Frequency;
  /** Every `interval` days/weeks/months/years. Integer >= 1. */
  interval: number;
  /** The FIRST occurrence, and the anchor every later one is derived from. */
  startDate: DateKey;
  /** Inclusive last day an occurrence may fall on. null/undefined = open-ended. */
  endDate?: DateKey | null;
};

/**
 * Hard ceiling on how many occurrences a single walk will enumerate. A daily
 * rule anchored in 1970 would otherwise spin for ~20k iterations per call; past
 * this we throw rather than hang or post nonsense.
 */
const MAX_OCCURRENCES = 20_000;

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

function assertRule(rule: RecurrenceRule) {
  if (!frequencies.includes(rule.frequency)) {
    throw new Error(`Invalid recurrence frequency: ${String(rule.frequency)}`);
  }
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new Error(
      `Invalid recurrence interval: expected an integer >= 1, received ${String(rule.interval)}`,
    );
  }
  if (!isDateKey(rule.startDate)) {
    throw new Error(
      `Invalid recurrence startDate: expected 'YYYY-MM-DD' for a real calendar day, received ${JSON.stringify(rule.startDate)}`,
    );
  }
  if (rule.endDate != null && !isDateKey(rule.endDate)) {
    throw new Error(
      `Invalid recurrence endDate: expected 'YYYY-MM-DD' or null, received ${JSON.stringify(rule.endDate)}`,
    );
  }
}

/**
 * The `index`-th (0-based) occurrence of `rule`, as a DateKey.
 *
 * Month/year steps clamp to the last day of the target month when the anchor day
 * does not exist there (Jan 31 -> Feb 28/29), but the anchor day itself is never
 * mutated, so the sequence returns to it in the next long month.
 */
export function occurrenceAt(rule: RecurrenceRule, index: number): DateKey {
  assertRule(rule);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid occurrence index: expected an integer >= 0, received ${String(index)}`);
  }

  const anchor = fromDateKey(rule.startDate);
  const year = anchor.getFullYear();
  const month0 = anchor.getMonth();
  const day = anchor.getDate();
  const step = index * rule.interval;

  switch (rule.frequency) {
    case "daily":
      return toDateKey(new Date(year, month0, day + step));
    case "weekly":
      return toDateKey(new Date(year, month0, day + step * 7));
    case "monthly": {
      const absolute = month0 + step;
      const targetYear = year + Math.floor(absolute / 12);
      const targetMonth = ((absolute % 12) + 12) % 12;
      return toDateKey(
        new Date(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth))),
      );
    }
    case "yearly": {
      const targetYear = year + step;
      return toDateKey(new Date(targetYear, month0, Math.min(day, daysInMonth(targetYear, month0))));
    }
  }
}

export type OccurrenceWalkOptions = {
  /**
   * Skip every occurrence up to AND INCLUDING this day. This is the catch-up
   * cursor: pass the template's `last_generated`, or null/undefined for "never
   * generated". Occurrences are emitted strictly after it.
   */
  afterKey?: DateKey | null;
  /** Stop after this many occurrences. Defaults to MAX_OCCURRENCES. */
  limit?: number;
};

/**
 * Every occurrence in `(afterKey, throughKey]`, also bounded by `rule.endDate`.
 *
 * Strictly increasing, never duplicated — the two properties a materialiser
 * needs so that "catch up on six missed months" posts each month exactly once.
 */
export function occurrencesThrough(
  rule: RecurrenceRule,
  throughKey: DateKey,
  options: OccurrenceWalkOptions = {},
): DateKey[] {
  assertRule(rule);
  if (!isDateKey(throughKey)) {
    throw new Error(
      `Invalid through date: expected 'YYYY-MM-DD', received ${JSON.stringify(throughKey)}`,
    );
  }
  const { afterKey = null, limit = MAX_OCCURRENCES } = options;
  if (afterKey != null && !isDateKey(afterKey)) {
    throw new Error(`Invalid afterKey: expected 'YYYY-MM-DD' or null, received ${JSON.stringify(afterKey)}`);
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`Invalid limit: expected an integer >= 0, received ${String(limit)}`);
  }

  // The end date can only shorten the window, never extend it.
  const ceiling = rule.endDate != null && rule.endDate < throughKey ? rule.endDate : throughKey;

  const out: DateKey[] = [];
  for (let index = 0; index < MAX_OCCURRENCES; index++) {
    const key = occurrenceAt(rule, index);
    if (key > ceiling) return out;
    if (afterKey != null && key <= afterKey) continue;
    out.push(key);
    if (out.length >= limit) return out;
  }

  throw new Error(
    `Recurrence walk exceeded ${MAX_OCCURRENCES} occurrences (${rule.frequency}/${rule.interval} from ${rule.startDate} through ${ceiling}); refusing to enumerate further`,
  );
}

/**
 * The first occurrence strictly after `afterKey` (or the anchor when `afterKey`
 * is null), or null when the rule has no further occurrences because its end
 * date has passed. `afterKey` need not itself be an occurrence.
 */
export function nextOccurrenceAfter(rule: RecurrenceRule, afterKey: DateKey | null): DateKey | null {
  assertRule(rule);
  if (afterKey != null && !isDateKey(afterKey)) {
    throw new Error(`Invalid afterKey: expected 'YYYY-MM-DD' or null, received ${JSON.stringify(afterKey)}`);
  }

  for (let index = 0; index < MAX_OCCURRENCES; index++) {
    const key = occurrenceAt(rule, index);
    if (afterKey != null && key <= afterKey) continue;
    if (rule.endDate != null && key > rule.endDate) return null;
    return key;
  }

  throw new Error(
    `Recurrence walk exceeded ${MAX_OCCURRENCES} occurrences looking for the successor of ${String(afterKey)}`,
  );
}
