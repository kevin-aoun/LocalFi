import { describe, expect, it } from "vitest";

import {
  absCents,
  centsToDecimal,
  formatMoney,
  negateCents,
  parseAmount,
  sumCents,
  tryParseAmount,
} from "@/lib/money";

describe("parseAmount", () => {
  it("parses plain integers and decimals into integer cents", () => {
    expect(parseAmount("45")).toBe(4500);
    expect(parseAmount("45.5")).toBe(4550);
    expect(parseAmount("45.50")).toBe(4550);
    expect(parseAmount("0")).toBe(0);
    expect(parseAmount("0.00")).toBe(0);
    expect(parseAmount("0.01")).toBe(1);
    expect(parseAmount("100")).toBe(10000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseAmount(" 45.00 ")).toBe(4500);
    expect(parseAmount("\t45.50\n")).toBe(4550);
    // non-breaking space, as pasted from bank statements / Excel
    expect(parseAmount(" 45.00 ")).toBe(4500);
  });

  it("parses comma thousands separators", () => {
    expect(parseAmount("1,234.56")).toBe(123456);
    expect(parseAmount("1,234")).toBe(123400);
    expect(parseAmount("1,234,567.89")).toBe(123456789);
    expect(parseAmount("-1,234.56")).toBe(-123456);
  });

  it("parses explicit signs", () => {
    expect(parseAmount("-45.00")).toBe(-4500);
    expect(parseAmount("+45.00")).toBe(4500);
    expect(parseAmount("-0.01")).toBe(-1);
  });

  it("treats the accounting parenthesis form as negative", () => {
    expect(parseAmount("(45.00)")).toBe(-4500);
    expect(parseAmount("(1,234.56)")).toBe(-123456);
    expect(parseAmount("($45.00)")).toBe(-4500);
    expect(parseAmount(" ( 45.00 ) ")).toBe(-4500);
  });

  it("strips currency symbols and ISO codes", () => {
    expect(parseAmount("$45.00")).toBe(4500);
    expect(parseAmount("$1,234.56")).toBe(123456);
    expect(parseAmount("-$45.50")).toBe(-4550);
    expect(parseAmount("$-45.50")).toBe(-4550);
    expect(parseAmount("€45.00")).toBe(4500);
    expect(parseAmount("£45.00")).toBe(4500);
    expect(parseAmount("45.00 USD")).toBe(4500);
    expect(parseAmount("USD 45.00")).toBe(4500);
  });

  it("accepts partial decimal forms", () => {
    expect(parseAmount("45.")).toBe(4500);
    expect(parseAmount(".5")).toBe(50);
    expect(parseAmount("-.5")).toBe(-50);
  });

  it("rounds half away from zero at the cent, in both signs", () => {
    expect(parseAmount("0.005")).toBe(1);
    expect(parseAmount("-0.005")).toBe(-1);
    expect(parseAmount("0.004")).toBe(0);
    expect(parseAmount("-0.004")).toBe(0);
    expect(parseAmount("0.015")).toBe(2);
    expect(parseAmount("-0.015")).toBe(-2);
    expect(parseAmount("1.995")).toBe(200);
    expect(parseAmount("-1.995")).toBe(-200);
  });

  it("never returns negative zero", () => {
    expect(parseAmount("-0.00")).toBe(0);
    expect(Object.is(parseAmount("-0.001"), -0)).toBe(false);
    expect(Object.is(parseAmount("-0.001"), 0)).toBe(true);
  });

  it("does not drift on values that are unrepresentable in binary floats", () => {
    // 0.145 * 100 === 14.499999999999998 in float64 -> naive Math.round gives 14.
    expect(parseAmount("0.145")).toBe(15);
    expect(parseAmount("-0.145")).toBe(-15);
    // 2.675 * 100 === 267.49999999999994 in float64 -> naive Math.round gives 267.
    expect(parseAmount("2.675")).toBe(268);
    expect(parseAmount("-2.675")).toBe(-268);
    // 1.005 * 100 === 100.49999999999999
    expect(parseAmount("1.005")).toBe(101);
    // 8.165 * 100 === 816.4999999999999
    expect(parseAmount("8.165")).toBe(817);
  });

  it("ignores digits beyond the third decimal instead of accumulating error", () => {
    expect(parseAmount("45.50499999")).toBe(4550);
    expect(parseAmount("45.505")).toBe(4551);
    expect(parseAmount("0.999999")).toBe(100);
  });

  it("sums exactly where floats would drift", () => {
    // The classic 0.1 + 0.2 !== 0.3 case, in cents.
    expect(parseAmount("0.1") + parseAmount("0.2")).toBe(parseAmount("0.3"));
    let total = 0;
    for (let i = 0; i < 10; i += 1) total += parseAmount("0.1");
    expect(total).toBe(100);
  });

  it("accepts number inputs without float drift", () => {
    expect(parseAmount(45)).toBe(4500);
    expect(parseAmount(45.5)).toBe(4550);
    expect(parseAmount(-45.5)).toBe(-4550);
    expect(parseAmount(0)).toBe(0);
    expect(parseAmount(2.675)).toBe(268);
    expect(parseAmount(0.1 + 0.2)).toBe(30);
    expect(parseAmount(1.5e3)).toBe(150000);
    expect(parseAmount(1.5e-7)).toBe(0);
  });

  it("throws a clear error on empty / missing input", () => {
    expect(() => parseAmount("")).toThrow(/amount/i);
    expect(() => parseAmount("   ")).toThrow(/amount/i);
    // Callers are expected to validate first; these are deliberately loud.
    expect(() => parseAmount(null as unknown as string)).toThrow(/amount/i);
    expect(() => parseAmount(undefined as unknown as string)).toThrow(/amount/i);
  });

  it("throws on non-numeric junk rather than guessing", () => {
    for (const bad of [
      "abc",
      "4a5",
      "45,",
      "1.2.3",
      "--5",
      "+-5",
      "45%",
      "1 234.56",
      "(45",
      "45)",
      ".",
      "-",
      "$",
      "NaN",
      "Infinity",
    ]) {
      expect(() => parseAmount(bad), `expected "${bad}" to throw`).toThrow(Error);
    }
  });

  it("throws on non-finite numbers and non-string/number types", () => {
    expect(() => parseAmount(NaN)).toThrow(Error);
    expect(() => parseAmount(Infinity)).toThrow(Error);
    expect(() => parseAmount(-Infinity)).toThrow(Error);
    expect(() => parseAmount({} as unknown as number)).toThrow(Error);
    expect(() => parseAmount([] as unknown as number)).toThrow(Error);
    expect(() => parseAmount(true as unknown as number)).toThrow(Error);
  });

  it("throws when the value cannot be represented exactly in cents", () => {
    expect(() => parseAmount("99999999999999999999")).toThrow(/too large/i);
    expect(() => parseAmount(1e21)).toThrow(/too large/i);
  });
});

