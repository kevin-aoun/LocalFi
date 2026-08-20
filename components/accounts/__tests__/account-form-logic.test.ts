
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { accountKindForType, accountKinds, accountTypes } from "@/lib/db/schema";
import { parseAmount } from "@/lib/money";
import {
  ACCOUNT_KINDS,
  ACCOUNT_TYPES,
  DEFAULT_ACCOUNT_TYPE,
  IMPLIED_KIND,
  accountFormStateFromAccount,
  currencyOf,
  describeBalance,
  emptyAccountFormState,
  groupAccountsByKind,
  impliedKind,
  kindIsEditable,
  openingBalanceHelp,
  orphanSummary,
  presentNetWorth,
  toAccountFormData,
  validateAccountForm,
  type AccountFormState,
} from "../account-form-logic";

describe("the form's vocabulary matches the schema's", () => {
  it("offers exactly the account types the server validates against", () => {
    expect([...ACCOUNT_TYPES]).toEqual([...accountTypes]);
  });

  it("offers exactly the two kinds", () => {
    expect([...ACCOUNT_KINDS]).toEqual([...accountKinds]);
  });

  it("agrees with the schema about which side of the balance sheet each type is on", () => {
    expect(IMPLIED_KIND).toEqual(accountKindForType);
  });

  it("defaults to a type the server accepts", () => {
    expect([...accountTypes]).toContain(DEFAULT_ACCOUNT_TYPE);
    expect(emptyAccountFormState().type).toBe(DEFAULT_ACCOUNT_TYPE);
  });

  it("starts a blank form with an ABSENT opening balance, not a zero", () => {

    expect(emptyAccountFormState().openingBalance).toBe("");
  });
});

describe("impliedKind", () => {
  it("puts debt on the liability side", () => {
    expect(impliedKind("Mortgage")).toBe("liability");
    expect(impliedKind("Loan")).toBe("liability");
    expect(impliedKind("CreditCard")).toBe("liability");
  });

  it("puts holdings on the asset side", () => {
    expect(impliedKind("Checking")).toBe("asset");
    expect(impliedKind("Savings")).toBe("asset");
    expect(impliedKind("Cash")).toBe("asset");
    expect(impliedKind("Investment")).toBe("asset");
  });

  it("treats an unknown type as an asset rather than crashing the form", () => {
    expect(impliedKind("Nonsense")).toBe("asset");
  });

  it("only lets the user choose the kind for the one ambiguous type", () => {
    expect(kindIsEditable("Other")).toBe(true);
    expect(kindIsEditable("Mortgage")).toBe(false);
    expect(kindIsEditable("Checking")).toBe(false);
  });
});

const base: AccountFormState = {
  name: "Everyday Checking",
  kind: "asset",
  type: "Checking",
  openingBalance: "",
  openingBalanceDate: "2026-07-28",
  currency: "USD",
};

const ok = (state: AccountFormState) => {
  const result = validateAccountForm(state);
  if (!result.ok) throw new Error(`expected valid, got error: ${result.error}`);
  return result.values;
};

const err = (state: AccountFormState) => {
  const result = validateAccountForm(state);
  if (result.ok) throw new Error("expected an error, got valid values");
  return result.error;
};

/** The opening balance that would be SENT — fails loudly when it was omitted. */
const opening = (state: AccountFormState): string => {
  const value = ok(state).openingBalance;
  if (value === undefined) throw new Error("expected an opening balance to be sent");
  return value;
};

describe("validateAccountForm — name", () => {
  it("rejects an empty name", () => {
    expect(err({ ...base, name: "" })).toMatch(/name/i);
  });

  it("rejects a whitespace-only name", () => {
    expect(err({ ...base, name: "   " })).toMatch(/name/i);
  });

  it("trims the name it sends", () => {
    expect(ok({ ...base, name: "  Savings  " }).name).toBe("Savings");
  });
});

