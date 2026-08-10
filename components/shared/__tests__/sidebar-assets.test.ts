/**
 * Tests for the sidebar's net-worth panel.
 *
 * What these exist to prevent:
 *
 *  1. **Two sources of truth.** The sidebar used to group the raw `assets` rows,
 *     which include the auto-derived `Cash` asset that `deriveNetWorth`
 *     deliberately excludes — so the chrome on every page printed a figure the
 *     home page had left out, and listed no accounts at all. The property tested
 *     here is that the rows the panel draws add up to exactly the figures
 *     `getNetWorth()` supplied: same input, both paths, identical output.
 *
 *  2. **A liability rendered as a negative asset.** Every liability figure is the
 *     amount OWED, as a positive magnitude. "-$600.00" must never appear.
 *
 *  3. **A cross-currency sum.** There is no FX source in this app. A group
 *     spanning USD and LBP renders both subtotals and is flagged; it must never
 *     collapse into one "$" figure.
 *
 *  4. **Falsy zero.** A holding worth exactly 0, a quantity of exactly 0, and a
 *     group with no rows are all real states, not absent ones.
 *
 * The component itself is not tested here — there is no jsdom in this repo, which
 * is exactly why every decision lives in ../sidebar-assets.ts.
 */
import { describe, expect, it } from "vitest";

import type { AccountRow } from "@/components/accounts/account-form-logic";
import { deriveAccountBalances, deriveNetWorth } from "@/lib/cash-balance";
import { formatMoney } from "@/lib/money";
import {
  assetHoldingDetail,
  assetHoldingName,
  auditSidebarTotals,
  buildSidebarView,
  countedAssets,
  DERIVED_CASH_CATEGORY,
  type SidebarAssetRow,
  type SidebarViewInput,
} from "../sidebar-assets";

// ---------------------------------------------------------------------------
// Builders — a faithful in-process replica of the two actions the sidebar calls.
// ---------------------------------------------------------------------------

type SeedAccount = {
  id: number;
  name: string;
  kind: "asset" | "liability";
  type: string;
  openingBalanceCents?: number;
  currency?: string;
  archived?: boolean;
};

let nextAssetId = 1;

function asset(values: Partial<SidebarAssetRow> & { category: string }): SidebarAssetRow {
  return {
    id: values.id ?? nextAssetId++,
    category: values.category,
    currentValueCents: values.currentValueCents ?? 0,
    currency: values.currency ?? "USD",
    notes: values.notes ?? null,
    commodityType: values.commodityType ?? null,
    priceSymbol: values.priceSymbol ?? null,
    quantity: values.quantity ?? null,
    unit: values.unit ?? null,
  };
}

/**
 * Build the exact pair of inputs the sidebar receives — `getAccountBalances()`
 * and `getNetWorth()` — from one seed, so a disagreement between them can only
 * come from this module and not from the fixture.
 */
function inputFor(seed: {
  accounts?: SeedAccount[];
  transactions?: Array<{
    categoryId?: number | null;
    amountCents: number;
    accountId?: number | null;
    transferAccountId?: number | null;
    pending?: boolean;
  }>;
  categories?: Array<{ id: number; type: string }>;
  assets?: SidebarAssetRow[];
}): SidebarViewInput {
  const accounts = seed.accounts ?? [];
  const transactions = seed.transactions ?? [];
  const categories = seed.categories ?? [];
  const assets = seed.assets ?? [];

  const ledgerAccounts = accounts.map((a) => ({
    id: a.id,
    kind: a.kind,
    openingBalanceCents: a.openingBalanceCents ?? 0,
    currency: a.currency ?? "USD",
    archived: a.archived === true,
  }));

  // What getAccountBalances() returns: one row per account, in id order.
  const balances = deriveAccountBalances(ledgerAccounts, transactions, categories);
  const byId = new Map(
    balances.filter((b) => b.accountId !== null).map((b) => [b.accountId as number, b]),
  );
  const accountRows: AccountRow[] = accounts.map((a) => {
    const balance = byId.get(a.id);
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      type: a.type,
      openingBalanceCents: a.openingBalanceCents ?? 0,
      currency: a.currency ?? "USD",
      archived: a.archived === true,
      balanceCents: balance?.balanceCents ?? 0,
      activityCents: balance?.activityCents ?? 0,
      owedCents: balance?.owedCents ?? 0,
    };
  });

  // What getNetWorth() returns, from the same rows.
  const netWorth = deriveNetWorth({
    accounts: ledgerAccounts,
    transactions,
    categories,
    standaloneAssets: assets,
  });

  return { netWorth, accounts: accountRows, assets };
}