describe("tryParseAmount", () => {
  it("returns cents for valid input and null for invalid input", () => {
    expect(tryParseAmount("(1,234.56)")).toBe(-123456);
    expect(tryParseAmount("abc")).toBeNull();
    expect(tryParseAmount("")).toBeNull();
    expect(tryParseAmount(null)).toBeNull();
    expect(tryParseAmount(undefined)).toBeNull();
  });
});

describe("formatMoney", () => {
  it("formats USD by default", () => {
    expect(formatMoney(4550)).toBe("$45.50");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(5)).toBe("$0.05");
    expect(formatMoney(50)).toBe("$0.50");
    expect(formatMoney(100)).toBe("$1.00");
  });

  it("puts the sign in front of the symbol for negatives", () => {
    expect(formatMoney(-4550)).toBe("-$45.50");
    expect(formatMoney(-5)).toBe("-$0.05");
    expect(formatMoney(-123456789)).toBe("-$1,234,567.89");
  });

  it("groups thousands", () => {
    expect(formatMoney(123456789)).toBe("$1,234,567.89");
    expect(formatMoney(100000)).toBe("$1,000.00");
    expect(formatMoney(999999)).toBe("$9,999.99");
    expect(formatMoney(1000000000000)).toBe("$10,000,000,000.00");
  });

  it("supports EUR and GBP symbols and is case-insensitive on the code", () => {
    expect(formatMoney(4550, "EUR")).toBe("€45.50");
    expect(formatMoney(4550, "GBP")).toBe("£45.50");
    expect(formatMoney(4550, "USD")).toBe("$45.50");
    expect(formatMoney(4550, "eur")).toBe("€45.50");
    expect(formatMoney(-4550, "EUR")).toBe("-€45.50");
  });

  it("falls back to '<CODE> 1,234.56' for currencies without a symbol", () => {
    expect(formatMoney(123456, "LBP")).toBe("LBP 1,234.56");
    expect(formatMoney(4550, "XYZ")).toBe("XYZ 45.50");
    expect(formatMoney(-4550, "XYZ")).toBe("-XYZ 45.50");
  });

  it("rejects non-integer cents loudly", () => {
    expect(() => formatMoney(45.5)).toThrow(/integer/i);
    expect(() => formatMoney(NaN)).toThrow(/integer/i);
    expect(() => formatMoney(Infinity)).toThrow(/integer/i);
    expect(() => formatMoney("4550" as unknown as number)).toThrow(/integer/i);
  });

  it("round-trips through parseAmount", () => {
    const values = [
      0, 1, -1, 5, 99, 100, -100, 4550, -4550, 123456, -123456, 123456789,
      -123456789, 1000000000, 7,
    ];
    for (const cents of values) {
      expect(parseAmount(formatMoney(cents)), `USD ${cents}`).toBe(cents);
      expect(parseAmount(formatMoney(cents, "EUR")), `EUR ${cents}`).toBe(cents);
      expect(parseAmount(formatMoney(cents, "LBP")), `LBP ${cents}`).toBe(cents);
    }
  });
});

