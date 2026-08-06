/**
 * The transfer dialog's form -> FormData mapping and its validation.
 *
 * WHY: moving money between your own accounts used to be entered as an
 * "Investment" expense, which the app booked as a net-worth LOSS. A transfer is
 * a first-class row with NO category, a source account and a destination
 * account, and `createTransfer` in app/actions/transactions.ts expects exactly
 * the field names asserted below.
 *
 * Must pass under `npm run test:tz`: the date goes over the wire through the
 * same local-midnight serialization as an ordinary transaction.
 */
import { describe, expect, it } from "vitest";
import { monthKey, toDateKey } from "@/lib/dates";
import {
  buildTransferFormValues,
  describeTransfer,
  emptyTransferForm,
  toTransferFormData,
  transferFormFromTransaction,
  validateTransferForm,
  type TransferFormState,
} from "../transfer-form-logic";

function state(over: Partial<TransferFormState> = {}): TransferFormState {
  return {
    fromAccountId: "10",
    toAccountId: "11",
    amount: "1000.00",
    comment: "To savings",
    date: new Date(2026, 6, 28),
    pending: false,
    ...over,
  };
}

describe("buildTransferFormValues", () => {
  it("maps to exactly the field names createTransfer reads", () => {
    expect(buildTransferFormValues(state())).toEqual({
      fromAccountId: "10",
      toAccountId: "11",
      amount: "1000.00",
      comment: "To savings",
      date: "2026-07-28T00:00:00",
      pending: "false",
    });
  });

  it("NEVER sends a category — a transfer is not income or expense", () => {
    const values = buildTransferFormValues(state());
    expect(values).not.toHaveProperty("categoryId");
    expect(Object.keys(values)).not.toContain("categoryId");

    const formData = toTransferFormData(state());
    expect(formData.get("categoryId")).toBeNull();
    expect(formData.has("categoryId")).toBe(false);
  });

  it("puts every field on a real FormData", () => {
    const formData = toTransferFormData(state({ pending: true }));
    expect(formData.get("fromAccountId")).toBe("10");
    expect(formData.get("toAccountId")).toBe("11");
    expect(formData.get("amount")).toBe("1000.00");
    expect(formData.get("comment")).toBe("To savings");
    expect(formData.get("pending")).toBe("true");
  });

  it("serializes the picked day, not its UTC equivalent", () => {
    // toISOString() on local midnight stores the PREVIOUS day east of UTC.
    const picked = new Date(2026, 7, 1); // 1 August — the month-boundary case
    const wire = buildTransferFormValues(state({ date: picked })).date;
    expect(wire).toBe("2026-08-01T00:00:00");
    const stored = new Date(wire); // exactly what the server action does
    expect(toDateKey(stored)).toBe("2026-08-01");
    expect(monthKey(stored)).toBe("2026-08");
  });
});

describe("validateTransferForm", () => {
  it("accepts a well-formed transfer", () => {
    expect(validateTransferForm(state())).toBeNull();
  });

  it("REJECTS a transfer to the same account", () => {
    expect(validateTransferForm(state({ fromAccountId: "10", toAccountId: "10" }))).toMatch(
      /different/i,
    );
  });

  it("rejects a missing source or destination", () => {
    expect(validateTransferForm(state({ fromAccountId: "" }))).toMatch(/source|destination/i);
    expect(validateTransferForm(state({ toAccountId: "" }))).toMatch(/source|destination/i);
    expect(validateTransferForm(state({ fromAccountId: "  " }))).toMatch(/source|destination/i);
  });

  it("rejects a non-numeric account id rather than sending NaN to the server", () => {
    expect(validateTransferForm(state({ fromAccountId: "abc" }))).toMatch(/account/i);
  });

  it("rejects an unparseable amount", () => {
    expect(validateTransferForm(state({ amount: "" }))).toMatch(/amount/i);
    expect(validateTransferForm(state({ amount: "abc" }))).toMatch(/amount/i);
  });

  it("ACCEPTS a zero amount — 0 is a real value, not 'absent'", () => {
    expect(validateTransferForm(state({ amount: "0" }))).toBeNull();
    expect(validateTransferForm(state({ amount: "0.00" }))).toBeNull();
  });

  it("rejects a negative amount and says to swap the accounts", () => {
    expect(validateTransferForm(state({ amount: "-50" }))).toMatch(/swap/i);
  });

  it("accepts a transfer with no comment", () => {
    expect(validateTransferForm(state({ comment: "" }))).toBeNull();
    expect(buildTransferFormValues(state({ comment: "" })).comment).toBe("");
  });
});

describe("transferFormFromTransaction", () => {
  it("round-trips a stored transfer back into the form", () => {
    const form = transferFormFromTransaction({
      id: 7,
      accountId: 10,
      transferAccountId: 11,
      amountCents: 100_000,
      comment: "To savings",
      date: new Date(2026, 6, 28),
      pending: false,
    });
    expect(form.fromAccountId).toBe("10");
    expect(form.toAccountId).toBe("11");
    // Cents -> the decimal string an <input type="number"> expects.
    expect(form.amount).toBe("1000");
    expect(form.comment).toBe("To savings");
    expect(toDateKey(form.date)).toBe("2026-07-28");
    expect(validateTransferForm(form)).toBeNull();
  });

  it("round-trips a zero-cent transfer without turning it into an empty field", () => {
    const form = transferFormFromTransaction({
      id: 8,
      accountId: 10,
      transferAccountId: 11,
      amountCents: 0,
      comment: null,
      date: new Date(2026, 6, 28),
      pending: false,
    });
    expect(form.amount).toBe("0");
    expect(form.comment).toBe("");
    expect(validateTransferForm(form)).toBeNull();
  });

  it("survives a row whose accounts are missing", () => {
    const form = transferFormFromTransaction({
      id: 9,
      accountId: null,
      transferAccountId: null,
      amountCents: 500,
      comment: null,
      date: new Date(2026, 6, 28),
      pending: false,
    });
    expect(form.fromAccountId).toBe("");
    expect(form.toAccountId).toBe("");
    expect(validateTransferForm(form)).not.toBeNull();
  });
});

describe("emptyTransferForm", () => {
  it("defaults the source account and leaves the destination for the user", () => {
    const form = emptyTransferForm(10);
    expect(form.fromAccountId).toBe("10");
    expect(form.toAccountId).toBe("");
    expect(form.amount).toBe("");
    expect(form.pending).toBe(false);
  });

  it("copes with a user who has no accounts yet", () => {
    expect(emptyTransferForm(null).fromAccountId).toBe("");
  });
});

describe("describeTransfer", () => {
  it("reads as a direction, so a transfer row is not mistaken for spend", () => {
    const label = describeTransfer("Main Checking", "Rainy Day Savings");
    expect(label).toContain("Main Checking");
    expect(label).toContain("Rainy Day Savings");
    expect(label).toMatch(/→|->/);
  });

  it("names the unassigned bucket instead of rendering 'null'", () => {
    expect(describeTransfer(undefined, "Savings")).not.toContain("null");
    expect(describeTransfer(undefined, "Savings")).not.toContain("undefined");
  });
});