function groupNamed(view: ReturnType<typeof buildSidebarView>, name: string) {
  const group = view.groups.find((g) => g.name === name);
  if (!group) throw new Error(`No group named ${name}. Got: ${view.groups.map((g) => g.name)}`);
  return group;
}

// ---------------------------------------------------------------------------

describe("single source of truth", () => {
  it("prints the net worth getNetWorth() supplied, without re-deriving it", () => {
    const input = inputFor({
      accounts: [
        { id: 1, name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 500_000 },
        { id: 2, name: "Mortgage", kind: "liability", type: "Mortgage", openingBalanceCents: 25_000_000 },
      ],
      assets: [asset({ category: "Properties", currentValueCents: 30_000_000 })],
    });

    const view = buildSidebarView(input);

    expect(view.summary.netWorthLabel).toBe(formatMoney(input.netWorth.netWorthCents));
    expect(view.summary.assetsLabel).toBe(formatMoney(input.netWorth.totalAssetsCents));
    expect(view.summary.liabilitiesLabel).toBe(formatMoney(input.netWorth.totalLiabilitiesCents));
  });

  it("draws rows that add up to exactly the figures getNetWorth() supplied", () => {
    const input = inputFor({
      categories: [
        { id: 1, type: "Expense" },
        { id: 2, type: "Income" },
      ],
      accounts: [
        { id: 1, name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 500_000 },
        { id: 2, name: "Savings", kind: "asset", type: "Savings", openingBalanceCents: 1_200_000 },
        { id: 3, name: "Visa", kind: "liability", type: "CreditCard", openingBalanceCents: 60_000 },
        { id: 4, name: "Old ISA", kind: "asset", type: "Savings", openingBalanceCents: 25_000, archived: true },
      ],
      transactions: [
        { categoryId: 1, amountCents: 4_500, accountId: 1 },
        { categoryId: 2, amountCents: 300_000, accountId: 1 },
        { categoryId: 1, amountCents: 9_900, accountId: 3 },
        // Pending: counted by neither path.
        { categoryId: 1, amountCents: 100_000, accountId: 1, pending: true },
      ],
      assets: [
        asset({ category: "Commodities", currentValueCents: 210_000 }),
        asset({ category: DERIVED_CASH_CATEGORY, currentValueCents: 295_500 }),
      ],
    });

    const audited = auditSidebarTotals(input);

    expect(audited.totalAssetsCents).toBe(input.netWorth.totalAssetsCents);
    expect(audited.totalLiabilitiesCents).toBe(input.netWorth.totalLiabilitiesCents);
    expect(audited.netWorthCents).toBe(input.netWorth.netWorthCents);
    expect(audited.standaloneAssetsCents).toBe(input.netWorth.standaloneAssetsCents);
  });

  it("keeps archived accounts listed, because their balances still count", () => {
    const input = inputFor({
      accounts: [
        { id: 1, name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 100_000 },
        { id: 2, name: "Closed savings", kind: "asset", type: "Savings", openingBalanceCents: 50_000, archived: true },
      ],
    });

    const view = buildSidebarView(input);
    const accountsGroup = groupNamed(view, "Accounts");

    expect(accountsGroup.count).toBe(2);
    expect(accountsGroup.rows.map((r) => r.name)).toContain("Closed savings");
    expect(accountsGroup.rows.find((r) => r.name === "Closed savings")?.detail).toContain(
      "archived",
    );
    // Total covers both, exactly as net worth does.
    expect(accountsGroup.totalLabel).toBe(formatMoney(150_000));
    expect(auditSidebarTotals(input).netWorthCents).toBe(input.netWorth.netWorthCents);
  });

  it("surfaces the unassigned bucket instead of letting it vanish from the rows", () => {
    const input = inputFor({
      categories: [{ id: 1, type: "Income" }],
      accounts: [
        { id: 1, name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 100_000 },
      ],
      // No accountId: real money, but attached to no account row.
      transactions: [{ categoryId: 1, amountCents: 40_000, accountId: null }],
    });

    const view = buildSidebarView(input);

    expect(input.netWorth.unassignedCents).toBe(40_000);
    expect(view.summary.hasUnassigned).toBe(true);
    expect(view.summary.unassignedLabel).toBe(formatMoney(40_000));
    // The listed accounts alone do NOT cover it — which is why the panel says so.
    expect(groupNamed(view, "Accounts").totalLabel).toBe(formatMoney(100_000));
    expect(auditSidebarTotals(input).netWorthCents).toBe(input.netWorth.netWorthCents);
  });
});

