
import { fromDateKey, isDateKey, toDateKey, type DateKey } from "./dates";

export const frequencies = ["daily", "weekly", "monthly", "yearly"] as const;
export type Frequency = (typeof frequencies)[number];

export type RecurrenceRule = {
  frequency: Frequency;

  interval: number;

  startDate: DateKey;

  endDate?: DateKey | null;
};

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

  afterKey?: DateKey | null;

  limit?: number;
};


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