describe("sumCents / absCents / negateCents", () => {
  it("sums exactly", () => {
    expect(sumCents([])).toBe(0);
    expect(sumCents([1, 2, 3])).toBe(6);
    expect(sumCents([10, -10])).toBe(0);
    expect(sumCents(Array.from({ length: 10 }, () => 10))).toBe(100);
    expect(sumCents([-4550, 4550, 1])).toBe(1);
  });

  it("absCents and negateCents behave and never return -0", () => {
    expect(absCents(-4550)).toBe(4550);
    expect(absCents(4550)).toBe(4550);
    expect(negateCents(4550)).toBe(-4550);
    expect(negateCents(-4550)).toBe(4550);
    expect(Object.is(negateCents(0), 0)).toBe(true);
    expect(Object.is(absCents(-0), 0)).toBe(true);
  });

  it("rejects non-integer cents loudly", () => {
    expect(() => sumCents([1, 2.5])).toThrow(/integer/i);
    expect(() => sumCents([1, NaN])).toThrow(/integer/i);
    expect(() => sumCents("nope" as unknown as number[])).toThrow(Error);
    expect(() => absCents(2.5)).toThrow(/integer/i);
    expect(() => negateCents(2.5)).toThrow(/integer/i);
    expect(() => absCents(NaN)).toThrow(/integer/i);
  });
});

describe("centsToDecimal", () => {
  it("converts for display/charting only", () => {
    expect(centsToDecimal(4550)).toBe(45.5);
    expect(centsToDecimal(-4550)).toBe(-45.5);
    expect(centsToDecimal(5)).toBe(0.05);
    expect(centsToDecimal(0)).toBe(0);
    expect(centsToDecimal(123456789)).toBe(1234567.89);
  });

  it("rejects non-integer cents loudly", () => {
    expect(() => centsToDecimal(45.5)).toThrow(/integer/i);
    expect(() => centsToDecimal(NaN)).toThrow(/integer/i);
  });
});