describe("validateAccountForm — type and kind", () => {
  it("rejects a type the server would refuse", () => {
    expect(err({ ...base, type: "Piggybank" })).toMatch(/type/i);
  });

  it("forces the kind implied by an unambiguous type", () => {
    // The user cannot choose "asset" for a mortgage: the server rejects the
    // combination outright, and silently accepting it would inflate net worth.
    expect(ok({ ...base, type: "Mortgage", kind: "asset" }).kind).toBe("liability");
    expect(ok({ ...base, type: "CreditCard", kind: "asset" }).kind).toBe("liability");
    expect(ok({ ...base, type: "Savings", kind: "liability" }).kind).toBe("asset");
  });

  it("honours an explicit kind for the ambiguous 'Other' type", () => {
    expect(ok({ ...base, type: "Other", kind: "liability" }).kind).toBe("liability");
    expect(ok({ ...base, type: "Other", kind: "asset" }).kind).toBe("asset");
  });

  it("rejects a kind that is neither asset nor liability", () => {
    expect(err({ ...base, type: "Other", kind: "both" as never })).toMatch(/kind/i);
  });
});

describe("validateAccountForm — opening balance", () => {
  it('treats "" as ABSENT: the field is not sent at all', () => {
    const values = ok({ ...base, openingBalance: "" });
    expect("openingBalance" in values).toBe(false);
  });

  it("treats whitespace as absent too", () => {
    expect("openingBalance" in ok({ ...base, openingBalance: "   " })).toBe(false);
  });

  it('treats "0" as a VALUE, distinguishable from absent', () => {
    // The falsy-0 bug, twice found in this codebase: `if (openingBalance)`
    // drops "0" and the server then keeps whatever was stored before.
    const values = ok({ ...base, openingBalance: "0" });
    expect(values.openingBalance).toBe("0");
    expect(parseAmount(opening({ ...base, openingBalance: "0" }))).toBe(0);
  });

  it('treats "0.00" as a value as well', () => {
    expect(parseAmount(opening({ ...base, openingBalance: "0.00" }))).toBe(0);
  });

  it('round-trips "1,234.56" to exact cents', () => {
    expect(parseAmount(opening({ ...base, openingBalance: "1,234.56" }))).toBe(123456);
  });

  it("round-trips a value that float arithmetic would drift", () => {
    expect(parseAmount(opening({ ...base, openingBalance: "2.675" }))).toBe(268);
  });

  it("accepts a currency-decorated amount", () => {
    expect(parseAmount(opening({ ...base, openingBalance: "$1,000" }))).toBe(100000);
  });

  it("rejects a negative opening-balance magnitude", () => {
    expect(err({ ...base, openingBalance: "-25.50" })).toMatch(/cannot be negative/i);
  });

  it("produces an ERROR for garbage rather than a silent 0", () => {
    const message = err({ ...base, openingBalance: "abc" });
    expect(message).toMatch(/opening balance/i);
    expect(message).toContain("abc");
  });

  it("rejects a half-typed number instead of storing part of it", () => {
    expect(err({ ...base, openingBalance: "12,34" })).toMatch(/opening balance/i);
  });

  it("rejects a value too large to hold exactly in cents", () => {
    expect(err({ ...base, openingBalance: "999999999999999999" })).toMatch(/opening balance/i);
  });
});

describe("validateAccountForm — currency", () => {
  it("normalises the code", () => {
    expect(ok({ ...base, currency: " eur " }).currency).toBe("EUR");
  });

  it("falls back to USD when the field is blank", () => {
    expect(ok({ ...base, currency: "" }).currency).toBe("USD");
  });

  it("rejects something that is not a currency code", () => {
    expect(err({ ...base, currency: "dollars!" })).toMatch(/currency/i);
  });
});

describe("validateAccountForm — opening date", () => {
  it("keeps a real calendar day and rejects impossible dates", () => {
    expect(ok({ ...base, openingBalanceDate: "2024-02-29" }).openingBalanceDate).toBe(
      "2024-02-29",
    );
    expect(err({ ...base, openingBalanceDate: "2024-02-30" })).toMatch(/date/i);
  });
});

