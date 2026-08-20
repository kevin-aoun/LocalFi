

export type Cents = number;

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
};

const STRIPPABLE_SYMBOLS = /[$€£¥₹₪]/g;

const GROUPED_NUMBER = /^\d{1,3}(?:,\d{3})*(?:\.\d*)?$/;
const PLAIN_NUMBER = /^\d*(?:\.\d*)?$/;

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}

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


export function isCents(value: unknown): value is Cents {
  return typeof value === "number" && Number.isSafeInteger(value);
}


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



  let negative = false;
  while (s.length >= 2 && s.startsWith("(") && s.endsWith(")")) {
    negative = !negative;
    s = s.slice(1, -1).trim();
  }


  s = s.replace(STRIPPABLE_SYMBOLS, "").trim();



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


  const frac3 = `${fracPart}000`.slice(0, 3);

  const whole = Number(wholeDigits);
  let cents = whole * 100 + Number(frac3.slice(0, 2));
  if (frac3.charCodeAt(2) >= 53 ) cents += 1;

  if (!Number.isSafeInteger(cents)) {
    throw new Error(
      `Invalid amount: ${JSON.stringify(raw)} is too large to represent exactly in cents`,
    );
  }
  if (cents === 0) return 0;
  return negative ? -cents : cents;
}


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


export function formatMoney(cents: Cents, currency = "USD"): string {
  assertCents(cents, "cents");

  const code = (typeof currency === "string" ? currency.trim().toUpperCase() : "") || "USD";
  const abs = Math.abs(cents);
  const body = `${groupThousands(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, "0")}`;
  const symbol = CURRENCY_SYMBOLS[code];
  const formatted = symbol ? `${symbol}${body}` : `${code} ${body}`;
  return cents < 0 ? `-${formatted}` : formatted;
}


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


export function absCents(value: Cents): Cents {
  assertCents(value, "amount");
  const abs = Math.abs(value);
  return abs === 0 ? 0 : abs;
}


export function negateCents(value: Cents): Cents {
  assertCents(value, "amount");
  return value === 0 ? 0 : -value;
}


export function centsToDecimal(cents: Cents): number {
  assertCents(cents, "cents");
  return cents / 100;
}
