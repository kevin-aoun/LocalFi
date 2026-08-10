/**
 * Regression tests for the off-by-one-day bug (item 1).
 *
 * These must pass under `bun run test:tz`, which re-runs the suite at
 * TZ=Pacific/Kiritimati (UTC+14) and TZ=Pacific/Niue (UTC-11). Each test that
 * depends on the zone states what the OLD code produced there, so the bug is
 * encoded in the assertions rather than described in a comment.
 */
import { describe, expect, it } from "vitest";
import { monthKey, toDateKey } from "@/lib/dates";
import {
  buildTransactionFormValues,
  previewInvestmentQuantity,
  toTransactionDateValue,
  toTransactionFormData,
  transactionDateKey,
  validateTransactionForm,
} from "../transaction-form-logic";

const OFFSET_MINUTES = new Date(2026, 6, 28).getTimezoneOffset();
const EAST_OF_UTC = OFFSET_MINUTES < 0;
const WEST_OF_UTC = OFFSET_MINUTES > 0;

describe("the calendar day the user picked survives serialization", () => {
  it("serializes the picked day, not its UTC equivalent", () => {
    const picked = new Date(2026, 6, 28); // local midnight, 28 July 2026
    expect(toTransactionDateValue(picked)).toBe("2026-07-28T00:00:00");
  });

  it("reproduces the old bug so the regression is unmistakable", () => {
    const picked = new Date(2026, 6, 28);
    const old = picked.toISOString().split("T")[0]; // what the dialog used to send
    if (EAST_OF_UTC) {
      // A user in Beirut/Kiritimati picking the 28th stored the 27th.
      expect(old).toBe("2026-07-27");
    }
    expect(toTransactionDateValue(picked).slice(0, 10)).toBe("2026-07-28");
  });

  it("round-trips through the server's `new Date(value)` in any timezone", () => {
    // app/actions/transactions.ts stores the field with `new Date(value)`.
    for (const [y, m, d] of [
      [2026, 6, 28],
      [2026, 0, 1], // 1 January — the month-boundary case
      [2025, 11, 31], // 31 December
      [2026, 2, 1], // 1 March, just after a DST transition in many zones
      [2024, 1, 29], // leap day
    ] as const) {
      const picked = new Date(y, m, d);
      const wire = toTransactionDateValue(picked);
      const stored = new Date(wire); // exactly what the server does
      expect(transactionDateKey(stored)).toBe(toDateKey(picked));
      expect(monthKey(stored)).toBe(monthKey(picked));
    }
  });

  it("keeps first-of-month spend in the right budget month", () => {
    const firstOfAugust = new Date(2026, 7, 1);
    const stored = new Date(toTransactionDateValue(firstOfAugust));
    expect(monthKey(stored)).toBe("2026-08");

    // The old wire format, re-read the way the app reads it back.
    const oldStored = new Date(firstOfAugust.toISOString().split("T")[0]);
    if (EAST_OF_UTC) {
      expect(monthKey(oldStored)).toBe("2026-07"); // filed into July's budget
    }
    if (WEST_OF_UTC) {
      // Bare 'YYYY-MM-DD' is parsed as UTC midnight, which is still July locally.
      expect(monthKey(oldStored)).toBe("2026-07");
    }
  });

  it("never sends a bare date-only string (which `new Date` reads as UTC)", () => {
    const wire = toTransactionDateValue(new Date(2026, 6, 28));
    expect(wire).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00$/);
    expect(new Date(wire).getHours()).toBe(0); // local midnight, not shifted
  });
});

describe("buildTransactionFormValues", () => {
  it("passes the money string through untouched and normalizes pending", () => {
    expect(
      buildTransactionFormValues({
        categoryId: "3",
        amount: "45.5",
        comment: "Groceries",
        date: new Date(2026, 6, 28),
        pending: false,
      }),
    ).toEqual({
      categoryId: "3",
      amount: "45.5",
      comment: "Groceries",
      date: "2026-07-28T00:00:00",
      pending: "false",
      // Always present, possibly empty: see `resolveAccountId` in the action.
      accountId: "",
    });
  });

  it("marks pending transactions", () => {
    const values = buildTransactionFormValues({
      categoryId: "1",
      amount: "10",
      comment: "",
      date: new Date(2026, 6, 28),
      pending: true,
    });
    expect(values.pending).toBe("true");
  });

  it("carries the chosen account so a transaction lands where the user said", () => {
    const values = buildTransactionFormValues({
      categoryId: "1",
      amount: "10",
      comment: "",
      date: new Date(2026, 6, 28),
      pending: false,
      accountId: "7",
    });
    expect(values.accountId).toBe("7");
  });

  it("sends an EMPTY accountId rather than 'undefined' when none is chosen", () => {
    // The action reads an empty string as "not supplied": on create it falls back
    // to the default account, on update it leaves the account alone. The string
    // "undefined" would be parsed as NaN and rejected.
    for (const accountId of [undefined, "", "   "]) {
      const values = buildTransactionFormValues({
        categoryId: "1",
        amount: "10",
        comment: "",
        date: new Date(2026, 6, 28),
        pending: false,
        accountId,
      });
      expect(values.accountId).toBe("");
      expect(toTransactionFormData({
        categoryId: "1",
        amount: "10",
        comment: "",
        date: new Date(2026, 6, 28),
        pending: false,
        accountId,
      }).get("accountId")).toBe("");
    }
  });

  it("rejects negative magnitudes before submitting", () => {
    const invalid = {
      categoryId: "1",
      amount: "-0.01",
      comment: "x",
      date: new Date(2026, 6, 28),
      pending: false,
    };
    expect(validateTransactionForm(invalid)).toMatch(/negative/i);
    expect(() => toTransactionFormData(invalid)).toThrow(/negative/i);
  });

  it("previews provider-priced quantity but transports an exact user override", () => {
    expect(previewInvestmentQuantity("1000.00", "50000.00")).toBe("0.02");
    const values = buildTransactionFormValues({
      categoryId: "3",
      accountId: "7",
      amount: "1000.00",
      comment: "BTC",
      date: new Date(2026, 6, 28),
      pending: false,
      instrumentSymbol: "BTC",
      instrumentUnit: "coins",
      unitPrice: "49999.99",
      quantity: "0.020000004",
    });
    expect(values).toMatchObject({
      instrumentSymbol: "BTC",
      instrumentUnit: "coins",
      unitPrice: "49999.99",
      quantity: "0.020000004",
    });
  });

  it("requires complete positive purchase facts", () => {
    const base = {
      categoryId: "3",
      amount: "1000.00",
      comment: "BTC",
      date: new Date(2026, 6, 28),
      pending: false,
      instrumentSymbol: "BTC",
      instrumentUnit: "coins",
      unitPrice: "50000.00",
      quantity: "0.02",
    };
    expect(validateTransactionForm(base)).toBeNull();
    expect(validateTransactionForm({ ...base, quantity: "" })).toMatch(/quantity/i);
    expect(validateTransactionForm({ ...base, quantity: "-0.02" })).toMatch(/positive/i);
    expect(validateTransactionForm({ ...base, unitPrice: "0" })).toMatch(/unit price/i);
  });
});