describe("toAccountFormData", () => {
  it("carries exactly the validated values", () => {
    const formData = toAccountFormData({
      ...base,
      name: "Visa",
      type: "CreditCard",
      kind: "asset",
      openingBalance: "600",
      currency: "usd",
    });
    expect(formData.get("name")).toBe("Visa");
    expect(formData.get("type")).toBe("CreditCard");
    expect(formData.get("kind")).toBe("liability");
    expect(formData.get("openingBalance")).toBe("600");
    expect(formData.get("currency")).toBe("USD");
    expect(formData.get("openingBalanceDate")).toBe("2026-07-28");
    // Archiving is a separate action; the dialog must never flip it by omission.
    expect(formData.has("archived")).toBe(false);
  });

  it("omits the opening balance when it was left blank, and only then", () => {
    expect(toAccountFormData({ ...base, openingBalance: "" }).get("openingBalance")).toBeNull();
    expect(toAccountFormData({ ...base, openingBalance: "0" }).get("openingBalance")).toBe("0");
  });

  it("throws rather than silently sending an invalid amount", () => {
    expect(() => toAccountFormData({ ...base, openingBalance: "abc" })).toThrow(/opening balance/i);
  });
});

// ---------------------------------------------------------------------------
// Editing: cents -> form string
// ---------------------------------------------------------------------------