describe("the derived Cash asset", () => {
  it("is not listed, so the ledger is not counted twice", () => {
    const input = inputFor({
      accounts: [
        { id: 1, name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 100_000 },
      ],
      assets: [
        // What syncCashAsset writes: the ledger, mirrored into the assets table.
        asset({ category: DERIVED_CASH_CATEGORY, currentValueCents: 100_000 }),
        asset({ category: "Savings", currentValueCents: 25_000 }),
      ],
    });

    const view = buildSidebarView(input);

    expect(view.groups.map((g) => g.name)).not.toContain(DERIVED_CASH_CATEGORY);
    expect(input.netWorth.standaloneAssetsCents).toBe(25_000);
    expect(view.summary.standaloneAssetsLabel).toBe(formatMoney(25_000));
    expect(view.summary.netWorthLabel).toBe(formatMoney(125_000));
    expect(auditSidebarTotals(input).netWorthCents).toBe(125_000);
  });

  it("is reported as excluded, rather than silently disappearing", () => {
    const view = buildSidebarView(
      inputFor({
        assets: [asset({ category: DERIVED_CASH_CATEGORY, currentValueCents: 100_000 })],
      }),
    );

    expect(view.derivedCashCount).toBe(1);
    expect(view.derivedCashLabel).toBe(formatMoney(100_000));
  });

  it("says nothing when there is no derived Cash row at all", () => {
    const view = buildSidebarView(
      inputFor({ assets: [asset({ category: "Crypto", currentValueCents: 1 })] }),
    );
    expect(view.derivedCashCount).toBe(0);
    expect(view.derivedCashLabel).toBeNull();
  });

  it("countedAssets keeps every non-Cash category, including empty-valued ones", () => {
    const rows = [
      asset({ category: DERIVED_CASH_CATEGORY, currentValueCents: 5 }),
      asset({ category: "Crypto", currentValueCents: 0 }),
    ];
    expect(countedAssets(rows).map((r) => r.category)).toEqual(["Crypto"]);
  });
});

