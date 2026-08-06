/**
 * Money primitives — integer minor units ("cents").
 *
 * WHY: this app used to store money as SQLite `real` (float64) and do float
 * arithmetic on it, which drifts at the cent level (0.1 + 0.2 !== 0.3,
 * 2.675 * 100 === 267.49999999999994). Every amount in this codebase is now an
 * INTEGER number of cents, and every conversion goes through this module.
 *
 * Rules of the road:
 *   - Storage, arithmetic, comparison, aggregation: always `Cents` (integers).
 *   - Parsing user/import input: `parseAmount` (throws) or `tryParseAmount` (null).
 *   - Display: `formatMoney`.
 *   - Floats: only at a display/charting boundary, via `centsToDecimal`.
 *
 * Every exported function rejects non-integer input by throwing, so a float that
 * leaks in fails loudly instead of silently drifting.
 *
 * Assumption: 2 minor digits for all currencies (the app has no zero-decimal
 * currency support; JPY-style currencies would need a separate exponent table).
 */

/** An integer number of minor currency units (cents). Never a float. */
export type Cents = number;

/** Currencies we render with a symbol; everything else falls back to "CODE 1,234.56". */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/** Symbols that may appear in input and should be ignored while parsing. */
const STRIPPABLE_SYMBOLS = /[$€£¥₹₪]/g;

/** "1,234.56" or "1234.56" / ".56" / "1234." — grouping is validated, not just removed. */
const GROUPED_NUMBER = /^\d{1,3}(?:,\d{3})*(?:\.\d*)?$/;
const PLAIN_NUMBER = /^\d*(?:\.\d*)?$/;

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}

/**
 * Throws unless `value` is a safe integer number of cents.
 * Use at the top of anything that accepts cents.
 */
