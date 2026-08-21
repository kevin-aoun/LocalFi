

export type DateKey = string;

export type MonthKey = string;

const MAX_EXCEL_SERIAL = 2958465;

const MIN_SERIAL_FROM_STRING = 20000;

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

const ISO_LIKE_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/;

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
    return null;
  }
  return d;
}


export function toDateKey(d: Date): DateKey {
  assertValidDate(d);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}


export function fromDateKey(key: DateKey): Date {
  if (typeof key !== "string" || !DATE_KEY_RE.test(key)) {
    throw new Error(`Invalid date key: expected 'YYYY-MM-DD', received ${JSON.stringify(key)}`);
  }
  const d = makeLocalDate(Number(key.slice(0, 4)), Number(key.slice(5, 7)), Number(key.slice(8, 10)));
  if (!d) throw new Error(`Invalid date key: ${key} is not a real calendar day`);
  return d;
}


export function isDateKey(value: unknown): value is DateKey {
  if (typeof value !== "string" || !DATE_KEY_RE.test(value)) return false;
  return (
    makeLocalDate(Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10))) !==
    null
  );
}


export function todayKey(): DateKey {
  const configured =
    typeof process === "undefined" ? undefined : process.env.LOCALFI_TODAY_KEY?.trim();
  if (configured) {
    if (!isDateKey(configured)) {
      throw new Error(
        `Invalid LOCALFI_TODAY_KEY: expected a real 'YYYY-MM-DD' calendar day, received ${JSON.stringify(configured)}`,
      );
    }
    return configured;
  }
  return toDateKey(new Date());
}


export function parseExcelSerial(serial: number): Date {
  if (typeof serial !== "number" || !Number.isFinite(serial)) {
    throw new Error(`Invalid Excel serial: ${String(serial)}`);
  }
  const days = Math.floor(serial);
  if (days < 0 || days > MAX_EXCEL_SERIAL) {
    throw new Error(`Invalid Excel serial: ${serial} is out of range (0..${MAX_EXCEL_SERIAL})`);
  }
  if (days === 60) return new Date(1900, 1, 28);

  const epochUtc = days <= 59 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const utc = new Date(epochUtc + days * 86400000);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}


function expandTwoDigitYear(year: number): number {
  return year <= 68 ? 2000 + year : 1900 + year;
}


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
    if (first > 12 && second > 12) return null;
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


export function monthKey(d: Date): MonthKey {
  assertValidDate(d);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}


export function fromMonthKey(key: MonthKey): Date {
  if (typeof key !== "string" || !MONTH_KEY_RE.test(key)) {
    throw new Error(`Invalid month key: expected 'YYYY-MM', received ${JSON.stringify(key)}`);
  }
  const d = makeLocalDate(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 1);
  if (!d) throw new Error(`Invalid month key: ${key}`);
  return d;
}


export function startOfMonth(d: Date): Date {
  assertValidDate(d);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}


export function endOfMonth(d: Date): Date {
  assertValidDate(d);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}


export function startOfDay(d: Date): Date {
  assertValidDate(d);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
