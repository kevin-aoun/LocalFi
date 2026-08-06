/**
 * Pure logic behind the Recurring Transactions UI.
 *
 * WHY THIS FILE EXISTS: there is no jsdom/RTL harness in this repo, so every
 * decision the dialog and the list make that could be *wrong* lives here, where
 * vitest can assert it — including under the extreme timezones `npm run test:tz`
 * runs at. Three traps this codebase has been bitten by before are all in scope:
 *
 *   1. `toISOString()` on a calendar day shifts the day for anyone not on UTC.
 *      Every date leaves this module through `toDateKey`, never a UTC round trip.
 *   2. A `0` amount is a real value. Deciding "should I send this field?" with
 *      truthiness silently drops it, so the check here is `=== ""` / `=== null`,
 *      never `if (amount)`.
 *   3. A generator that reports "done" when it posted nothing hides the case the
 *      user most needs to see, so `summarizeGenerationReport` always exposes BOTH
 *      the posted and the skipped count.
 *
 * Occurrence math is NOT re-derived here: `lib/recurrence.ts` owns it and is
 * separately unit-tested. This module only *presents* what that engine says.
 */
import { format } from "date-fns";

import { fromDateKey, toDateKey, type DateKey } from "@/lib/dates";
import { centsToDecimal, sumCents, tryParseAmount, type Cents } from "@/lib/money";
import {
  nextOccurrenceAfter,
  occurrencesThrough,
  type Frequency,
  type RecurrenceRule,
} from "@/lib/recurrence";

/** Shown wherever a date is genuinely absent (open-ended, never generated). */
export const NO_DATE = "—";

/** How many occurrences a preview list will render before it says "and more". */
export const PREVIEW_LIMIT = 24;

// ---------------------------------------------------------------------------
// Money / interval input
// ---------------------------------------------------------------------------

/**
 * Cents -> the decimal string an `<input type="number">` expects, which the
 * server action parses back with `parseAmount`.
 *
 * `centsToDecimal` is a DISPLAY/TRANSPORT boundary only — the float it returns is
 * never used for arithmetic here.
 */
export function centsToInputValue(cents: Cents): string {
  return centsToDecimal(cents).toString();
}

/**
 * The recurrence interval as the server will read it, or null when the value is
 * not a whole number of 1 or more. Deliberately strict: `Number("1.5")` is a
 * finite number the server would then reject, so catching it here keeps the
 * error next to the field.
 */
