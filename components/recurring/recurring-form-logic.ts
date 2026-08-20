
import { format } from "date-fns";

import { fromDateKey, toDateKey, type DateKey } from "@/lib/dates";
import { centsToDecimal, sumCents, tryParseAmount, type Cents } from "@/lib/money";
import {
  nextOccurrenceAfter,
  occurrencesThrough,
  type Frequency,
  type RecurrenceRule,
} from "@/lib/recurrence";

export const NO_DATE = "—";

export const PREVIEW_LIMIT = 24;

export function centsToInputValue(cents: Cents): string {
  return centsToDecimal(cents).toString();
}

export function parseInterval(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) return null;
  return value;
}

const UNIT: Record<Frequency, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

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


export function formatDateKey(key: DateKey | null | undefined): string {
  if (key == null || key === "") return NO_DATE;
  try {
    return format(fromDateKey(key), "MMM d, yyyy");
  } catch {

    return String(key);
  }
}


export function formatDateKeyList(keys: DateKey[]): string {
  return keys.map((key) => formatDateKey(key)).join(", ");
}


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

    if (month0 !== 1 || day !== 29) return null;
    return "Anchored to February 29: non-leap years post on the last day of February (the 28th) instead, and the next leap year returns to the 29th.";
  }

  if (day < 29) return null;
  return `Anchored to the ${ordinal(day)}. A month with no ${ordinal(day)} posts on its last day instead (February posts on the 28th, or the 29th in a leap year): the anchor is not moved, so the next longer month returns to the ${ordinal(day)}.`;
}





export type RecurringFormState = {
  name: string;

  accountId: string;

  transferAccountId: string;

  categoryId: string;

  amount: string;
  comment: string;
  frequency: Frequency;

  interval: string;

  startDate: Date;

  endDate: Date | null;
  archived: boolean;
};


export function validateRecurringForm(state: RecurringFormState): string | null {
  if (state.name.trim() === "") {
    return "A recurring transaction needs a name.";
  }



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

    if (endKey < startKey) {
      return "The end date cannot be before the start date.";
    }
  }

  if (state.transferAccountId !== "" && state.transferAccountId === state.accountId) {
    return "A transfer must move money between two different accounts.";
  }

  return null;
}


export function categoryHint(state: RecurringFormState): string | null {
  if (state.transferAccountId !== "") return null;
  if (state.categoryId !== "") return null;
  return "Without a category these occurrences will post as uncategorised transactions.";
}


export function buildRecurringFormValues(state: RecurringFormState): Record<string, string> {
  const isTransfer = state.transferAccountId !== "";
  return {
    name: state.name.trim(),
    accountId: state.accountId,
    transferAccountId: state.transferAccountId,


    categoryId: isTransfer ? "" : state.categoryId,
    amount: state.amount.trim(),
    comment: state.comment.trim(),
    frequency: state.frequency,
    interval: state.interval.trim(),

    startDate: toDateKey(state.startDate),
    endDate: state.endDate === null ? "" : toDateKey(state.endDate),
    archived: state.archived ? "true" : "false",
  };
}


export function toRecurringFormData(state: RecurringFormState): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(buildRecurringFormValues(state))) {
    formData.append(key, value);
  }
  return formData;
}


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





export type PreviewOptions = {

  throughKey: DateKey;

  afterKey?: DateKey | null;
  limit?: number;
};

export type OccurrencePreview = {
  occurrences: DateKey[];

  truncated: boolean;

  nextDue: DateKey | null;

  exhausted: boolean;

  error: string | null;
};


export function previewOccurrences(
  rule: RecurrenceRule,
  options: PreviewOptions,
): OccurrencePreview {
  const limit = options.limit ?? PREVIEW_LIMIT;
  const afterKey = options.afterKey ?? null;
  try {

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





export type ScheduleTone = "paused" | "finished" | "due" | "scheduled";

export type ScheduleStatus = {
  tone: ScheduleTone;
  label: string;
  detail: string | null;
};


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






export function upcomingThroughKey(from: DateKey, days: number): DateKey {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`Invalid window: expected an integer >= 0 of days, received ${String(days)}`);
  }
  const start = fromDateKey(from);
  return toDateKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + days));
}


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

  occurrences: number;

  dueNow: number;

  later: number;
  totalCents: Cents;

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