describe("liabilities read as amounts owed", () => {
  const input = inputFor({
    accounts: [
      { id: 1, name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 500_000 },
      { id: 2, name: "Visa", kind: "liability", type: "CreditCard", openingBalanceCents: 60_000 },
      { id: 3, name: "Mortgage", kind: "liability", type: "Mortgage", openingBalanceCents: 25_000_000 },
    ],
  });

  it("shows the outstanding magnitude, never a negative asset", () => {
    const liabilities = groupNamed(buildSidebarView(input), "Liabilities");

    const visa = liabilities.rows.find((r) => r.name === "Visa");
    expect(visa?.amountLabel).toBe(formatMoney(60_000));
    expect(visa?.amountLabel).not.toContain("-");
    expect(visa?.note).toBe("owed");
    expect(visa?.tone).toBe("negative");

    for (const row of liabilities.rows) expect(row.amountLabel).not.toContain("-");
    expect(liabilities.totalLabel).toBe(formatMoney(25_060_000));
    expect(liabilities.totalLabel).not.toContain("-");
  });

  it("keeps a mortgage visible AND subtracted", () => {
    const view = buildSidebarView(input);
    expect(groupNamed(view, "Liabilities").rows.map((r) => r.name)).toContain("Mortgage");
    expect(view.summary.isNegative).toBe(true);
    expect(view.summary.netWorthLabel).toBe(formatMoney(-24_560_000));
    expect(view.summary.liabilitiesLabel).not.toContain("-");
  });

  it("groups an overpaid card by kind, owing nothing, and still balances", () => {
    const overpaid = inputFor({
      categories: [{ id: 1, type: "Income" }],
      accounts: [
        { id: 1, name: "Visa", kind: "liability", type: "CreditCard", openingBalanceCents: 10_000 },
      ],
      // Paid off, then some: the balance goes positive.
      transactions: [{ categoryId: 1, amountCents: 15_000, accountId: 1 }],
    });

    const liabilities = groupNamed(buildSidebarView(overpaid), "Liabilities");
    expect(liabilities.rows[0].name).toBe("Visa");
    expect(liabilities.rows[0].note).toBe("in credit: overpaid");
    // Owed is zero; the $50 of credit counts on the ASSET side, as deriveNetWorth does.
    expect(liabilities.totalLabel).toBe(formatMoney(0));
    expect(overpaid.netWorth.totalLiabilitiesCents).toBe(0);
    expect(auditSidebarTotals(overpaid).totalAssetsCents).toBe(
      overpaid.netWorth.totalAssetsCents,
    );
  });

  it("says a liability owes nothing rather than printing a blank", () => {
    const paidOff = inputFor({
      accounts: [
        { id: 1, name: "Loan", kind: "liability", type: "Loan", openingBalanceCents: 0 },
      ],
    });
    const row = groupNamed(buildSidebarView(paidOff), "Liabilities").rows[0];
    expect(row.amountLabel).toBe(formatMoney(0));
    expect(row.note).toBe("nothing owed");
    expect(row.tone).toBe("neutral");
  });
});

describe("currencies are never summed", () => {
  it("subtotals a mixed group per currency and flags it", () => {
    const view = buildSidebarView(
      inputFor({
        assets: [
          asset({ category: "Savings", currentValueCents: 120_000, currency: "USD" }),
          asset({ category: "Savings", currentValueCents: 50_000, currency: "LBP" }),
        ],
      }),
    );

    const savings = groupNamed(view, "Savings");
    expect(savings.mixed).toBe(true);
    expect(savings.currencies.sort()).toEqual(["LBP", "USD"]);
    expect(savings.totalLabel).toContain(" + ");
    expect(savings.totalLabel).toContain(formatMoney(120_000, "USD"));
    expect(savings.totalLabel).toContain(formatMoney(50_000, "LBP"));
    // The bug: 120000 + 50000 printed as one "$1,700.00".
    expect(savings.totalLabel).not.toBe(formatMoney(170_000, "USD"));
  });

  it("leaves a single-currency group exactly as it was", () => {
    const view = buildSidebarView(
      inputFor({
        assets: [
          asset({ category: "Crypto", currentValueCents: 120_000, currency: "USD" }),
          asset({ category: "Crypto", currentValueCents: 50_000, currency: "USD" }),
        ],
      }),
    );
    const crypto = groupNamed(view, "Crypto");
    expect(crypto.mixed).toBe(false);
    expect(crypto.totalLabel).toBe(formatMoney(170_000));
  });

  it("flags the panel as mixed when accounts and assets disagree", () => {
    const input = inputFor({
      accounts: [
        { id: 1, name: "Compte", kind: "asset", type: "Checking", currency: "EUR", openingBalanceCents: 1 },
      ],
      assets: [asset({ category: "Crypto", currentValueCents: 1, currency: "USD" })],
    });
    const view = buildSidebarView(input);
    expect(view.mixed).toBe(true);
    expect(view.currencies).toEqual(["EUR", "USD"]);
    expect(view.summaries.map((summary) => summary.currency)).toEqual(["EUR", "USD"]);

    const audited = auditSidebarTotals(input);
    expect(audited.currencyTotals).toEqual([
      {
        currency: "EUR",
        totalAssetsCents: 1,
        totalLiabilitiesCents: 0,
        netWorthCents: 1,
        standaloneAssetsCents: 0,
      },
      {
        currency: "USD",
        totalAssetsCents: 1,
        totalLiabilitiesCents: 0,
        netWorthCents: 1,
        standaloneAssetsCents: 1,
      },
    ]);
    expect(audited.netWorthCents).toBe(0);
  });

  it("labels the totals with the shared currency when there is only one", () => {
    const view = buildSidebarView(
      inputFor({
        accounts: [
          { id: 1, name: "Compte", kind: "asset", type: "Checking", currency: "EUR", openingBalanceCents: 750_000 },
        ],
      }),
    );
    expect(view.mixed).toBe(false);
    expect(view.currency).toBe("EUR");
    expect(view.summary.netWorthLabel).toBe(formatMoney(750_000, "EUR"));
    expect(groupNamed(view, "Accounts").totalLabel).toBe(formatMoney(750_000, "EUR"));
  });
});