export function parseInterval(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const UNIT: Record<Frequency, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

/**
 * "every week" / "every 2 weeks" — lowercase so it composes inside a sentence.
 * The interval is dropped when it is 1 because "every 1 month" reads as a bug.
 */
export function frequencyLabel(frequency: Frequency, interval: number): string {
  const unit = UNIT[frequency];
  if (!unit) return String(frequency);
  if (!Number.isInteger(interval) || interval < 1) {
    return `every ${String(interval)} ${unit}s`;
  }
  return interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ordinal(day: number): string {
  const rem100 = day % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * A calendar day for display. Goes through `fromDateKey` (LOCAL midnight), so the
 * rendered day is always the day stored — `toISOString()` is never involved.
 */
export function formatDateKey(key: DateKey | null | undefined): string {
  if (key == null || key === "") return NO_DATE;
  try {
    return format(fromDateKey(key), "MMM d, yyyy");
  } catch {
    // A malformed key is worth showing verbatim rather than crashing the list.
    return String(key);
  }
}

/** A short list of days for inline report copy. */
export function formatDateKeyList(keys: DateKey[]): string {
  return keys.map((key) => formatDateKey(key)).join(", ");
}

/**
 * The month-end semantics of the ENGINE, stated in the user's words, for rules
 * whose anchor day does not exist in every month.
 *
 * The engine is anchored, not incremental: occurrence N is computed from
 * `startDate` by index and clamped to the last day of the target month only when
 * the anchor day is missing there. So Jan 31 -> Feb 28 -> Mar 31, and the rent day
 * never drifts. Returns null when there is nothing surprising to explain.
 */
export function monthEndNote(rule: RecurrenceRule): string | null {
  if (rule.frequency !== "monthly" && rule.frequency !== "yearly") return null;

  let day: number;
  let month0: number;
  try {
    const anchor = fromDateKey(rule.startDate);
    day = anchor.getDate();
    month0 = anchor.getMonth();
  } catch {
    return null;
  }

  if (rule.frequency === "yearly") {
    // Only Feb 29 is missing from some years.
    if (month0 !== 1 || day !== 29) return null;
    return "Anchored to February 29: non-leap years post on the last day of February (the 28th) instead, and the next leap year returns to the 29th.";
  }

  if (day < 29) return null;
  return `Anchored to the ${ordinal(day)}. A month with no ${ordinal(day)} posts on its last day instead (February posts on the 28th, or the 29th in a leap year): the anchor is not moved, so the next longer month returns to the ${ordinal(day)}.`;
}

// ---------------------------------------------------------------------------
// Form state -> FormData
// ---------------------------------------------------------------------------

export type RecurringFormState = {
  name: string;
  /** Account id as a string; "" means "no account". */
  accountId: string;
  /** Set to make every occurrence a transfer; "" means "not a transfer". */
  transferAccountId: string;
  /** Category id as a string; "" means "no category". Ignored for a transfer. */
  categoryId: string;
  /** Raw decimal string from the `<input type="number">`. "0" is a real amount. */
  amount: string;
  comment: string;
  frequency: Frequency;
  /** Raw string from the interval input. */
  interval: string;
  /** The anchor / first occurrence, as a local-midnight Date from the calendar. */
  startDate: Date;
  /** Inclusive last day an occurrence may fall on; null = open-ended. */
  endDate: Date | null;
  archived: boolean;
};

/**
 * The dialog's blocking validation. Deliberately a MIRROR of the server's rules
 * (see `app/actions/recurring.ts`) and nothing more: inventing extra client-only
 * rules would make legitimate templates impossible to save. Returns the first
 * problem, or null when the form is submittable.
 */
export function validateRecurringForm(state: RecurringFormState): string | null {
  if (state.name.trim() === "") {
    return "A recurring transaction needs a name.";
  }

  // A 0 amount is valid; only an EMPTY field is missing. `tryParseAmount("0")`
  // returns 0, so this must compare against null and never use truthiness.
  const amount = state.amount.trim();
  if (amount === "") {
    return "Enter an amount. 0 is allowed.";
  }
  if (tryParseAmount(amount) === null) {
    return `"${state.amount}" is not a valid amount.`;
  }

  if (parseInterval(state.interval) === null) {
    return "The interval must be a whole number of 1 or more.";
  }

  const startKey = toDateKey(state.startDate);
  if (state.endDate !== null) {
    const endKey = toDateKey(state.endDate);
    // Keys compare lexicographically in calendar order.
    if (endKey < startKey) {
      return "The end date cannot be before the start date.";
    }
  }

  if (state.transferAccountId !== "" && state.transferAccountId === state.accountId) {
    return "A transfer must move money between two different accounts.";
  }

  return null;
}

/**
 * A non-blocking hint: this template will post rows with no category, which is
 * legal but usually a mistake. Returns null when there is nothing to say.
 */
export function categoryHint(state: RecurringFormState): string | null {
  if (state.transferAccountId !== "") return null;
  if (state.categoryId !== "") return null;
  return "Without a category these occurrences will post as uncategorised transactions.";
}

/**
 * Exactly the keys the dialog appends to FormData, as plain strings.
 *
 * Every key is ALWAYS present, including empty ones: `updateRecurringTransaction`
 * decides what to change with `formData.has(key)`, so omitting `endDate` would
 * silently keep an old end date the user just cleared. An empty string is the
 * server's "null" (its `str()` helper maps "" to null).
 */
export function buildRecurringFormValues(state: RecurringFormState): Record<string, string> {
  const isTransfer = state.transferAccountId !== "";
  return {
    name: state.name.trim(),
    accountId: state.accountId,
    transferAccountId: state.transferAccountId,
    // The server rejects a transfer that also carries a category, so the
    // category is dropped here rather than surfaced as an avoidable error.
    categoryId: isTransfer ? "" : state.categoryId,
    amount: state.amount.trim(),
    comment: state.comment.trim(),
    frequency: state.frequency,
    interval: state.interval.trim(),
    // toDateKey, NOT toISOString: local midnight -> UTC shifts the calendar day.
    startDate: toDateKey(state.startDate),
    endDate: state.endDate === null ? "" : toDateKey(state.endDate),
    archived: state.archived ? "true" : "false",
  };
}

/** What the dialog actually submits. */
export function toRecurringFormData(state: RecurringFormState): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(buildRecurringFormValues(state))) {
    formData.append(key, value);
  }
  return formData;
}

/** The rule implied by the form, for the in-dialog preview. */
export function ruleFromFormState(state: RecurringFormState): RecurrenceRule | null {
  const interval = parseInterval(state.interval);
  if (interval === null) return null;
  try {
    return {
      frequency: state.frequency,
      interval,
      startDate: toDateKey(state.startDate),
      endDate: state.endDate === null ? null : toDateKey(state.endDate),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Occurrence preview
// ---------------------------------------------------------------------------

export type PreviewOptions = {
  /** Last day of the preview window, inclusive. */
  throughKey: DateKey;
  /** Skip everything up to and including this day (the `last_generated` cursor). */
  afterKey?: DateKey | null;
  limit?: number;
};

export type OccurrencePreview = {
  occurrences: DateKey[];
  /** True when `limit` cut the list short. */
  truncated: boolean;
  /** The first occurrence after `afterKey`, or null when the rule is spent. */
  nextDue: DateKey | null;
  /** True when the rule will never fire again (its end date has passed). */
  exhausted: boolean;
  /** The engine's complaint about an unusable rule, verbatim. */
  error: string | null;
};

/**
 * What a rule will post in `(afterKey, throughKey]`, straight from the engine.
 *
 * This is a PREVIEW: it writes nothing and de-duplicates nothing. Idempotency is
 * the server's job (a partial UNIQUE index on `(recurring_id,
 * recurring_occurrence)`), so the UI must never try to second-guess it.
 */
export function previewOccurrences(
  rule: RecurrenceRule,
  options: PreviewOptions,
): OccurrencePreview {
  const limit = options.limit ?? PREVIEW_LIMIT;
  const afterKey = options.afterKey ?? null;
  try {
    // limit + 1 so we can tell "exactly limit" from "more than limit".
    const walked = occurrencesThrough(rule, options.throughKey, { afterKey, limit: limit + 1 });
    const truncated = walked.length > limit;
    const nextDue = nextOccurrenceAfter(rule, afterKey);
    return {
      occurrences: truncated ? walked.slice(0, limit) : walked,
      truncated,
      nextDue,
      exhausted: nextDue === null,
      error: null,
    };
  } catch (cause) {
    return {
      occurrences: [],
      truncated: false,
      nextDue: null,
      exhausted: false,
      error: (cause as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Schedule status of a stored template
// ---------------------------------------------------------------------------

export type ScheduleTone = "paused" | "finished" | "due" | "scheduled";

export type ScheduleStatus = {
  tone: ScheduleTone;
  label: string;
  detail: string | null;
};

/**
 * How a stored template's schedule reads in the list.
 *
 * `nextDue === null` is the important case: the server sets it that way when the
 * rule has no occurrence left (typically an end date that lands before the next
 * one). Rendering that as an empty cell would look like missing data, so it gets
 * explicit "Finished" copy.
 */
export function scheduleStatus(
  template: {
    nextDue: DateKey | null;
    endDate: DateKey | null;
    archived: boolean;
    lastGenerated: DateKey | null;
  },
  today: DateKey,
): ScheduleStatus {
  if (template.archived) {
    return {
      tone: "paused",
      label: "Paused",
      detail:
        template.nextDue === null
          ? "resuming would not post anything: the rule has no occurrence left"
          : `would next post ${formatDateKey(template.nextDue)} if resumed`,
    };
  }

  if (template.nextDue === null) {
    return {
      tone: "finished",
      label: "Finished",
      detail:
        template.endDate === null
          ? "the rule has no further occurrences"
          : `no occurrence falls on or before the end date (${formatDateKey(template.endDate)})`,
    };
  }

  if (template.nextDue < today) {
    return {
      tone: "due",
      label: `Overdue since ${formatDateKey(template.nextDue)}`,
      detail: "posts on its own calendar day when you post due transactions",
    };
  }

  if (template.nextDue === today) {
    return { tone: "due", label: "Due today", detail: null };
  }

  return { tone: "scheduled", label: `Next ${formatDateKey(template.nextDue)}`, detail: null };
}

// ---------------------------------------------------------------------------
// Upcoming window
// ---------------------------------------------------------------------------

/**
 * `from` plus `days` calendar days, as a DateKey. Built from LOCAL components, so
 * it neither shifts a day nor breaks across a DST boundary.
 */
export function upcomingThroughKey(from: DateKey, days: number): DateKey {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`Invalid window: expected an integer >= 0 of days, received ${String(days)}`);
  }
  const start = fromDateKey(from);
  return toDateKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + days));
}

/** One row of `getUpcomingRecurring`, structurally. */
export type UpcomingItemLike = {
  id: number;
  name: string;
  amountCents: Cents;
  nextDue: DateKey | null;
  due: DateKey[];
  error?: string;
};

export type UpcomingDay = {
  key: DateKey;
  entries: Array<{ id: number; name: string; amountCents: Cents }>;
  totalCents: Cents;
};

/**
 * Occurrences regrouped by the calendar day they will post on, in calendar order
 * (DateKeys sort lexicographically). Within a day, templates keep their list
 * order so the preview is stable between renders.
 */
export function groupUpcomingByDate(items: UpcomingItemLike[]): UpcomingDay[] {
  const byKey = new Map<DateKey, UpcomingDay["entries"]>();
  for (const item of items) {
    for (const key of item.due) {
      const entries = byKey.get(key);
      const entry = { id: item.id, name: item.name, amountCents: item.amountCents };
      if (entries) entries.push(entry);
      else byKey.set(key, [entry]);
    }
  }
  return [...byKey.keys()]
    .sort()
    .map((key) => {
      const entries = byKey.get(key)!;
      return { key, entries, totalCents: sumCents(entries.map((e) => e.amountCents)) };
    });
}

export type UpcomingTotals = {
  /** Occurrences in the window across all templates. */
  occurrences: number;
  /** Occurrences on or before `today` — what a post right now would materialise. */
  dueNow: number;
  /** Occurrences after `today`. */
  later: number;
  totalCents: Cents;
  /** Templates the engine refused, as "Name: reason". Never swallowed. */
  errors: string[];
};

export function upcomingTotals(items: UpcomingItemLike[], today: DateKey): UpcomingTotals {
  let occurrences = 0;
  let dueNow = 0;
  let later = 0;
  const amounts: Cents[] = [];
  const errors: string[] = [];

  for (const item of items) {
    if (item.error !== undefined && item.error !== "") {
      errors.push(`${item.name}: ${item.error}`);
    }
    for (const key of item.due) {
      occurrences++;
      if (key <= today) dueNow++;
      else later++;
      amounts.push(item.amountCents);
    }
  }

  return { occurrences, dueNow, later, totalCents: sumCents(amounts), errors };
}

// ---------------------------------------------------------------------------
// Generation report
// ---------------------------------------------------------------------------

/**
 * `GenerationReport` from `app/actions/recurring.ts`, restated structurally so
 * this module stays importable from a plain node test (the action module is
 * `"use server"` and drags in the database client).
 */
export type GenerationReportLike = {
  throughKey: DateKey;
  posted: number;
  skipped: number;
  templates: Array<{
    id: number;
    name: string;
    posted: DateKey[];
    skipped: DateKey[];
    lastGenerated: DateKey | null;
    nextDue: DateKey | null;
    error?: string;
  }>;
};

export type GenerationSummary = {
  throughKey: DateKey;
  posted: number;
  skipped: number;
  headline: string;
  lines: Array<{
    id: number;
    name: string;
    text: string;
    tone: "posted" | "skipped" | "error" | "idle";
    nextDue: DateKey | null;
  }>;
  errors: string[];
};

/**
 * Turns the generator's report into copy that cannot mislead.
 *
 * BOTH counts are always exposed. A run that posted nothing because everything
 * was already on the ledger reads differently from a run that posted nothing
 * because nothing was due — showing a bare "Done" for either would hide exactly
 * the outcome a user needs to notice in a finance app.
 */
export function summarizeGenerationReport(report: GenerationReportLike): GenerationSummary {
  const through = formatDateKey(report.throughKey);

  let headline: string;
  if (report.posted === 0 && report.skipped === 0) {
    headline = `Nothing was due through ${through}. No transactions were posted.`;
  } else if (report.posted === 0) {
    headline = `Nothing new: all ${count(report.skipped, "due occurrence")} through ${through} were already on the ledger.`;
  } else if (report.skipped === 0) {
    headline = `Posted ${count(report.posted, "transaction")} through ${through}.`;
  } else {
    headline = `Posted ${count(report.posted, "transaction")} through ${through}; skipped ${report.skipped} already on the ledger.`;
  }

  const errors: string[] = [];
  const lines = report.templates.map((template) => {
    if (template.error !== undefined && template.error !== "") {
      errors.push(`${template.name}: ${template.error}`);
      return {
        id: template.id,
        name: template.name,
        text: `Skipped entirely, ${template.error}`,
        tone: "error" as const,
        nextDue: template.nextDue,
      };
    }

    const postedCount = template.posted.length;
    const skippedCount = template.skipped.length;

    if (postedCount > 0 && skippedCount > 0) {
      return {
        id: template.id,
        name: template.name,
        text: `Posted ${formatDateKeyList(template.posted)}; ${skippedCount} already on the ledger (${formatDateKeyList(template.skipped)})`,
        tone: "posted" as const,
        nextDue: template.nextDue,
      };
    }
    if (postedCount > 0) {
      return {
        id: template.id,
        name: template.name,
        text: `Posted ${formatDateKeyList(template.posted)}`,
        tone: "posted" as const,
        nextDue: template.nextDue,
      };
    }
    if (skippedCount > 0) {
      return {
        id: template.id,
        name: template.name,
        text: `Already on the ledger: ${formatDateKeyList(template.skipped)}`,
        tone: "skipped" as const,
        nextDue: template.nextDue,
      };
    }
    return {
      id: template.id,
      name: template.name,
      text: "Nothing due",
      tone: "idle" as const,
      nextDue: template.nextDue,
    };
  });

  return {
    throughKey: report.throughKey,
    posted: report.posted,
    skipped: report.skipped,
    headline,
    lines,
    errors,
  };
}