describe("accountFormStateFromAccount", () => {
  it("puts a decimal string in the form, per the form-transport convention", () => {
    const state = accountFormStateFromAccount({
      name: "Mortgage",
      kind: "liability",
      type: "Mortgage",
      openingBalanceCents: 25000000,
      openingBalanceDate: "2020-01-01",
      currency: "USD",
    });
    expect(state.openingBalance).toBe("250000");
    expect(state.kind).toBe("liability");
  });

  it("renders 45.50 rather than 45.5-with-lost-precision", () => {
    const state = accountFormStateFromAccount({
      name: "a",
      kind: "asset",
      type: "Cash",
      openingBalanceCents: 4550,
      openingBalanceDate: "2020-01-01",
      currency: "USD",
    });
    expect(parseAmount(state.openingBalance)).toBe(4550);
  });

  it('shows a stored zero as "0", not as an empty field', () => {
    const state = accountFormStateFromAccount({
      name: "a",
      kind: "asset",
      type: "Cash",
      openingBalanceCents: 0,
      openingBalanceDate: "2020-01-01",
      currency: "USD",
    });
    expect(state.openingBalance).toBe("0");
  });

  it("surfaces an impossible legacy negative value so validation rejects it", () => {
    const state = accountFormStateFromAccount({
      name: "a",
      kind: "asset",
      type: "Checking",
      openingBalanceCents: -1234,
      openingBalanceDate: "2020-01-01",
      currency: "USD",
    });
    expect(parseAmount(state.openingBalance)).toBe(-1234);
    expect(validateAccountForm(state)).toMatchObject({ ok: false, error: expect.stringMatching(/negative/i) });
  });

  it("round-trips through validation unchanged", () => {
    const state = accountFormStateFromAccount({
      name: "Visa",
      kind: "liability",
      type: "CreditCard",
      openingBalanceCents: 123456,
      openingBalanceDate: "2020-01-01",
      currency: "EUR",
    });
    const values = ok(state);
    expect(values.name).toBe("Visa");
    expect(values.kind).toBe("liability");
    expect(values.currency).toBe("EUR");
    expect(parseAmount(opening(state))).toBe(123456);
  });
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

const row = (over: Partial<Parameters<typeof groupAccountsByKind>[0][number]>) => ({
  id: 1,
  name: "Account",
  kind: "asset" as const,
  type: "Checking",
  openingBalanceCents: 0,
  openingBalanceDate: "2020-01-01" as const,
  currency: "USD",
  archived: false,
  balanceCents: 0,
  activityCents: 0,
  owedCents: 0,
  ...over,
});

describe("groupAccountsByKind", () => {
  const rows = [
    row({ id: 1, name: "Checking", kind: "asset" }),
    row({ id: 2, name: "Visa", kind: "liability", type: "CreditCard" }),
    row({ id: 3, name: "Old Savings", kind: "asset", archived: true }),
    row({ id: 4, name: "Paid Loan", kind: "liability", type: "Loan", archived: true }),
  ];

  it("splits the two halves of the balance sheet", () => {
    const grouped = groupAccountsByKind(rows);
    expect(grouped.assets.map((a) => a.name)).toEqual(["Checking"]);
    expect(grouped.liabilities.map((a) => a.name)).toEqual(["Visa"]);
  });

  it("hides archived accounts by default", () => {
    const grouped = groupAccountsByKind(rows);
    expect(grouped.archivedCount).toBe(2);
    expect([...grouped.assets, ...grouped.liabilities].some((a) => a.archived)).toBe(false);
  });

  it("includes archived accounts on request, after the live ones", () => {
    const grouped = groupAccountsByKind(rows, { includeArchived: true });
    expect(grouped.assets.map((a) => a.name)).toEqual(["Checking", "Old Savings"]);
    expect(grouped.liabilities.map((a) => a.name)).toEqual(["Visa", "Paid Loan"]);
  });

  it("sorts alphabetically within a group, case-insensitively", () => {
    const grouped = groupAccountsByKind([
      row({ id: 1, name: "zeta" }),
      row({ id: 2, name: "Alpha" }),
      row({ id: 3, name: "beta" }),
    ]);
    expect(grouped.assets.map((a) => a.name)).toEqual(["Alpha", "beta", "zeta"]);
  });

  it("groups by KIND, not by the sign of the balance", () => {
    // An overpaid credit card has a positive balance. It is still a credit card.
    const grouped = groupAccountsByKind([
      row({ id: 1, name: "Visa", kind: "liability", type: "CreditCard", balanceCents: 5000 }),
    ]);
    expect(grouped.liabilities).toHaveLength(1);
    expect(grouped.assets).toHaveLength(0);
  });

  it("reports whether there is anything at all to show", () => {
    expect(groupAccountsByKind([]).isEmpty).toBe(true);
    expect(groupAccountsByKind(rows).isEmpty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A liability is not a negative asset
// ---------------------------------------------------------------------------

describe("describeBalance", () => {
  it("shows $600 owed on a credit card as $600, owed — never −$600", () => {
    const shown = describeBalance(
      row({ kind: "liability", type: "CreditCard", balanceCents: -60000, owedCents: 60000 }),
    );
    expect(shown.amountLabel).toBe("$600.00");
    expect(shown.amountLabel).not.toContain("-");
    expect(shown.note).toMatch(/owed/i);
    expect(shown.tone).toBe("negative");
  });

  it("shows an overpaid liability as money held, not as negative debt", () => {
    const shown = describeBalance(
      row({ kind: "liability", type: "CreditCard", balanceCents: 5000, owedCents: 0 }),
    );
    expect(shown.amountLabel).toBe("$50.00");
    expect(shown.note).toMatch(/credit/i);
    expect(shown.tone).toBe("positive");
  });

  it("shows a paid-off liability as nothing owed", () => {
    const shown = describeBalance(
      row({ kind: "liability", type: "Loan", balanceCents: 0, owedCents: 0 }),
    );
    expect(shown.amountLabel).toBe("$0.00");
    expect(shown.tone).toBe("neutral");
  });

  it("shows an asset balance as held money", () => {
    const shown = describeBalance(row({ balanceCents: 123456 }));
    expect(shown.amountLabel).toBe("$1,234.56");
    expect(shown.tone).toBe("positive");
    expect(shown.note).toBeNull();
  });

  it("flags a genuinely overdrawn asset with a leading minus", () => {
    const shown = describeBalance(row({ balanceCents: -2500 }));
    expect(shown.amountLabel).toBe("-$25.00");
    expect(shown.tone).toBe("negative");
    expect(shown.note).toMatch(/overdrawn/i);
  });

  it("uses the account's own currency", () => {
    expect(describeBalance(row({ balanceCents: 4550, currency: "EUR" })).amountLabel).toBe("€45.50");
    expect(describeBalance(row({ balanceCents: 123456, currency: "LBP" })).amountLabel).toBe(
      "LBP 1,234.56",
    );
  });

  it("throws on a non-integer balance instead of rendering a drifted number", () => {
    expect(() => describeBalance(row({ balanceCents: 45.5 }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Net-worth presentation — presentation only, never arithmetic
// ---------------------------------------------------------------------------

describe("presentNetWorth", () => {
  const totals = {
    totalAssetsCents: 1000000,
    totalLiabilitiesCents: 250000,
    netWorthCents: 750000,
    standaloneAssetsCents: 300000,
    unassignedCents: -1500,
  };

  it("formats the three headline figures", () => {
    const shown = presentNetWorth(totals);
    expect(shown.assetsLabel).toBe("$10,000.00");
    expect(shown.liabilitiesLabel).toBe("$2,500.00");
    expect(shown.netWorthLabel).toBe("$7,500.00");
  });

  it("shows liabilities as a positive amount owed", () => {
    expect(presentNetWorth(totals).liabilitiesLabel).not.toContain("-");
  });

  it("echoes deriveNetWorth's figure instead of recomputing it", () => {
    // Deliberately inconsistent input: if this component did its own subtraction
    // the label would read $7,500.00 and the two halves of the app could disagree.
    const shown = presentNetWorth({ ...totals, netWorthCents: 999 });
    expect(shown.netWorthLabel).toBe("$9.99");
  });

  it("marks a negative net worth", () => {
    const shown = presentNetWorth({ ...totals, netWorthCents: -5000 });
    expect(shown.netWorthLabel).toBe("-$50.00");
    expect(shown.isNegative).toBe(true);
    expect(presentNetWorth(totals).isNegative).toBe(false);
  });

  it("breaks out the parts that are easy to mistake for missing money", () => {
    const shown = presentNetWorth(totals);
    expect(shown.standaloneAssetsLabel).toBe("$3,000.00");
    expect(shown.unassignedLabel).toBe("-$15.00");
    expect(shown.hasUnassigned).toBe(true);
    expect(presentNetWorth({ ...totals, unassignedCents: 0 }).hasUnassigned).toBe(false);
  });

  it("uses the currency it is given", () => {
    expect(presentNetWorth(totals, "EUR").netWorthLabel).toBe("€7,500.00");
  });

  it("throws on non-integer cents rather than printing a drifted total", () => {
    expect(() => presentNetWorth({ ...totals, netWorthCents: 7500.5 })).toThrow();
  });
});

describe("currencyOf", () => {
  it("uses the single currency when every account agrees", () => {
    const shown = currencyOf([row({ currency: "EUR" }), row({ id: 2, currency: "eur" })]);
    expect(shown.currency).toBe("EUR");
    expect(shown.mixed).toBe(false);
  });

  it("flags a mixed-currency book instead of inventing an exchange rate", () => {
    const shown = currencyOf([row({ currency: "USD" }), row({ id: 2, currency: "LBP" })]);
    expect(shown.mixed).toBe(true);
    expect(shown.currencies).toEqual(["LBP", "USD"]);
  });

  it("falls back to USD with no accounts", () => {
    expect(currencyOf([])).toEqual({ currency: "USD", mixed: false, currencies: [] });
  });
});

// ---------------------------------------------------------------------------
// Copy that has to be right
// ---------------------------------------------------------------------------

describe("openingBalanceHelp", () => {
  it("explains an asset's opening balance as what was in it", () => {
    const help = openingBalanceHelp("asset");
    expect(help).toMatch(/before/i);
    expect(help).not.toMatch(/owe/i);
  });

  it("explains a liability's opening balance as what is OWED, as a positive number", () => {
    const help = openingBalanceHelp("liability");
    expect(help).toMatch(/owe/i);
    expect(help).toMatch(/positive/i);
  });
});

describe("orphanSummary", () => {
  it("says nothing needs repairing when nothing does", () => {
    const shown = orphanSummary(0);
    expect(shown.hasOrphans).toBe(false);
  });

  it("counts one orphan in the singular", () => {
    const shown = orphanSummary(1);
    expect(shown.hasOrphans).toBe(true);
    expect(shown.message).toMatch(/^1 transaction is /);
  });

  it("counts several orphans in the plural", () => {
    expect(orphanSummary(71).message).toMatch(/^71 transactions are /);
  });
});

// ---------------------------------------------------------------------------
// Structural guards
//
// The markup cannot be rendered (no jsdom), so these assert the SHAPE of the
// components — the same technique components/__tests__/error-surfacing.test.ts
// uses. They guard the two regressions this app has actually suffered: a dialog
// that reports success on failure, and a calendar day serialized through UTC.
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(PROJECT_ROOT, rel), "utf-8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

const ACCOUNT_UI = [
  "components/accounts/account-dialog.tsx",
  "components/accounts/orphan-repair-card.tsx",
  "app/(dashboard)/accounts/accounts-client.tsx",
];

describe("every accounts surface surfaces the action's error", () => {
  for (const file of ACCOUNT_UI) {
    it(`${file} inspects the returned value`, () => {
      expect(read(file)).toMatch(/"error"\s+in\s+\w+/);
    });

    it(`${file} keeps the failure in component state`, () => {
      expect(read(file)).toMatch(/set(Action|Delete)?Error\(/);
    });

    it(`${file} renders the failure in an alert region`, () => {
      expect(read(file)).toMatch(/role="alert"/);
    });
  }

  it("the dialog returns early instead of calling onSuccess() on failure", () => {
    const source = read("components/accounts/account-dialog.tsx");
    const guard = source.indexOf('"error" in result');
    const success = source.indexOf("onSuccess();");
    expect(guard).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(guard);
  });

  it("the delete confirmation stays open so a refusal can be read", () => {
    const source = read("app/(dashboard)/accounts/accounts-client.tsx");
    expect(source).toMatch(/event\.preventDefault\(\)/);
    expect(source).toMatch(/deleteAccount/);
  });
});

describe("no calendar day is serialized through UTC", () => {
  for (const file of [...ACCOUNT_UI, "app/(dashboard)/accounts/page.tsx", "components/accounts/account-form-logic.ts"]) {
    it(`${file} contains no toISOString()`, () => {
      expect(stripComments(read(file))).not.toMatch(/toISOString\(\)/);
    });
  }

  it("the accounts page renders DateKeys through lib/dates", () => {
    expect(read("app/(dashboard)/accounts/accounts-client.tsx")).toMatch(/fromDateKey/);
  });
});

describe("money is never hand-formatted in the accounts UI", () => {
  for (const file of [...ACCOUNT_UI, "components/accounts/account-group.tsx", "components/accounts/account-form-logic.ts"]) {
    it(`${file} uses formatMoney rather than toFixed(2)`, () => {
      expect(stripComments(read(file))).not.toMatch(/toFixed\(2\)/);
    });
  }
});

describe("the sidebar exposes the new routes", () => {
  // Two other agents own /recurring and /reports and are not allowed to touch
  // the sidebar, so these links are added here and must stay.
  const source = read("components/shared/sidebar.tsx");

  for (const [name, href] of [
    ["Accounts", "/accounts"],
    ["Recurring", "/recurring"],
    ["Reports", "/reports"],
  ]) {
    it(`links ${name} to ${href}`, () => {
      expect(source).toMatch(new RegExp(`name:\\s*"${name}",\\s*href:\\s*"${href}"`));
    });
  }

  it("keeps the routes that already existed", () => {
    for (const href of ["/", "/transactions", "/budgets", "/travel", "/settings"]) {
      expect(source).toMatch(new RegExp(`href:\\s*"${href}"`));
    }
  });
});
