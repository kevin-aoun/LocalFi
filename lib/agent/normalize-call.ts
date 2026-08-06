/**
 * Normalize a tool call that came from the MODEL before it is validated.
 *
 * ## Why this exists — measured, not theoretical
 *
 * Probing Needle with this repo's real tool payload produced these arguments:
 *
 *   "10 groceries"                         -> { date: "2023-10-27" }   HALLUCINATED
 *   "spent 43.50 at the pharmacy yesterday"-> { date: "yesterday" }    not a date
 *   "what did I log today"                 -> { limit: "today" }       wrong type
 *   "moved 500 to savings"                 -> { from: "savings", to: "savings" }
 *
 * zod rejects three of those four. It **cannot** reject the first: a 26M model has
 * no clock, so it emits a structurally valid date from its training distribution.
 * `2023-10-27` parses fine and would file today's groceries in October 2023, where
 * the user would probably never find it.
 *
 * So the rule this module enforces:
 *
 *   **A model-supplied date is only trusted when the user's message actually
 *   contains date evidence. Otherwise it is discarded in favour of today.**
 *
 * And relative words ("yesterday", "last friday") are resolved HERE, from the
 * message, against a caller-supplied `today` — never by the model, which cannot
 * know what day it is.
 *
 * This module is pure and takes `today` as an argument so it is testable and
 * timezone-safe.
 */
import { fromDateKey, isDateKey, toDateKey, type DateKey } from "@/lib/dates";
import type { ToolCall } from "./tool-schema";

export type NormalizeResult = {
  call: ToolCall;
  /** Human-readable notes about what was corrected, for the reply and for logs. */
  notes: string[];
};

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/**
 * Does the user's message contain anything that could be a date?
 *
 * Deliberately broad — a false positive merely means we try to parse the message
 * and fall back to today, whereas a false negative would discard a date the user
 * really did give.
 */
export function hasDateEvidence(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\d{4}-\d{1,2}-\d{1,2}/.test(m) ||
    // Slash/dash forms: 04/07, 4-7-2026. A DOT separator is only accepted with
    // three components (1.2.2026), because `43.50` is an AMOUNT — allowing
    // `\d{1,2}[.]\d{1,2}` made every decimal price look like a day/month pair,
    // which turned "spent 43.50 at the pharmacy" into "the user gave a date".
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(m) ||
    /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(m) ||
    /\b(today|yesterday|tonight|this morning|last night)\b/.test(m) ||
    /\b(last|this|next)\s+(week|month|year|mon|tue|wed|thu|fri|sat|sun)/.test(m) ||
    new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`).test(m) ||
    /\b\d+\s+days?\s+ago\b/.test(m) ||
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(m)
  );
}

function shiftDays(from: DateKey, delta: number): DateKey {
  const d = fromDateKey(from);
  // Local-component arithmetic; never UTC, never toISOString().
  return toDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta));
}

/**
 * Resolve a relative date phrase against `today`.
 *
 * Returns null when the phrase is not one we recognize, which the caller treats
 * as "no usable date" rather than as an error.
 */
export function resolveRelativeDate(phrase: string, today: DateKey): DateKey | null {
  const p = phrase.toLowerCase().trim();

  // Order matters: "day before yesterday" CONTAINS "yesterday", so the more
  // specific phrase has to be tested first or it resolves a day late.
  if (/\bday before yesterday\b/.test(p)) return shiftDays(today, -2);
  if (/\b(today|tonight|this morning)\b/.test(p)) return today;
  if (/\b(yesterday|last night)\b/.test(p)) return shiftDays(today, -1);

  const ago = p.match(/\b(\d+)\s+days?\s+ago\b/);
  if (ago) {
    const n = Number(ago[1]);
    if (Number.isInteger(n) && n >= 0 && n <= 3650) return shiftDays(today, -n);
  }

  // "last friday" / "friday" -> the most recent occurrence at or before today.
  const weekday = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(p));
  if (weekday >= 0) {
    const todayIdx = fromDateKey(today).getDay();
    let back = (todayIdx - weekday + 7) % 7;
    // "last friday" said ON a Friday means the previous one, not today.
    if (back === 0 && /\blast\b/.test(p)) back = 7;
    return shiftDays(today, -back);
  }

  return null;
}

/**
 * How far from today a model-supplied date may sit before we treat it as
 * hallucinated even though the message did contain date evidence.
 *
 * A year back covers legitimate backfill; anything further, or anything in the
 * future, is far more likely to be a training-distribution artifact than intent.
 */
const MAX_BACKDATE_DAYS = 366;

function withinPlausibleRange(candidate: DateKey, today: DateKey): boolean {
  const days =
    (fromDateKey(today).getTime() - fromDateKey(candidate).getTime()) / 86_400_000;
  return days >= 0 && days <= MAX_BACKDATE_DAYS;
}

/**
 * Normalize a model-produced call in place of blind trust.
 *
 * `date` handling, in order:
 *  1. no `date` argument            -> leave it out; the schema defaults to today
 *  2. message has NO date evidence  -> DROP the model's date (hallucination)
 *  3. message has evidence          -> resolve from the MESSAGE (relative words
 *                                      first, then an explicit key in the message)
 *  4. model's date survives only if it is already a DateKey AND plausible
 */
export function normalizeModelCall(
  call: ToolCall,
  message: string,
  today: DateKey,
): NormalizeResult {
  const notes: string[] = [];
  const args: Record<string, unknown> = { ...call.arguments };

  // ── The OMITTED-date case ────────────────────────────────────────────────
  //
  // The finetuned model is trained never to emit a `date`, which removed the
  // hallucination problem entirely — but it also means "43.50 on food yesterday"
  // arrives as {amount, category} with no date at all. The schema then defaults
  // to today, so the row files on the wrong day with NOTHING said to the user.
  //
  // That is the same silent mis-filing this module exists to prevent, just from
  // the other direction. So when the model omitted a date and the MESSAGE
  // contains one we can resolve, inject it.
  if (!("date" in args) && hasDateEvidence(message)) {
    const fromMessage = resolveRelativeDate(message, today);
    if (fromMessage !== null && fromMessage !== today) {
      args.date = fromMessage;
      notes.push(`Dated ${fromMessage} from your message, not today.`);
    }
  }

  if ("date" in args) {
    const evidence = hasDateEvidence(message);

    if (!evidence) {
      // The model invented a date out of nothing. This is the case zod cannot see.
      delete args.date;
      notes.push("Ignored a date the model invented (your message didn't mention one), using today.");
    } else {
      const fromMessage = resolveRelativeDate(message, today);
      const modelValue = typeof args.date === "string" ? args.date.trim() : "";

      if (fromMessage !== null) {
        if (modelValue !== fromMessage) {
          notes.push(`Read the date from your message as ${fromMessage}.`);
        }
        args.date = fromMessage;
      } else if (isDateKey(modelValue) && withinPlausibleRange(modelValue, today)) {
        // An explicit YYYY-MM-DD the message plausibly contained.
        args.date = modelValue;
      } else if (isDateKey(modelValue)) {
        delete args.date;
        notes.push(
          `Ignored the date ${modelValue}; it is in the future or over a year old, which is almost always a mistake. Used today instead.`,
        );
      } else {
        // e.g. the literal word "yesterday" that we could not resolve.
        delete args.date;
        notes.push(`Could not read "${modelValue}" as a date: used today.`);
      }
    }
  }

  return { call: { name: call.name, arguments: args }, notes };
}
