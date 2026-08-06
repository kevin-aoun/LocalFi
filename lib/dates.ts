/**
 * Timezone-safe date primitives.
 *
 * WHY: dates in this app are CALENDAR DAYS ("the 28th"), not instants. Using
 * `Date.prototype.toISOString()` to serialize them converts to UTC first, which
 * shifts the day for every user who is not on UTC:
 *
 *   - transaction-dialog.tsx did `date.toISOString().split("T")[0]` on a Date at
 *     LOCAL midnight. East of UTC that yields the PREVIOUS calendar day (a user
 *     in Beirut/UTC+3 picking the 28th stored the 27th), and month-boundary
 *     spend landed in the wrong budget month.
 *   - import-dialog.tsx built the Excel epoch in local time and then called
 *     toISOString() (off-by-one east of UTC), and because SheetJS ran with
 *     `raw: false` most dates arrived as strings and went through the ambiguous
 *     `new Date(string)`, so DD/MM/YYYY was silently read as MM/DD/YYYY.
 *
 * Rules of the road:
 *   - Persist/compare calendar days as 'YYYY-MM-DD' strings from `toDateKey`.
 *   - NEVER call `toISOString()` (or `new Date(someString)`) on a calendar day.
 *   - Build Dates from LOCAL components only (`new Date(y, m, d)`).
 *   - Parse imported values with `parseFlexibleDate` / `parseExcelSerial`.
 */

/** 'YYYY-MM-DD' — the canonical wire/storage form for a calendar day. */
export type DateKey = string;
/** 'YYYY-MM' — the canonical form for a budget month. */
export type MonthKey = string;

/** Excel serial for 9999-12-31; anything beyond is not a real date. */
const MAX_EXCEL_SERIAL = 2958465;
/**
 * Numeric STRINGS are only treated as Excel serials inside a sane modern window
 * (1954-10-03 .. 9999-12-31). Without this, "2026" would silently become
 * 1905-07-14 — exactly the "wrong but plausible" outcome we must never produce.
 */
const MIN_SERIAL_FROM_STRING = 20000;

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
/** 'YYYY-MM-DD', 'YYYY/M/D', 'YYYY.MM.DD', optionally followed by a time part. */
const ISO_LIKE_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/;
/** 'DD/MM/YYYY' or 'MM-DD-YY' style, with / - or . separators. */
const TWO_PART_RE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/;
const NUMERIC_RE = /^\d+(?:\.\d+)?$/;

function assertValidDate(d: unknown, label = "date"): asserts d is Date {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new Error(
      `${label} must be a valid Date, received ${d instanceof Date ? "Invalid Date" : typeof d}`,
    );
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Builds a local-midnight Date, or returns null if the components are not a real
 * calendar day (2026-02-30, month 13, day 0, ...). Rejects any value the Date
 * constructor would silently roll over.
 */
function makeLocalDate(year: number, month1: number, day: number): Date | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month1) ||
    !Number.isInteger(day) ||
    year < 1 ||
    month1 < 1 ||
    month1 > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const d = new Date(year, month1 - 1, day);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month1 - 1 ||
    d.getDate() !== day
  ) {
    return null; // rolled over (e.g. Feb 30) or two-digit-year remapping
  }
  return d;
}

/**
 * Date -> 'YYYY-MM-DD' using LOCAL year/month/day.
 * Never uses toISOString(); the returned day is the day the user sees.
 */
export function toDateKey(d: Date): DateKey {
  assertValidDate(d);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 'YYYY-MM-DD' -> Date at LOCAL midnight. Round-trips with `toDateKey` in every
 * timezone. Throws on a malformed or impossible key (use `isDateKey` to check).
 */
export function fromDateKey(key: DateKey): Date {
  if (typeof key !== "string" || !DATE_KEY_RE.test(key)) {
    throw new Error(`Invalid date key: expected 'YYYY-MM-DD', received ${JSON.stringify(key)}`);
  }
  const d = makeLocalDate(Number(key.slice(0, 4)), Number(key.slice(5, 7)), Number(key.slice(8, 10)));
  if (!d) throw new Error(`Invalid date key: ${key} is not a real calendar day`);
  return d;
}

/** True when `value` is a well-formed 'YYYY-MM-DD' key for a real calendar day. */
export function isDateKey(value: unknown): value is DateKey {
  if (typeof value !== "string" || !DATE_KEY_RE.test(value)) return false;
  return (
    makeLocalDate(Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10))) !==
    null
  );
}

/** Today's local calendar day as 'YYYY-MM-DD'. */
export function todayKey(): DateKey {
  return toDateKey(new Date());
}

/**
 * Excel/SheetJS serial number -> Date at LOCAL midnight.
 *
 * Handles Excel's 1900 leap-year bug: Excel believes 1900-02-29 exists, so
 * serials <= 59 are offset from 1899-12-31 and serials >= 61 from 1899-12-30.
 * Serial 60 is that phantom day and is clamped to 1900-02-28.
 * Fractional serials (time of day) are truncated to the day.
 *
 * All arithmetic is done in UTC and only the resulting y/m/d are used to build a
 * LOCAL date, so DST transitions cannot shift the day.
 * Throws on non-numeric, negative or out-of-range serials.
 */