describe("zeroes and emptiness are real states", () => {
  it("keeps the account groups present and readable when there is nothing in them", () => {
    const view = buildSidebarView(inputFor({}));

    const accounts = groupNamed(view, "Accounts");
    const liabilities = groupNamed(view, "Liabilities");

    expect(view.isEmpty).toBe(true);
    for (const group of [accounts, liabilities]) {
      expect(group.count).toBe(0);
      expect(group.rows).toEqual([]);
      // A group with no holdings is worth zero — a fact, not a blank.
      expect(group.totalLabel).toBe(formatMoney(0));
      expect(group.mixed).toBe(false);
      expect(group.emptyMessage.length).toBeGreaterThan(0);
      expect(group.href.length).toBeGreaterThan(0);
    }
    expect(view.summary.netWorthLabel).toBe(formatMoney(0));
  });

  it("lists a holding worth exactly 0 instead of dropping it", () => {
    const view = buildSidebarView(
      inputFor({
        assets: [
          asset({ category: "Crypto", currentValueCents: 0, notes: "Cold wallet" }),
          asset({ category: "Crypto", currentValueCents: 500 }),
        ],
      }),
    );

    const crypto = groupNamed(view, "Crypto");
    expect(crypto.count).toBe(2);
    const empty = crypto.rows.find((r) => r.name === "Cold wallet");
    expect(empty).toBeDefined();
    expect(empty?.amountLabel).toBe(formatMoney(0));
    expect(empty?.tone).toBe("neutral");
  });

  it("prints a quantity of exactly 0 (a falsy check would hide it)", () => {
    const row = asset({ category: "Commodities", currentValueCents: 0, quantity: 0, unit: "oz" });
    expect(assetHoldingDetail(row)).toBe("0 oz");
  });

  it("says nothing about quantity when there is none", () => {
    expect(assetHoldingDetail(asset({ category: "Properties" }))).toBeNull();
  });

  it("does not lose a zero net worth to a falsy check", () => {
    const view = buildSidebarView(
      inputFor({
        accounts: [
          { id: 1, name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 60_000 },
          { id: 2, name: "Visa", kind: "liability", type: "CreditCard", openingBalanceCents: 60_000 },
        ],
      }),
    );
    expect(view.summary.netWorthLabel).toBe(formatMoney(0));
    expect(view.summary.isNegative).toBe(false);
    expect(groupNamed(view, "Liabilities").totalLabel).toBe(formatMoney(60_000));
  });
});