export function assertCents(value: unknown, label = "amount"): asserts value is Cents {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `${label} must be an integer number of cents, received ${describeValue(value)}`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} is too large to represent exactly in cents: ${value}`);
  }
}

/** True when `value` is a safe integer number of cents. */
export function isCents(value: unknown): value is Cents {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Renders a JS number as a plain decimal string, expanding exponent notation.
 * This is the only safe bridge from float input to string-based parsing: it uses
 * the shortest round-trip representation of the double, never float arithmetic.
 */
function numberToPlainString(value: number): string {
  const s = String(value);
  if (!/e/i.test(s)) return s;

  const m = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) throw new Error(`Invalid amount: cannot interpret the number ${s}`);
  const [, sign, intDigits, fracDigits = "", expDigits] = m;
  const exponent = Number(expDigits);
  const digits = intDigits + fracDigits;
  const pointIndex = intDigits.length + exponent;

  let body: string;
  if (pointIndex <= 0) {
    body = `0.${"0".repeat(-pointIndex)}${digits}`;
  } else if (pointIndex >= digits.length) {
    body = digits + "0".repeat(pointIndex - digits.length);
  } else {
    body = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  }
  return sign + body;
}

/**
 * Parses a money string/number into integer cents.
 *
 * Accepts: "45", "45.5", "45.50", "1,234.56", " 45.00 " (incl. non-breaking
 * spaces), "-45.00", "+45.00", "(45.00)" (accounting negative), "$45.00",
 * "-$45.50", "45.00 USD", "USD 45.00", "45.", ".5".
 *
 * Rounds HALF AWAY FROM ZERO at the cent ("0.005" -> 1, "-0.005" -> -1).
 * Integer and fractional parts are parsed as STRINGS, so float drift is
 * structurally impossible ("2.675" -> 268, not 267).
 *
 * Throws a clear Error on empty / null / undefined / non-numeric input and on
 * values too large to represent exactly. Callers are expected to validate first
 * (or use `tryParseAmount`).
 */
export function parseAmount(input: string | number): Cents {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new Error(`Invalid amount: ${String(input)} is not a finite number`);
    }
    return parseAmountString(numberToPlainString(input));
  }
  if (typeof input !== "string") {
    throw new Error(
      `Invalid amount: expected a string or number, received ${describeValue(input)}`,
    );
  }
  return parseAmountString(input);
}

function parseAmountString(raw: string): Cents {
  let s = raw.trim();
  if (s === "") throw new Error("Invalid amount: value is empty");

  // Accounting negatives: "(45.00)" -> -4500. Parentheses negate their contents,
  // so "(-45.00)" is +4500. Unbalanced parens fall through and throw below.
  let negative = false;
  while (s.length >= 2 && s.startsWith("(") && s.endsWith(")")) {
    negative = !negative;
    s = s.slice(1, -1).trim();
  }

  // Currency decoration: symbols anywhere, ISO-ish codes at either end.
  s = s.replace(STRIPPABLE_SYMBOLS, "").trim();

  // The sign may sit on either side of a currency code ("-LBP 0.01", "USD -45"),
  // but exactly ONE sign is allowed ("--5" must still fail).
  let signConsumed = false;
  const consumeSign = () => {
    if (signConsumed) return;
    if (s.startsWith("-") || s.startsWith("+")) {
      if (s.startsWith("-")) negative = !negative;
      s = s.slice(1).trim();
      signConsumed = true;
    }
  };

  consumeSign();
  s = s.replace(/^[A-Za-z]{3}\s*/, "").replace(/\s*[A-Za-z]{3}$/, "").trim();
  consumeSign();
  if (s === "") throw new Error(`Invalid amount: no numeric value in ${JSON.stringify(raw)}`);

  if (!GROUPED_NUMBER.test(s) && !PLAIN_NUMBER.test(s)) {
    throw new Error(`Invalid amount: ${JSON.stringify(raw)} is not a number`);
  }
  const digitsOnly = s.replace(/,/g, "");
  if (!/\d/.test(digitsOnly)) {
    throw new Error(`Invalid amount: ${JSON.stringify(raw)} contains no digits`);
  }

  const [intPart, fracPart = ""] = digitsOnly.split(".");
  const wholeDigits = intPart === "" ? "0" : intPart;
  // Third digit decides the rounding; anything beyond it cannot change the cent
  // under half-away-from-zero (".4999" rounds down, ".5" rounds up).
  const frac3 = `${fracPart}000`.slice(0, 3);

  const whole = Number(wholeDigits);
  let cents = whole * 100 + Number(frac3.slice(0, 2));
  if (frac3.charCodeAt(2) >= 53 /* '5' */) cents += 1;

  if (!Number.isSafeInteger(cents)) {
    throw new Error(
      `Invalid amount: ${JSON.stringify(raw)} is too large to represent exactly in cents`,
    );
  }
  if (cents === 0) return 0; // never -0
  return negative ? -cents : cents;
}

/** Non-throwing `parseAmount`: returns integer cents, or null if unparseable. */
export function tryParseAmount(input: string | number | null | undefined): Cents | null {
  if (input === null || input === undefined) return null;
  try {
    return parseAmount(input);
  } catch {
    return null;
  }
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(?:\d{3})+(?!\d))/g, ",");
}

/**
 * Formats integer cents for display.
 *
 *   formatMoney(4550)          -> "$45.50"
 *   formatMoney(-4550)         -> "-$45.50"
 *   formatMoney(123456789)     -> "$1,234,567.89"
 *   formatMoney(4550, "EUR")   -> "€45.50"
 *   formatMoney(123456, "LBP") -> "LBP 1,234.56"
 *
 * The sign always leads, so the output round-trips through `parseAmount`.
 * Deliberately not Intl.NumberFormat: that varies with the ICU build and emits
 * non-breaking spaces, which breaks round-tripping and snapshot stability.
 * Throws if `cents` is not an integer.
 */
export function formatMoney(cents: Cents, currency = "USD"): string {
  assertCents(cents, "cents");

  const code = (typeof currency === "string" ? currency.trim().toUpperCase() : "") || "USD";
  const abs = Math.abs(cents);
  const body = `${groupThousands(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, "0")}`;
  const symbol = CURRENCY_SYMBOLS[code];
  const formatted = symbol ? `${symbol}${body}` : `${code} ${body}`;
  return cents < 0 ? `-${formatted}` : formatted;
}

/** Exact sum of integer cents. Throws if any element is not an integer. */
export function sumCents(values: Cents[]): Cents {
  if (!Array.isArray(values)) {
    throw new Error(`sumCents expects an array of cents, received ${describeValue(values)}`);
  }
  let total = 0;
  for (const value of values) {
    assertCents(value, "amount");
    total += value;
  }
  if (!Number.isSafeInteger(total)) {
    throw new Error("sumCents overflowed the exact-integer range");
  }
  return total === 0 ? 0 : total;
}

/** Absolute value in cents. Throws on non-integer input. */
export function absCents(value: Cents): Cents {
  assertCents(value, "amount");
  const abs = Math.abs(value);
  return abs === 0 ? 0 : abs;
}

/** Sign flip in cents (never returns -0). Throws on non-integer input. */
export function negateCents(value: Cents): Cents {
  assertCents(value, "amount");
  return value === 0 ? 0 : -value;
}

/**
 * Cents -> decimal number, e.g. 4550 -> 45.5.
 *
 * DISPLAY / CHARTING BOUNDARY ONLY. The result is a float: never use it for
 * arithmetic, comparison, aggregation, or storage — convert at the last
 * possible moment (chart axis values, third-party APIs that demand decimals)
 * and never convert back except through `parseAmount`.
 */
export function centsToDecimal(cents: Cents): number {
  assertCents(cents, "cents");
  return cents / 100;
}
