/**
 * Boundary tests: money crossing into and out of the app must go through
 * lib/money, never through Number()/parseFloat()/toFixed().
 *
 * These tests read the source of the server actions and the money-bearing
 * components as text. That is deliberate: the point of the refactor is that no
 * float ever touches a money value, and the cheapest durable guard against a
 * regression is to assert the forbidden idioms are absent from these files.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { centsToDecimal, formatMoney, parseAmount, tryParseAmount } from "@/lib/money";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(PROJECT_ROOT, rel), "utf-8");

describe("input boundary uses parseAmount", () => {
  it("round-trips a grouped amount typed by the user", () => {
    expect(parseAmount("1,234.56")).toBe(123456);
  });

  it("round-trips the strings an <input type=number> can produce", () => {
    expect(parseAmount("45")).toBe(4500);
    expect(parseAmount("45.5")).toBe(4550);
    expect(parseAmount("45.50")).toBe(4550);
    expect(parseAmount("0.05")).toBe(5);
    expect(parseAmount("-45.00")).toBe(-4500);
  });

  it("round-trips cents -> form field string -> cents without drift", () => {
    // This is how the dialogs pre-fill a money input and how the import dialog
    // hands an amount to the server action.
    const values = [0, 1, 5, 10, 70, 4500, 4550, 12050, 123456, 500000, 532371, -4500, 449618];
    for (const cents of values) {
      const formValue = centsToDecimal(cents).toString();
      expect(parseAmount(formValue)).toBe(cents);
    }
  });

  it("round-trips formatted money back through parseAmount", () => {
    for (const cents of [0, 5, 4550, -4550, 123456789]) {
      expect(parseAmount(formatMoney(cents))).toBe(cents);
    }
  });

  it("parses the Excel-import shapes the import dialog has to handle", () => {
    expect(tryParseAmount("$1,234.56")).toBe(123456);
    expect(tryParseAmount("(45.00)")).toBe(-4500);
    expect(tryParseAmount(" 45.00 ")).toBe(4500);
    expect(tryParseAmount(120.5)).toBe(12050);
    expect(tryParseAmount("not a number")).toBeNull();
    expect(tryParseAmount("")).toBeNull();
    expect(tryParseAmount(null)).toBeNull();
  });
});

const MONEY_WRITERS = [
  "app/actions/transactions.ts",
  "app/actions/assets.ts",
  "app/actions/budgets.ts",
  "app/actions/settings.ts",
];

describe("server actions never parse money with float builtins", () => {
  for (const file of MONEY_WRITERS) {
    it(`${file} imports parseAmount from lib/money where it reads money`, () => {
      const source = read(file);
      if (/amountCents|currentValueCents|monthlyLimitCents/.test(source)) {
        expect(source).toMatch(/from "@\/lib\/money"/);
      }
    });

    it(`${file} contains no parseFloat and no toFixed`, () => {
      const source = read(file);
      expect(source).not.toMatch(/parseFloat\s*\(/);
      expect(source).not.toMatch(/\.toFixed\s*\(/);
    });

    it(`${file} does not coerce a money form field with Number()`, () => {
      const source = read(file);
      const offenders = [
        /Number\(\s*formData\.get\(\s*["']amount["']/,
        /Number\(\s*formData\.get\(\s*["']currentValue["']/,
        /Number\(\s*formData\.get\(\s*["']monthlyLimit["']/,
      ];
      for (const pattern of offenders) expect(source).not.toMatch(pattern);
    });
  }
});

const MONEY_DISPLAYS = [
  "app/(dashboard)/page.tsx",
  "app/(dashboard)/transactions/page.tsx",
  "app/(dashboard)/budgets/budgets-client.tsx",
  "components/shared/sidebar.tsx",
  "components/assets/asset-dialog.tsx",
  "components/budgets/budget-dialog.tsx",
  "components/transactions/transaction-dialog.tsx",
  "components/transactions/import-dialog.tsx",
  "components/settings/quick-commands-manager.tsx",
];

describe("components format money with formatMoney", () => {
  for (const file of MONEY_DISPLAYS) {
    it(`${file} has no hand-rolled dollar template literals`, () => {
      const source = read(file);
      // e.g. `${"$"}${x.toFixed(2)}` or "$" immediately before an interpolation.
      expect(source).not.toMatch(/\$\{[^}]*\.toFixed\(2\)[^}]*\}/);
      expect(source).not.toMatch(/\$\{[^}]*toLocaleString\(\s*["']en-US["']\s*,\s*\{\s*minimumFractionDigits/);
    });
  }
});