describe("what an expanded row shows", () => {
  it("names a holding by its note, then its symbol, then its category", () => {
    expect(assetHoldingName(asset({ category: "Properties", notes: "  Beirut flat  " }))).toBe(
      "Beirut flat",
    );
    expect(
      assetHoldingName(asset({ category: "Commodities", commodityType: "Gold" })),
    ).toBe("Gold");
    expect(assetHoldingName(asset({ category: "Crypto", priceSymbol: "BTC" }))).toBe("BTC");
    // Never blank: a nameless row still has to be readable.
    expect(assetHoldingName(asset({ category: "Other", notes: "   " }))).toBe("Other holding");
  });

  it("uses only the first line of a multi-line note", () => {
    const row = asset({ category: "Vehicles", notes: "1998 Volvo\nbought from Rami\nneeds tyres" });
    expect(assetHoldingName(row)).toBe("1998 Volvo");
  });

  it("puts the symbol and the quantity on the detail line", () => {
    const row = asset({
      category: "Crypto",
      notes: "Ledger",
      priceSymbol: "BTC",
      quantity: 0.0345,
      unit: "coins",
    });
    expect(assetHoldingName(row)).toBe("Ledger");
    // Rendered exactly, not rounded to a "friendly" 0.03.
    expect(assetHoldingDetail(row)).toBe("BTC · 0.0345 coins");
  });

  it("does not repeat the symbol when it is already the name", () => {
    expect(assetHoldingDetail(asset({ category: "Commodities", commodityType: "Gold" }))).toBeNull();
  });

  it("shows each holding's value in its OWN currency", () => {
    const view = buildSidebarView(
      inputFor({
        assets: [
          asset({ category: "Savings", currentValueCents: 120_000, currency: "USD", notes: "A" }),
          asset({ category: "Savings", currentValueCents: 50_000, currency: "LBP", notes: "B" }),
        ],
      }),
    );
    const rows = groupNamed(view, "Savings").rows;
    expect(rows.find((r) => r.name === "A")?.amountLabel).toBe(formatMoney(120_000, "USD"));
    expect(rows.find((r) => r.name === "B")?.amountLabel).toBe(formatMoney(50_000, "LBP"));
  });

  it("labels an account with its human type and its balance", () => {
    const view = buildSidebarView(
      inputFor({
        accounts: [
          { id: 1, name: "Visa", kind: "liability", type: "CreditCard", openingBalanceCents: 60_000 },
          { id: 2, name: "Current", kind: "asset", type: "Checking", openingBalanceCents: 20_000 },
        ],
      }),
    );
    expect(groupNamed(view, "Liabilities").rows[0].detail).toBe("Credit card");
    expect(groupNamed(view, "Accounts").rows[0]).toMatchObject({
      name: "Current",
      detail: "Checking",
      amountLabel: formatMoney(20_000),
      note: null,
      tone: "positive",
    });
  });

  it("marks an overdrawn account rather than hiding the minus", () => {
    const view = buildSidebarView(
      inputFor({
        categories: [{ id: 1, type: "Expense" }],
        accounts: [
          { id: 1, name: "Current", kind: "asset", type: "Checking", openingBalanceCents: 1_000 },
        ],
        transactions: [{ categoryId: 1, amountCents: 5_000, accountId: 1 }],
      }),
    );
    const row = groupNamed(view, "Accounts").rows[0];
    expect(row.amountLabel).toBe(formatMoney(-4_000));
    expect(row.note).toBe("overdrawn");
    expect(row.tone).toBe("negative");
  });

  it("gives every row a unique, stable key", () => {
    const view = buildSidebarView(
      inputFor({
        accounts: [
          { id: 1, name: "A", kind: "asset", type: "Checking" },
          { id: 2, name: "B", kind: "liability", type: "Loan" },
        ],
        assets: [
          asset({ id: 1, category: "Crypto", currentValueCents: 1 }),
          asset({ id: 2, category: "Crypto", currentValueCents: 2 }),
        ],
      }),
    );
    const keys = view.groups.flatMap((g) => g.rows.map((r) => r.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(view.groups.map((g) => g.key)).size).toBe(view.groups.length);
  });
});

describe("group order", () => {
  it("leads with accounts, then liabilities, then asset categories by name", () => {
    const view = buildSidebarView(
      inputFor({
        assets: [
          asset({ category: "Vehicles", currentValueCents: 1 }),
          asset({ category: "Crypto", currentValueCents: 1 }),
          asset({ category: "Properties", currentValueCents: 1 }),
        ],
      }),
    );
    expect(view.groups.map((g) => g.name)).toEqual([
      "Accounts",
      "Liabilities",
      "Crypto",
      "Properties",
      "Vehicles",
    ]);
  });

  it("points each group at the page that owns its records", () => {
    const view = buildSidebarView(
      inputFor({ assets: [asset({ category: "Crypto", currentValueCents: 1 })] }),
    );
    expect(groupNamed(view, "Accounts").href).toBe("/accounts");
    expect(groupNamed(view, "Liabilities").href).toBe("/accounts");
    expect(groupNamed(view, "Crypto").href).toBe("/");
  });
});