export function parseExcelSerial(serial: number): Date {
  if (typeof serial !== "number" || !Number.isFinite(serial)) {
    throw new Error(`Invalid Excel serial: ${String(serial)}`);
  }
  const days = Math.floor(serial);
  if (days < 0 || days > MAX_EXCEL_SERIAL) {
    throw new Error(`Invalid Excel serial: ${serial} is out of range (0..${MAX_EXCEL_SERIAL})`);
  }
  if (days === 60) return new Date(1900, 1, 28); // phantom 1900-02-29

  const epochUtc = days <= 59 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const utc = new Date(epochUtc + days * 86400000);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

/** Two-digit years: 00-68 -> 2000s, 69-99 -> 1900s (POSIX convention). */
function expandTwoDigitYear(year: number): number {
  return year <= 68 ? 2000 + year : 1900 + year;
}

/**
 * Explicit, non-guessing date parser for imported values. NEVER uses
 * `new Date(string)`, whose behaviour for 'DD/MM/YYYY' is implementation
 * defined (V8 reads it as MM/DD and happily returns a wrong-but-plausible day).
 *
 * Supported:
 *   - 'YYYY-MM-DD', 'YYYY/MM/DD', 'YYYY.MM.DD' (+ optional ' HH:mm' / 'T...'
 *     suffix, which is ignored — the literal date part wins, no UTC shifting)
 *   - 'D/M/YYYY' vs 'M/D/YYYY' (also - and . separators, 2- or 4-digit year),
 *     disambiguated by `opts.dayFirst` (default false = US MM/DD). When one
 *     component cannot be a month (e.g. 25/12/2026) the correct order is
 *     inferred regardless of the flag.
 *   - Excel serial numbers (number, or numeric string >= 20000)
 *   - Date instances (normalized to local midnight, input not mutated)
 *
 * Returns null for anything else — never an Invalid Date, never a guess.
 * Month names ('28 Jul 2026') are deliberately unsupported: locale guessing is
 * how wrong dates get imported.
 */
export function parseFlexibleDate(
  input: string | number | Date,
  opts?: { dayFirst?: boolean },
): Date | null {
  const dayFirst = opts?.dayFirst === true;

  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : startOfDay(input);
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0 || input > MAX_EXCEL_SERIAL) return null;
    return parseExcelSerial(input);
  }

  if (typeof input !== "string") return null;
  const s = input.trim();
  if (s === "") return null;

  const iso = ISO_LIKE_RE.exec(s);
  if (iso) return makeLocalDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const parts = TWO_PART_RE.exec(s);
  if (parts) {
    const first = Number(parts[1]);
    const second = Number(parts[2]);
    const year = parts[3].length === 2 ? expandTwoDigitYear(Number(parts[3])) : Number(parts[3]);

    let day: number;
    let month: number;
    if (first > 12 && second > 12) return null; // neither can be a month
    if (first > 12) {
      day = first;
      month = second;
    } else if (second > 12) {
      month = first;
      day = second;
    } else if (dayFirst) {
      day = first;
      month = second;
    } else {
      month = first;
      day = second;
    }
    return makeLocalDate(year, month, day);
  }

  if (NUMERIC_RE.test(s)) {
    const n = Number(s);
    if (n < MIN_SERIAL_FROM_STRING || n > MAX_EXCEL_SERIAL) return null;
    return parseExcelSerial(n);
  }

  return null;
}

/** Date -> 'YYYY-MM' using LOCAL components (the budget month the user sees). */
export function monthKey(d: Date): MonthKey {
  assertValidDate(d);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 'YYYY-MM' -> first day of that month at LOCAL midnight. Throws if malformed. */
export function fromMonthKey(key: MonthKey): Date {
  if (typeof key !== "string" || !MONTH_KEY_RE.test(key)) {
    throw new Error(`Invalid month key: expected 'YYYY-MM', received ${JSON.stringify(key)}`);
  }
  const d = makeLocalDate(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 1);
  if (!d) throw new Error(`Invalid month key: ${key}`);
  return d;
}

/** First day of `d`'s LOCAL month, at local midnight. */
export function startOfMonth(d: Date): Date {
  assertValidDate(d);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/**
 * Last day of `d`'s LOCAL month, at 23:59:59.999 local (matches date-fns, so it
 * works as an inclusive upper bound for instant comparisons). For a storage key
 * use `toDateKey(endOfMonth(d))`.
 */
export function endOfMonth(d: Date): Date {
  assertValidDate(d);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

/** `d` at LOCAL midnight (a copy; the input is never mutated). */
export function startOfDay(d: Date): Date {
  assertValidDate(d);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
