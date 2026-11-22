
import { describe, expect, it } from "vitest";
import { monthKey, toDateKey } from "@/lib/dates";
import {
  buildTransferFormValues,
  describeTransfer,
  emptyTransferForm,
  toTransferFormData,
  transferFormFromTransaction,
  validateTransferForm,
  transferDebitPreview,
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
    fees: "0",
    feeCategoryId: "",
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
      fees: "0",
      feeCategoryId: "",
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

  it("sends fees separately from the amount transferred", () => {
    expect(buildTransferFormValues(state())).not.toHaveProperty("principalAmount");
    expect(buildTransferFormValues(state({
      amount: "100.00",
      fees: "10.00",
      feeCategoryId: "9",
    }))).toMatchObject({ amount: "100.00", fees: "10.00", feeCategoryId: "9" });
  });

  it("serializes the picked day, not its UTC equivalent", () => {

    const picked = new Date(2026, 7, 1);
    const wire = buildTransferFormValues(state({ date: picked })).date;
    expect(wire).toBe("2026-08-01T00:00:00");
    const stored = new Date(wire);
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

  it("rejects accounts with different currencies", () => {
    expect(
      validateTransferForm(state(), [
        { id: 10, currency: "USD" },
        { id: 11, currency: "EUR" },
      ]),
    ).toMatch(/without an FX model/i);
    expect(
      validateTransferForm(state(), [
        { id: 10, currency: "usd" },
        { id: 11, currency: "USD" },
      ]),
    ).toBeNull();
  });

  it("accepts a transfer with no comment", () => {
    expect(validateTransferForm(state({ comment: "" }))).toBeNull();
    expect(buildTransferFormValues(state({ comment: "" })).comment).toBe("");
  });

  it("validates fees and requires their expense category only when fees are positive", () => {
    expect(validateTransferForm(state({
      amount: "110.00",
      fees: "10.00",
      feeCategoryId: "9",
    }))).toBeNull();
    expect(validateTransferForm(state({
      amount: "110.00",
      fees: "10.00",
      feeCategoryId: "",
    }))).toMatch(/category/i);
    expect(validateTransferForm(state({
      amount: "110.00",
      fees: "-1",
      feeCategoryId: "9",
    }))).toMatch(/fees/i);
    expect(validateTransferForm(state({ fees: "bad" }))).toMatch(/fees/i);
    expect(validateTransferForm(state({ fees: "" }))).toBeNull();
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

  it("round-trips the stored principal and interest category", () => {
    const form = transferFormFromTransaction({
      id: 10,
      accountId: 10,
      transferAccountId: 11,
      amountCents: 11_000,
      transferPrincipalAmountCents: 10_000,
      allocations: [{ categoryId: 9, amountCents: 1_000 }],
      date: new Date(2026, 6, 28),
    });
    expect(form.amount).toBe("100");
    expect(form.fees).toBe("10");
    expect(form.feeCategoryId).toBe("9");
    expect(validateTransferForm(form)).toBeNull();
  });

  it("hydrates a transfer and its separate fee without subtracting the fee twice", () => {
    const form = transferFormFromTransaction({ id: 12, accountId: 10, transferAccountId: 11, amountCents: 10000,
      transferPrincipalAmountCents: 10000, feeAmountCents: 250, feeCategoryId: 9, date: new Date(2026, 6, 28) });
    expect(form).toMatchObject({ amount: "100", fees: "2.5", feeCategoryId: "9" });
    expect(transferDebitPreview(form.amount, form.fees)).toBe(10250);
    expect(transferDebitPreview("0", "0")).toBe(0);
    expect(transferDebitPreview("100", "-1")).toBeNull();
    expect(transferDebitPreview("90071992547409.91", "0.01")).toBeNull();
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
