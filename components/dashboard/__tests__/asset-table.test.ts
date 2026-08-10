/**
 * Tests for the home page's assets table.
 *
 * What these exist to prevent:
 *
 *  1. **The original bug.** The table rendered one row per HOLDING, so two crypto
 *     holdings printed two rows both labelled "Crypto", each with its own
 *     percentage — while the allocation bar directly above them had already merged
 *     them into a single Crypto slice.
 *
 *  2. **A third grouping implementation.** The strongest test here is
 *     "the table and the bar are the same objects": every figure a category row
 *     prints must be an element of the `allocationRows()` array the bar renders,
 *     by identity — not a recomputation that happens to agree today. It must hold
 *     while filtered too.
 *
 *  3. **Double-counted cash.** Cash is now a LINE ITEM rather than a footnote, but
 *     it is sourced from the account balances, and the auto-derived `Cash` asset
 *     row — which mirrors the same ledger — is still dropped. `deriveNetWorth`'s
 *     figure must come out identical, to the cent, from the rows the table lists.
 *     That is the "net worth did not change" proof, and it is the point of the
 *     `net worth is untouched` block below.
 *
 *  4. **A believed filtered number.** Hiding a holding EXCLUDES it from the
 *     totals and the percentages, by the owner's explicit choice. So the filtered
 *     figure must always arrive with a warning that names the count, the excluded
 *     value and the real total — and the arithmetic behind net worth must not
 *     notice the filter at all.
 *
 *  5. **A cross-currency sum.** There is no FX source. A category — or a set of
 *     hidden holdings — spanning USD and EUR keeps one entry per currency and must
 *     never collapse into one "$".
 *
 *  6. **Falsy zero.** A holding worth exactly 0 is a real holding and is listed; a
 *     category totalling exactly 0 renders, and a currency totalling 0 yields "—",
 *     never "NaN%" or "Infinity%".
 *
 * The component is not tested here — there is no jsdom in this repo, which is
 * exactly why every decision lives in ../asset-table.ts.
 */
import { describe, expect, it } from "vitest";

import type { AccountRow } from "@/components/accounts/account-form-logic";
import {
  allocationRows,
  formatShare,
  type AllocationRow,
} from "@/components/assets/currency-totals";
import {
  assetHoldingDetail,
  assetHoldingName,
  countedAssets,
  DERIVED_CASH_CATEGORY,
  type SidebarAssetRow,
} from "@/components/shared/sidebar-assets";
import {
  deriveNetWorth,
  type CashLedgerCategory,
  type CashLedgerTransaction,
} from "@/lib/cash-balance";
import { formatMoney } from "@/lib/money";
import {
  ASSET_TABLE_AUTO_EXPAND_LIMIT,
  assetCategoryColor,
  auditNetWorthFromTable,
  buildAssetTable,
  CASH_CATEGORY,
  categoryHoldingKeys,
  defaultExpandedKeys,
  withHidden,
  type AssetTableInput,
} from "../asset-table";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let nextId = 1;

function asset(values: Partial<SidebarAssetRow> & { category: string }): SidebarAssetRow {
  return {
    id: values.id ?? nextId++,
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

let nextAccountId = 1;

function account(values: Partial<AccountRow> & { name: string }): AccountRow {
  const kind = values.kind ?? "asset";
  const balanceCents = values.balanceCents ?? 0;
  return {
    id: values.id ?? nextAccountId++,
    name: values.name,
    kind,
    type: values.type ?? (kind === "liability" ? "CreditCard" : "Checking"),
    openingBalanceCents: values.openingBalanceCents ?? 0,
    currency: values.currency ?? "USD",
    archived: values.archived ?? false,
    balanceCents,
    activityCents: values.activityCents ?? 0,
    owedCents:
      values.owedCents ?? (kind === "liability" && balanceCents < 0 ? -balanceCents : 0),
  };
}

/** No accounts at all — the shape most of the older assertions were written for. */
function noAccounts(): AccountRow[] {
  return [];
}

/**
 * The owner's actual portfolio: two priced crypto holdings, one priced metal, one
 * `Main` account, plus the Cash row `syncCashAsset` maintains from the ledger.
 *
 * The derived Cash row and the `Main` balance are the SAME money seen two ways —
 * which is the whole reason only one of them may be listed.
 */
const OWNER_CASH_CENTS = 4_496_18;

function ownerAssets(): SidebarAssetRow[] {
  return [
    asset({ id: 1, category: DERIVED_CASH_CATEGORY, currentValueCents: OWNER_CASH_CENTS }),
    asset({
      id: 2,
      category: "Crypto",
      currentValueCents: 99_62,
      priceSymbol: "BTC",
      quantity: 0.001537,
      unit: "coins",
    }),
    asset({
      id: 3,
      category: "Crypto",
      currentValueCents: 299_72,
      priceSymbol: "ETH",
      quantity: 0.0182,
      unit: "coins",
    }),
    asset({
      id: 4,
      category: "Commodities",
      currentValueCents: 300_00,
      commodityType: "Gold",
      priceSymbol: "XAU",
      quantity: 0.5,
      unit: "oz",
    }),
  ];
}

function ownerAccounts(): AccountRow[] {
  return [account({ id: 1, name: "Main", type: "Checking", balanceCents: OWNER_CASH_CENTS })];
}

function ownerPortfolio(): AssetTableInput<SidebarAssetRow> {
  return { assets: ownerAssets(), accounts: ownerAccounts() };
}

// ---------------------------------------------------------------------------
// Cash is a line item
// ---------------------------------------------------------------------------

describe("cash is a row in the table, not a footnote", () => {
  it("lists a Cash category built from the account balances", () => {
    const view = buildAssetTable(ownerPortfolio());

    const cash = view.categories.find((category) => category.name === CASH_CATEGORY)!;
    expect(cash).toBeDefined();
    expect(cash.totalLabel).toBe("$4,496.18");
    expect(cash.count).toBe(1);
    expect(cash.holdings[0].name).toBe("Main");
    expect(cash.holdings[0].detail).toBe("Checking");
    expect(cash.holdings[0].amountLabel).toBe("$4,496.18");
  });

  it("sits in the SAME list as Commodities and Crypto, ordered by value", () => {
    const view = buildAssetTable(ownerPortfolio());
    expect(view.categories.map((category) => category.name)).toEqual(["Cash", "Crypto", "Commodities"]);
    expect(view.visibleTotalsLabel).toBe(formatMoney(300_00 + 4_496_18 + 99_62 + 299_72));
  });

  it("the Cash line is the ACCOUNT row, so it cannot be edited or deleted as an asset", () => {
    const view = buildAssetTable(ownerPortfolio());
    const cash = view.categories.find((category) => category.name === CASH_CATEGORY)!;
    const holding = cash.holdings[0];

    expect(holding.source).toBe("account");
    // The discriminated union is what stops the Delete control from being wired
    // to an `assets` row that does not exist.
    expect(holding.asset).toBeNull();
    expect(holding.source === "account" && holding.account.id).toBe(1);
    expect(holding.key).toBe("account-1");
  });

  it("an asset holding still carries its record, so Edit and Delete survive", () => {
    const view = buildAssetTable(ownerPortfolio());
    const crypto = view.categories.find((category) => category.name === "Crypto")!;

    for (const holding of crypto.holdings) {
      expect(holding.source).toBe("asset");
      expect(holding.account).toBeNull();
      expect(holding.source === "asset" && holding.asset.id).toBeGreaterThan(0);
    }
    expect(
      crypto.holdings.map((holding) => (holding.source === "asset" ? holding.asset.id : null)),
    ).toEqual([2, 3]);
  });

  it("lists each account separately when there is more than one", () => {
    const view = buildAssetTable({
      assets: [],
      accounts: [
        account({ id: 1, name: "Main", balanceCents: 1_000_00 }),
        account({ id: 2, name: "Rainy day", type: "Savings", balanceCents: 500_00 }),
      ],
    });

    const cash = view.categories.find((category) => category.name === CASH_CATEGORY)!;
    expect(cash.collapsible).toBe(true);
    expect(cash.count).toBe(2);
    expect(cash.holdings.map((holding) => holding.name)).toEqual(["Main", "Rainy day"]);
    expect(cash.totalLabel).toBe("$1,500.00");
  });

  it("keeps archived accounts, whose balances still count towards net worth", () => {
    const view = buildAssetTable({
      assets: [],
      accounts: [account({ id: 9, name: "Old", balanceCents: 25_00, archived: true })],
    });
    const cash = view.categories.find((category) => category.name === CASH_CATEGORY)!;
    expect(cash.count).toBe(1);
    expect(cash.holdings[0].detail).toBe("Checking · archived");
    expect(cash.totalLabel).toBe("$25.00");
  });

  it("does NOT list liability accounts — a mortgage is not an asset", () => {
    const view = buildAssetTable({
      assets: [asset({ category: "Crypto", currentValueCents: 100_00 })],
      accounts: [
        account({ id: 1, name: "Main", balanceCents: 400_00 }),
        account({ id: 2, name: "Mortgage", kind: "liability", type: "Mortgage", balanceCents: -300_000_00 }),
      ],
    });

    expect(view.categories.flatMap((c) => c.holdings).map((h) => h.name)).toEqual([
      "Main",
      "Crypto holding",
    ]);
    expect(view.visibleTotalsLabel).toBe("$500.00");
    // The debt appears nowhere as a positive number.
    expect(view.visibleTotalsLabel).not.toContain("300,000");
  });

  it("an overdrawn account reads as overdrawn, via the same describeBalance everything else uses", () => {
    const view = buildAssetTable({
      assets: [],
      accounts: [account({ id: 1, name: "Main", balanceCents: -20_00 })],
    });
    const holding = view.categories[0].holdings[0];
    expect(holding.amountLabel).toBe("-$20.00");
    expect(holding.note).toBe("overdrawn");
    expect(holding.tone).toBe("negative");
  });

  it("an account with a balance of exactly 0 is a real row, not a missing one", () => {
    const view = buildAssetTable({
      assets: [asset({ category: "Crypto", currentValueCents: 100_00 })],
      accounts: [account({ id: 1, name: "Main", balanceCents: 0 })],
    });
    const cash = view.categories.find((category) => category.name === CASH_CATEGORY)!;
    expect(cash.count).toBe(1);
    expect(cash.totalLabel).toBe("$0.00");
    expect(cash.holdings[0].tone).toBe("neutral");
  });

  it("shows no Cash category at all when there are no accounts", () => {
    const view = buildAssetTable({ assets: ownerAssets(), accounts: noAccounts() });
    expect(view.categories.map((category) => category.name)).not.toContain(CASH_CATEGORY);
    expect(view.cashAccountCount).toBe(0);
    // ...and the derived row is still reported, so the UI can explain the gap.
    expect(view.derivedCashLabel).toBe("$4,496.18");
  });
});

// ---------------------------------------------------------------------------
// The derived Cash asset row is still not double-counted
// ---------------------------------------------------------------------------

describe("the derived Cash asset row", () => {
  it("is never listed — the Cash category is always account-sourced", () => {
    const view = buildAssetTable(ownerPortfolio());

    const holdings = view.categories.flatMap((category) => category.holdings);
    expect(holdings.every((holding) => holding.key !== "asset-1")).toBe(true);
    const cash = view.categories.find((category) => category.name === CASH_CATEGORY)!;
    expect(cash.holdings.every((holding) => holding.source === "account")).toBe(true);
  });

  it("is not counted twice: the Cash row is the account's figure, not the asset's", () => {
    // The two disagree on purpose here — the derived asset row is the ledger from
    // zero, the account balance includes an opening balance. Reading the wrong one
    // would be visible immediately.
    const view = buildAssetTable({
      assets: [
        asset({ id: 1, category: DERIVED_CASH_CATEGORY, currentValueCents: 812_34 }),
        asset({ id: 2, category: "Crypto", currentValueCents: 100_00 }),
      ],
      accounts: [account({ id: 1, name: "Main", balanceCents: 5_000_00 })],
    });

    const cash = view.categories.find((category) => category.name === CASH_CATEGORY)!;
    expect(cash.totalLabel).toBe("$5,000.00");
    expect(cash.count).toBe(1);
    // Neither the sum of the two (5,812.34) nor the asset row alone (812.34).
    expect(view.visibleTotalsLabel).toBe("$5,100.00");
    expect(view.visibleTotalsLabel).not.toContain("812");
    expect(view.visibleTotalsLabel).not.toContain("5,912");
  });

  it("is reported so the UI can say which of the two cash figures it is showing", () => {
    const view = buildAssetTable(ownerPortfolio());
    expect(view.derivedCashCount).toBe(1);
    expect(view.derivedCashLabel).toBe("$4,496.18");
    expect(view.cashAccountCount).toBe(1);
  });

  it("says nothing when there is no derived Cash row", () => {
    const view = buildAssetTable({
      assets: [asset({ category: "Savings", currentValueCents: 1 })],
      accounts: noAccounts(),
    });
    expect(view.derivedCashCount).toBe(0);
    expect(view.derivedCashLabel).toBeNull();
  });

  it("a portfolio of nothing but derived Cash and no accounts is EMPTY", () => {
    const view = buildAssetTable({
      assets: [asset({ category: DERIVED_CASH_CATEGORY, currentValueCents: 812_34 })],
      accounts: noAccounts(),
    });
    expect(view.isEmpty).toBe(true);
    expect(view.categories).toEqual([]);
    // ...but the user is still told where their cash went.
    expect(view.derivedCashLabel).toBe("$812.34");
  });
});

// ---------------------------------------------------------------------------
// NET WORTH IS UNTOUCHED
// ---------------------------------------------------------------------------

describe("net worth is untouched by moving cash into the list", () => {
  /**
   * A ledger with everything that could go wrong in it: an opening balance (so
   * the account balance and the derived Cash row DISAGREE), a pending row, a
   * transfer, an unassigned row and a mortgage.
   */
  const categories: CashLedgerCategory[] = [
    { id: 1, type: "Income" },
    { id: 2, type: "Expense" },
  ];

  const ledgerAccounts = [
    { id: 1, kind: "asset", openingBalanceCents: 3_000_00 },
    { id: 2, kind: "liability", openingBalanceCents: 250_000_00 },
  ];

  const transactions: CashLedgerTransaction[] = [
    { categoryId: 1, amountCents: 2_000_00, accountId: 1 },
    { categoryId: 2, amountCents: 503_82, accountId: 1 },
    { categoryId: 2, amountCents: 999_99, accountId: 1, pending: true },
    { amountCents: 100_00, accountId: 1, transferAccountId: 2 },
    { categoryId: 1, amountCents: 77_00, accountId: null },
  ];

  const standaloneAssets: SidebarAssetRow[] = [
    // The derived Cash row: the ledger from zero, ignoring the opening balance.
    asset({ id: 1, category: DERIVED_CASH_CATEGORY, currentValueCents: 2_000_00 - 503_82 }),
    asset({ id: 2, category: "Crypto", currentValueCents: 99_62 }),
    asset({ id: 3, category: "Crypto", currentValueCents: 299_72 }),
    asset({ id: 4, category: "Commodities", currentValueCents: 300_00 }),
  ];

  const netWorth = deriveNetWorth({
    accounts: ledgerAccounts,
    transactions,
    categories,
    standaloneAssets,
  });

  /** The same balances `getAccountBalances()` would hand the page. */
  function accountsFromLedger(): AccountRow[] {
    return netWorth.accounts
      .filter((row) => row.accountId !== null)
      .map((row) =>
        account({
          id: row.accountId!,
          name: row.accountId === 1 ? "Main" : "Mortgage",
          kind: row.kind,
          type: row.kind === "liability" ? "Mortgage" : "Checking",
          openingBalanceCents: row.openingBalanceCents,
          balanceCents: row.balanceCents,
          activityCents: row.activityCents,
          owedCents: row.owedCents,
        }),
      );
  }

  const input: AssetTableInput<SidebarAssetRow> = {
    assets: standaloneAssets,
    accounts: accountsFromLedger(),
  };

  it("the Cash line is exactly the account balances deriveNetWorth counted", () => {
    const audit = auditNetWorthFromTable(input, {
      unassignedCents: netWorth.unassignedCents,
    });
    const assetAccounts = netWorth.accounts.filter(
      (row) => row.accountId !== null && row.kind !== "liability",
    );
    expect(audit.cashCents).toBe(
      assetAccounts.reduce((sum, row) => sum + row.balanceCents, 0),
    );

    const view = buildAssetTable(input);
    const cash = view.categories.find((category) => category.name === CASH_CATEGORY)!;
    expect(cash.entries[0].totalCents).toBe(audit.cashCents);
    // And it is NOT the derived Cash asset row, which reads $1,496.18 here.
    expect(cash.entries[0].totalCents).toBe(4_396_18);
    expect(view.derivedCashLabel).toBe("$1,496.18");
  });

  it("the non-cash lines are exactly deriveNetWorth's standaloneAssetsCents", () => {
    const audit = auditNetWorthFromTable(input, {
      unassignedCents: netWorth.unassignedCents,
    });
    expect(audit.standaloneAssetsCents).toBe(netWorth.standaloneAssetsCents);
  });

  it("NET WORTH IS IDENTICAL TO THE CENT, rebuilt from exactly what the table lists", () => {
    const audit = auditNetWorthFromTable(input, {
      unassignedCents: netWorth.unassignedCents,
    });

    expect(audit.netWorthCents).toBe(netWorth.netWorthCents);
    expect(audit.totalAssetsCents).toBe(netWorth.totalAssetsCents);
    expect(audit.totalLiabilitiesCents).toBe(netWorth.totalLiabilitiesCents);
  });

  it("counting the derived Cash row TOO would change it — which is what is avoided", () => {
    const doubled = deriveNetWorth({
      accounts: ledgerAccounts,
      transactions,
      categories,
      standaloneAssets,
      includeCashAsset: true,
    });
    // 1,496.18 of double-counted cash. The test above proves the table does not
    // do this; this one proves the test above is capable of failing.
    expect(doubled.netWorthCents - netWorth.netWorthCents).toBe(1_496_18);
  });

  it("hiding holdings does not move net worth by a cent", () => {
    const everyKey = buildAssetTable(input)
      .categories.flatMap(categoryHoldingKeys);
    expect(everyKey.length).toBeGreaterThan(0);

    for (const hidden of [[], [everyKey[0]], everyKey]) {
      const audit = auditNetWorthFromTable({ ...input, hidden }, {
        unassignedCents: netWorth.unassignedCents,
      });
      expect(audit.netWorthCents).toBe(netWorth.netWorthCents);
      expect(audit.listedCents).toBe(
        netWorth.standaloneAssetsCents + 4_396_18,
      );
    }
  });

  it("the owner's own shape: cash moved into the list, the sum did not move", () => {
    const withoutCashListed = buildAssetTable({
      assets: ownerAssets(),
      accounts: noAccounts(),
    });
    const withCashListed = buildAssetTable(ownerPortfolio());

    // What the old table showed, unchanged...
    expect(withoutCashListed.visibleTotalsLabel).toBe("$699.34");
    // ...plus the cash it used to relegate to a footnote, and nothing else.
    expect(withCashListed.visibleTotalsLabel).toBe("$5,195.52");
    expect(300_00 + 99_62 + 299_72 + OWNER_CASH_CENTS).toBe(5_195_52);
  });
});

// ---------------------------------------------------------------------------
// The eye toggle
// ---------------------------------------------------------------------------

describe("hiding a holding excludes it from the figures", () => {
  it("reduces the visible total by EXACTLY that holding's value", () => {
    const before = buildAssetTable(ownerPortfolio());
    const btc = before.categories
      .flatMap((category) => category.holdings)
      .find((holding) => holding.name === "BTC")!;

    const after = buildAssetTable({ ...ownerPortfolio(), hidden: [btc.key] });

    expect(before.currencyTotals[0].totalCents - after.currencyTotals[0].totalCents).toBe(99_62);
    expect(after.visibleTotalsLabel).toBe(formatMoney(5_195_52 - 99_62));
  });

  it("reports the right count and the right excluded amount", () => {
    const view = buildAssetTable({ ...ownerPortfolio(), hidden: ["asset-2"] });

    expect(view.filter.active).toBe(true);
    expect(view.filter.hiddenCount).toBe(1);
    expect(view.filter.visibleCount).toBe(3);
    expect(view.filter.totalCount).toBe(4);
    expect(view.filter.hiddenTotalsLabel).toBe("$99.62");
    expect(view.filter.unfilteredTotalsLabel).toBe("$5,195.52");
    expect(view.filter.hidden.map((holding) => holding.name)).toEqual(["BTC"]);
  });

  it("the warning names the count, the excluded value AND the real total", () => {
    const view = buildAssetTable({ ...ownerPortfolio(), hidden: ["asset-2"] });

    expect(view.filter.notice).toBe(
      "Filtered view: 1 of 4 holdings hidden, worth $99.62. " +
        "The total and percentages below leave it out; your full assets total is $5,195.52.",
    );
    expect(view.filter.badgeLabel).toBe("1 hidden · $99.62 excluded");
    // The honest figure is in the sentence itself, so the filtered total beside
    // it can never be read as the owner's position.
    expect(view.filter.notice).toContain(view.filter.unfilteredTotalsLabel);
    expect(view.filter.notice).not.toBe(view.visibleTotalsLabel);
  });

  it("pluralises, and says 'them' when more than one is hidden", () => {
    const view = buildAssetTable({ ...ownerPortfolio(), hidden: ["asset-2", "asset-3"] });
    expect(view.filter.notice).toBe(
      "Filtered view: 2 of 4 holdings hidden, worth $399.34. " +
        "The total and percentages below leave them out; your full assets total is $5,195.52.",
    );
  });

  it("says NOTHING when nothing is hidden — and the two totals agree", () => {
    const view = buildAssetTable(ownerPortfolio());
    expect(view.filter.active).toBe(false);
    expect(view.filter.hiddenCount).toBe(0);
    expect(view.filter.notice).toBeNull();
    expect(view.filter.badgeLabel).toBeNull();
    expect(view.filter.hidden).toEqual([]);
    expect(view.filter.unfilteredTotalsLabel).toBe(view.visibleTotalsLabel);
  });

  it("recomputes the percentages against the VISIBLE subset", () => {
    const view = buildAssetTable({
      assets: [
        asset({ id: 10, category: "Crypto", currentValueCents: 50_00 }),
        asset({ id: 11, category: "Savings", currentValueCents: 50_00 }),
      ],
      accounts: noAccounts(),
      hidden: ["asset-11"],
    });

    // 50 of 50, not 50 of 100.
    expect(view.allocations).toHaveLength(1);
    expect(formatShare(view.allocations[0].percentage)).toBe("100.00%");
    expect(view.visibleTotalsLabel).toBe("$50.00");
  });

  it("removes a whole category once its last visible holding is hidden", () => {
    const view = buildAssetTable({ ...ownerPortfolio(), hidden: ["asset-2", "asset-3"] });
    expect(view.categories.map((category) => category.name)).toEqual(["Cash", "Commodities"]);
  });

  it("hides the cash line like any other holding", () => {
    const view = buildAssetTable({ ...ownerPortfolio(), hidden: ["account-1"] });
    expect(view.categories.map((category) => category.name)).toEqual(["Crypto", "Commodities"]);
    expect(view.visibleTotalsLabel).toBe("$699.34");
    expect(view.filter.hiddenTotalsLabel).toBe("$4,496.18");
    expect(view.filter.hidden[0].name).toBe("Main");
  });

  it("a hidden key that matches nothing is inert — it cannot invent a filter", () => {
    const view = buildAssetTable({ ...ownerPortfolio(), hidden: ["asset-999", "account-42"] });
    expect(view.filter.active).toBe(false);
    expect(view.filter.hiddenCount).toBe(0);
    expect(view.visibleTotalsLabel).toBe("$5,195.52");
  });

  it("a holding worth exactly $0.00 can be hidden, and says so honestly", () => {
    const view = buildAssetTable({
      assets: [
        asset({ id: 10, category: "Crypto", currentValueCents: 0 }),
        asset({ id: 11, category: "Savings", currentValueCents: 50_00 }),
      ],
      accounts: noAccounts(),
      hidden: ["asset-10"],
    });
    // Hiding it changes no total — and the warning still appears, because the row
    // count on screen changed and a silent filter is the thing being avoided.
    expect(view.filter.active).toBe(true);
    expect(view.filter.hiddenCount).toBe(1);
    expect(view.filter.hiddenTotalsLabel).toBe("$0.00");
    expect(view.visibleTotalsLabel).toBe("$50.00");
    expect(view.filter.unfilteredTotalsLabel).toBe("$50.00");
  });
});

describe("hiding everything", () => {
  const view = buildAssetTable({
    ...ownerPortfolio(),
    hidden: ["asset-2", "asset-3", "asset-4", "account-1"],
  });

  it("gives a $0.00 visible total, not a blank and not NaN", () => {
    expect(view.visibleTotalsLabel).toBe("$0.00");
    expect(view.currencyTotals).toEqual([]);
    expect(view.categories).toEqual([]);
  });

  it("produces no NaN% or Infinity% anywhere", () => {
    expect(view.allocations).toEqual([]);
    for (const label of [
      view.visibleTotalsLabel,
      view.filter.hiddenTotalsLabel,
      view.filter.unfilteredTotalsLabel,
      view.filter.notice ?? "",
      view.filter.badgeLabel ?? "",
    ]) {
      expect(label).not.toMatch(/NaN|Infinity|undefined/);
    }
    // And the renderer's own guards agree.
    expect(formatShare(null)).toBe("—");
  });

  it("is NOT the same thing as having no assets", () => {
    expect(view.isEmpty).toBe(false);
    expect(view.filter.allHidden).toBe(true);
    expect(view.filter.hiddenCount).toBe(4);
    expect(view.filter.unfilteredTotalsLabel).toBe("$5,195.52");
    expect(view.filter.notice).toBe(
      "Filtered view: 4 of 4 holdings hidden, worth $5,195.52. " +
        "The total and percentages below leave them out; your full assets total is $5,195.52.",
    );
  });

  it("an actually-empty portfolio is empty and not 'all hidden'", () => {
    const empty = buildAssetTable({ assets: [], accounts: [] });
    expect(empty.isEmpty).toBe(true);
    expect(empty.filter.allHidden).toBe(false);
    expect(empty.filter.active).toBe(false);
    expect(empty.visibleTotalsLabel).toBe("$0.00");
  });
});

describe("the hidden set is pure view state", () => {
  it("withHidden returns a new set and never mutates the old one", () => {
    const current = new Set(["asset-2"]);
    const next = withHidden(current, ["asset-3"], true);

    expect(next).not.toBe(current);
    expect([...current]).toEqual(["asset-2"]);
    expect([...next].sort()).toEqual(["asset-2", "asset-3"]);

    const back = withHidden(next, ["asset-2"], false);
    expect([...back]).toEqual(["asset-3"]);
    expect([...next].sort()).toEqual(["asset-2", "asset-3"]);
  });

  it("accepts an array as well as a set, so callers cannot get it wrong", () => {
    const fromArray = buildAssetTable({ ...ownerPortfolio(), hidden: ["asset-2"] });
    const fromSet = buildAssetTable({ ...ownerPortfolio(), hidden: new Set(["asset-2"]) });
    expect(fromArray.visibleTotalsLabel).toBe(fromSet.visibleTotalsLabel);
    expect(fromArray.filter.notice).toBe(fromSet.filter.notice);
  });

  it("categoryHoldingKeys is what the category-level eye hides", () => {
    const view = buildAssetTable(ownerPortfolio());
    const crypto = view.categories.find((category) => category.name === "Crypto")!;
    expect(categoryHoldingKeys(crypto)).toEqual(["asset-2", "asset-3"]);

    const after = buildAssetTable({
      ...ownerPortfolio(),
      hidden: categoryHoldingKeys(crypto),
    });
    expect(after.categories.map((category) => category.name)).not.toContain("Crypto");
    expect(after.filter.hiddenCount).toBe(2);
  });

  it("does not mutate the rows it was given", () => {
    const assets = ownerAssets();
    const accounts = ownerAccounts();
    const snapshot = JSON.stringify({ assets, accounts });

    buildAssetTable({ assets, accounts, hidden: ["asset-2", "account-1"] });

    expect(JSON.stringify({ assets, accounts })).toBe(snapshot);
  });
});

describe("a hidden holding still cannot be summed across currencies", () => {
  const input: AssetTableInput<SidebarAssetRow> = {
    assets: [
      asset({ id: 10, category: "Crypto", currentValueCents: 120_00, currency: "USD" }),
      asset({ id: 11, category: "Crypto", currentValueCents: 30_00, currency: "EUR" }),
      asset({ id: 12, category: "Savings", currentValueCents: 80_00, currency: "USD" }),
    ],
    accounts: noAccounts(),
  };

  it("reports the hidden subtotal per currency, never as one figure", () => {
    const view = buildAssetTable({ ...input, hidden: ["asset-10", "asset-11"] });

    expect(view.filter.hiddenTotalsLabel).toBe("$120.00 + €30.00");
    // $150.00 is the lie: there is no exchange rate in this app.
    expect(view.filter.hiddenTotalsLabel).not.toContain("150");
    expect(view.filter.notice).toContain("$120.00 + €30.00");
  });

  it("the unfiltered total in the warning is per currency too", () => {
    const view = buildAssetTable({ ...input, hidden: ["asset-12"] });
    expect(view.filter.unfilteredTotalsLabel).toBe("$200.00 + €30.00");
    expect(view.visibleTotalsLabel).toBe("$120.00 + €30.00");
  });

  it("hiding the last row of a currency drops that currency's track entirely", () => {
    const view = buildAssetTable({ ...input, hidden: ["asset-11"] });
    expect(view.mixed).toBe(false);
    expect(view.currencyTotals.map((total) => total.currency)).toEqual(["USD"]);
    expect(view.visibleTotalsLabel).toBe("$200.00");
    // ...and the warning still shows the currency that left.
    expect(view.filter.hiddenTotalsLabel).toBe("€30.00");
    expect(view.filter.unfilteredTotalsLabel).toBe("$200.00 + €30.00");
  });
});

// ---------------------------------------------------------------------------
// The bug: two Crypto holdings, one Crypto row
// ---------------------------------------------------------------------------

describe("grouping (the original bug)", () => {
  it("collapses two Crypto holdings into ONE category row", () => {
    const view = buildAssetTable(ownerPortfolio());

    const crypto = view.categories.filter((category) => category.name === "Crypto");
    expect(crypto).toHaveLength(1);
  });

  it("gives that row the SUM of its holdings and lists both inside", () => {
    const view = buildAssetTable(ownerPortfolio());
    const crypto = view.categories.find((category) => category.name === "Crypto")!;

    expect(crypto.entries).toHaveLength(1);
    expect(crypto.entries[0].totalCents).toBe(99_62 + 299_72);
    expect(crypto.totalLabel).toBe(formatMoney(399_34, "USD"));

    expect(crypto.count).toBe(2);
    expect(crypto.holdings.map((holding) => holding.name)).toEqual(["BTC", "ETH"]);
    expect(crypto.holdings.map((holding) => holding.amountLabel)).toEqual([
      "$99.62",
      "$299.72",
    ]);
  });

  it("keeps distinct React keys for two rows in the same category", () => {
    const view = buildAssetTable(ownerPortfolio());
    const crypto = view.categories.find((category) => category.name === "Crypto")!;
    expect(new Set(crypto.holdings.map((holding) => holding.key)).size).toBe(2);
  });

  it("labels and details holdings with the sidebar's own helpers, not a copy", () => {
    const rows = ownerAssets();
    const view = buildAssetTable({ assets: rows, accounts: ownerAccounts() });

    for (const source of countedAssets(rows)) {
      const holding = view.categories
        .flatMap((category) => category.holdings)
        .find((candidate) => candidate.key === `asset-${source.id}`)!;
      expect(holding.name).toBe(assetHoldingName(source));
      expect(holding.detail).toBe(assetHoldingDetail(source));
    }

    // Which is how a quantity reaches the screen at all: the metal is the NAME
    // ("Gold") and the weight is the detail, so the symbol is not printed twice.
    const gold = view.categories
      .flatMap((category) => category.holdings)
      .find((holding) => holding.key === "asset-4")!;
    expect([gold.name, gold.detail]).toEqual(["Gold", "0.5 oz"]);
    // A crypto holding is named by its price symbol, so the detail is the coin
    // count alone — "BTC" is not printed twice.
    const btc = view.categories
      .flatMap((category) => category.holdings)
      .find((holding) => holding.key === "asset-2")!;
    expect([btc.name, btc.detail]).toEqual(["BTC", "0.001537 coins"]);
  });
});

// ---------------------------------------------------------------------------
// The single-source-of-truth property
// ---------------------------------------------------------------------------

describe("the table and the allocation bar cannot disagree", () => {
  const portfolios: Array<[string, AssetTableInput<SidebarAssetRow>]> = [
    ["the owner's portfolio", ownerPortfolio()],
    [
      "the owner's portfolio, filtered",
      { ...ownerPortfolio(), hidden: ["asset-2", "account-1"] },
    ],
    [
      "a mixed-currency portfolio",
      {
        assets: [
          asset({ category: "Crypto", currentValueCents: 120_00, currency: "USD" }),
          asset({ category: "Crypto", currentValueCents: 30_00, currency: "EUR" }),
          asset({ category: "Savings", currentValueCents: 80_00, currency: "USD" }),
          asset({ category: "Other", currentValueCents: -5_00, currency: "LBP" }),
        ],
        accounts: [account({ name: "Main", balanceCents: 10_00, currency: "EUR" })],
      },
    ],
    [
      "a portfolio with zeros",
      {
        assets: [
          asset({ category: "Crypto", currentValueCents: 0 }),
          asset({ category: "Savings", currentValueCents: 0 }),
        ],
        accounts: [account({ name: "Main", balanceCents: 0 })],
      },
    ],
    [
      "a single holding",
      { assets: [asset({ category: "Savings", currentValueCents: 50_00 })], accounts: [] },
    ],
    ["cash only", { assets: [], accounts: [account({ name: "Main", balanceCents: 42_00 })] }],
    ["nothing at all", { assets: [], accounts: [] }],
    [
      "everything hidden",
      {
        assets: [asset({ id: 60, category: "Savings", currentValueCents: 50_00 })],
        accounts: [account({ id: 60, name: "Main", balanceCents: 42_00 })],
        hidden: ["asset-60", "account-60"],
      },
    ],
  ];

  it.each(portfolios)(
    "%s: every category figure IS an allocation row, by identity",
    (_name, input) => {
      const view = buildAssetTable(input);
      const entries = view.categories.flatMap((category) => category.entries);

      // Same population, no additions and no losses...
      expect(entries).toHaveLength(view.allocations.length);
      // ...and the very same objects, so there is no second computation that
      // could drift. `toBe`, deliberately, not `toEqual`.
      for (const entry of entries) {
        expect(view.allocations.some((allocation) => allocation === entry)).toBe(true);
      }
      for (const allocation of view.allocations) {
        expect(entries.some((entry) => entry === allocation)).toBe(true);
      }
    },
  );

  it.each(portfolios)(
    "%s: allocations are exactly allocationRows() over the VISIBLE rows",
    (_name, input) => {
      const view = buildAssetTable(input);
      const hidden = new Set(input.hidden ?? []);

      const visible = [
        ...input.accounts
          .filter((row) => row.kind !== "liability" && !hidden.has(`account-${row.id}`))
          .map((row) => ({
            category: CASH_CATEGORY,
            currency: row.currency,
            currentValueCents: row.balanceCents,
          })),
        ...countedAssets(input.assets)
          .filter((row) => !hidden.has(`asset-${row.id}`))
          .map((row) => ({
            category: row.category,
            currency: row.currency,
            currentValueCents: row.currentValueCents,
          })),
      ];

      expect(view.allocations).toEqual(allocationRows(visible));
    },
  );

  it.each(portfolios)("%s: every visible holding lands in exactly one category", (_name, input) => {
    const view = buildAssetTable(input);
    const keys = view.categories.flatMap((category) => category.holdings.map((h) => h.key));

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(view.filter.visibleCount);
    // `count` is the holdings, and the allocation entries counted the same rows.
    for (const category of view.categories) {
      expect(category.count).toBe(category.holdings.length);
      expect(category.entries.reduce((sum, entry) => sum + entry.count, 0)).toBe(
        category.holdings.length,
      );
    }
  });

  it.each(portfolios)("%s: hidden + visible is always the whole list", (_name, input) => {
    const view = buildAssetTable(input);
    expect(view.filter.hiddenCount + view.filter.visibleCount).toBe(view.filter.totalCount);
    expect(view.filter.hidden).toHaveLength(view.filter.hiddenCount);

    const unfiltered = buildAssetTable({ ...input, hidden: [] });
    expect(view.filter.totalCount).toBe(unfiltered.filter.visibleCount);
    expect(view.filter.unfilteredTotalsLabel).toBe(unfiltered.visibleTotalsLabel);
  });

  it("orders categories the way the legend above them is ordered", () => {
    const view = buildAssetTable({
      assets: [
        asset({ category: "Savings", currentValueCents: 10_00 }),
        asset({ category: "Crypto", currentValueCents: 900_00 }),
        asset({ category: "Commodities", currentValueCents: 400_00 }),
      ],
      accounts: [account({ name: "Main", balanceCents: 600_00 })],
    });

    const firstAppearance: string[] = [];
    for (const allocation of view.allocations) {
      if (!firstAppearance.includes(allocation.type)) firstAppearance.push(allocation.type);
    }
    expect(view.categories.map((category) => category.name)).toEqual(firstAppearance);
    expect(firstAppearance).toEqual(["Crypto", "Cash", "Commodities", "Savings"]);
  });

  it("shares the bar's colours, so a row and its slice match", () => {
    expect(assetCategoryColor("Crypto")).toBe("#ff57eb");
    expect(assetCategoryColor(CASH_CATEGORY)).toBe("hsl(var(--chart-1))");
    // An unknown category still gets a colour rather than `undefined`.
    expect(assetCategoryColor("Something New")).toBe("hsl(var(--muted))");
  });
});

// ---------------------------------------------------------------------------
// No FX
// ---------------------------------------------------------------------------

describe("mixed currencies are never summed", () => {
  const input: AssetTableInput<SidebarAssetRow> = {
    assets: [
      asset({ category: "Crypto", currentValueCents: 120_00, currency: "USD" }),
      asset({ category: "Crypto", currentValueCents: 30_00, currency: "EUR" }),
      asset({ category: "Savings", currentValueCents: 80_00, currency: "USD" }),
    ],
    accounts: noAccounts(),
  };

  it("keeps one entry per currency inside a mixed category", () => {
    const view = buildAssetTable(input);
    const crypto = view.categories.find((category) => category.name === "Crypto")!;

    expect(crypto.mixed).toBe(true);
    expect(crypto.currencies).toEqual(["USD", "EUR"]);
    expect(crypto.entries.map((entry) => entry.totalCents)).toEqual([120_00, 30_00]);
  });

  it("renders both subtotals rather than one '$' figure", () => {
    const view = buildAssetTable(input);
    const crypto = view.categories.find((category) => category.name === "Crypto")!;

    expect(crypto.totalLabel).toBe("$120.00 + €30.00");
    // The combined figure — $150.00 — is the lie this prevents, and there is no
    // field on the category that could carry it.
    expect(crypto.totalLabel).not.toContain("150");
    expect(crypto).not.toHaveProperty("totalCents");
  });

  it("gives each currency its own share, taken against its own total", () => {
    const view = buildAssetTable(input);
    const crypto = view.categories.find((category) => category.name === "Crypto")!;

    // $120 of $200 held in USD, and €30 of €30 held in EUR. 75% (150/200) — the
    // cross-currency answer — appears nowhere.
    expect(crypto.entries.map((entry) => formatShare(entry.percentage))).toEqual([
      "60.00%",
      "100.00%",
    ]);
  });

  it("flags the section as mixed and subtotals the header per currency", () => {
    const view = buildAssetTable(input);
    expect(view.mixed).toBe(true);
    expect(view.visibleTotalsLabel).toBe("$200.00 + €30.00");
    expect(view.currencyTotals.map((total) => total.currency)).toEqual(["USD", "EUR"]);
  });

  it("a foreign-currency ACCOUNT does not get summed into the dollar total either", () => {
    const view = buildAssetTable({
      assets: [asset({ category: "Crypto", currentValueCents: 100_00, currency: "USD" })],
      accounts: [account({ name: "Beirut", balanceCents: 500_00, currency: "LBP" })],
    });
    expect(view.visibleTotalsLabel).toBe("LBP 500.00 + $100.00");
    expect(view.mixed).toBe(true);
  });

  it("a single-currency portfolio is not flagged", () => {
    const view = buildAssetTable(ownerPortfolio());
    expect(view.mixed).toBe(false);
    expect(view.visibleTotalsLabel).toBe("$5,195.52");
    expect(view.categories.every((category) => category.mixed === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Zero is a value
// ---------------------------------------------------------------------------

describe("zero is a real value, not an absent one", () => {
  it("lists a holding worth exactly $0.00", () => {
    const view = buildAssetTable({
      assets: [
        asset({ id: 10, category: "Crypto", currentValueCents: 0, priceSymbol: "ETH" }),
        asset({ id: 11, category: "Crypto", currentValueCents: 500_00, priceSymbol: "BTC" }),
      ],
      accounts: noAccounts(),
    });
    const crypto = view.categories.find((category) => category.name === "Crypto")!;

    expect(crypto.count).toBe(2);
    const zero = crypto.holdings.find((holding) => holding.key === "asset-10")!;
    expect(zero.amountLabel).toBe("$0.00");
    // Neither a gain nor a loss.
    expect(zero.tone).toBe("neutral");
  });

  it("renders a category totalling exactly 0 alongside one that does not", () => {
    const view = buildAssetTable({
      assets: [
        asset({ category: "Crypto", currentValueCents: 0 }),
        asset({ category: "Savings", currentValueCents: 500_00 }),
      ],
      accounts: noAccounts(),
    });
    const crypto = view.categories.find((category) => category.name === "Crypto")!;

    expect(crypto.totalLabel).toBe("$0.00");
    expect(crypto.entries[0].totalCents).toBe(0);
    expect(formatShare(crypto.entries[0].percentage)).toBe("0.00%");
  });

  it("a category of +100 and -100 nets to 0 and still renders", () => {
    const view = buildAssetTable({
      assets: [
        asset({ category: "Other", currentValueCents: 100_00 }),
        asset({ category: "Other", currentValueCents: -100_00 }),
        asset({ category: "Savings", currentValueCents: 50_00 }),
      ],
      accounts: noAccounts(),
    });
    const other = view.categories.find((category) => category.name === "Other")!;

    expect(other.count).toBe(2);
    expect(other.totalLabel).toBe("$0.00");
    expect(other.entries[0].totalCents).toBe(0);
  });

  it("never prints NaN% or Infinity when a currency's total is 0", () => {
    const view = buildAssetTable({
      assets: [
        asset({ category: "Crypto", currentValueCents: 0 }),
        asset({ category: "Savings", currentValueCents: 0 }),
      ],
      accounts: noAccounts(),
    });

    expect(view.categories).toHaveLength(2);
    for (const category of view.categories) {
      expect(category.totalLabel).toBe("$0.00");
      for (const entry of category.entries) {
        // A share of nothing is undefined, not 0% — the caller renders "—".
        expect(entry.percentage).toBeNull();
        const label = formatShare(entry.percentage);
        expect(label).toBe("—");
        expect(label).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it("a zero-total category still keeps its holdings and their controls", () => {
    const view = buildAssetTable({
      assets: [
        asset({ id: 20, category: "Other", currentValueCents: 100_00 }),
        asset({ id: 21, category: "Other", currentValueCents: -100_00 }),
      ],
      accounts: noAccounts(),
    });
    const other = view.categories.find((category) => category.name === "Other")!;
    expect(other.holdings.map((holding) => holding.key)).toEqual(["asset-20", "asset-21"]);
    expect(other.holdings.every((holding) => holding.source === "asset")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One holding: no pointless nesting
// ---------------------------------------------------------------------------

describe("a category with a single holding", () => {
  it("is not collapsible — a disclosure hiding one line is pointless nesting", () => {
    const view = buildAssetTable(ownerPortfolio());
    const commodities = view.categories.find((category) => category.name === "Commodities")!;

    expect(commodities.count).toBe(1);
    expect(commodities.collapsible).toBe(false);
    expect(commodities.defaultExpanded).toBe(false);
  });

  it("carries its holding inline, so Edit and Delete stay one click away", () => {
    const view = buildAssetTable(ownerPortfolio());
    const commodities = view.categories.find((category) => category.name === "Commodities")!;

    expect(commodities.inlineHolding).not.toBeNull();
    expect(commodities.inlineHolding!.key).toBe("asset-4");
    expect(commodities.inlineHolding!.name).toBe("Gold");
    expect(commodities.inlineHolding!.detail).toBe("0.5 oz");
    expect(commodities.inlineHolding).toBe(commodities.holdings[0]);
  });

  it("the owner's single account renders inline as 'Cash / Main'", () => {
    const view = buildAssetTable(ownerPortfolio());
    const cash = view.categories.find((category) => category.name === CASH_CATEGORY)!;

    expect(cash.collapsible).toBe(false);
    expect(cash.inlineHolding).not.toBeNull();
    expect([cash.name, cash.inlineHolding!.name]).toEqual(["Cash", "Main"]);
  });

  it("a category with two holdings IS collapsible and has no inline holding", () => {
    const view = buildAssetTable(ownerPortfolio());
    const crypto = view.categories.find((category) => category.name === "Crypto")!;

    expect(crypto.collapsible).toBe(true);
    expect(crypto.inlineHolding).toBeNull();
  });

  it("is never in the expanded set — it has no control to expand", () => {
    const view = buildAssetTable(ownerPortfolio());
    expect([...defaultExpandedKeys(view)]).toEqual(["category:Crypto"]);
  });

  it("a category becomes inline once hiding leaves it one holding", () => {
    const view = buildAssetTable({ ...ownerPortfolio(), hidden: ["asset-3"] });
    const crypto = view.categories.find((category) => category.name === "Crypto")!;
    expect(crypto.collapsible).toBe(false);
    expect(crypto.inlineHolding!.name).toBe("BTC");
  });
});

// ---------------------------------------------------------------------------
// Default expansion
// ---------------------------------------------------------------------------

describe("default expansion", () => {
  function manyHoldings(count: number, category = "Crypto"): SidebarAssetRow[] {
    return Array.from({ length: count }, (_, i) =>
      asset({ category, currentValueCents: (i + 1) * 100, priceSymbol: "BTC" }),
    );
  }

  it("expands every collapsible category while the table is small", () => {
    const view = buildAssetTable(ownerPortfolio());
    const crypto = view.categories.find((category) => category.name === "Crypto")!;
    expect(crypto.defaultExpanded).toBe(true);
  });

  it("still expands at exactly the limit", () => {
    const view = buildAssetTable({
      assets: manyHoldings(ASSET_TABLE_AUTO_EXPAND_LIMIT),
      accounts: noAccounts(),
    });
    expect(view.categories[0].defaultExpanded).toBe(true);
  });

  it("collapses once the table grows past it", () => {
    const view = buildAssetTable({
      assets: manyHoldings(ASSET_TABLE_AUTO_EXPAND_LIMIT + 1),
      accounts: noAccounts(),
    });
    expect(view.categories[0].collapsible).toBe(true);
    expect(view.categories[0].defaultExpanded).toBe(false);
    expect(defaultExpandedKeys(view).size).toBe(0);
  });

  it("counts holdings worth 0 towards the limit — they take a row like any other", () => {
    const view = buildAssetTable({
      assets: [
        ...manyHoldings(ASSET_TABLE_AUTO_EXPAND_LIMIT, "Crypto"),
        asset({ category: "Savings", currentValueCents: 0 }),
      ],
      accounts: noAccounts(),
    });
    expect(view.categories.every((category) => category.defaultExpanded === false)).toBe(true);
  });

  it("counts a cash account towards the limit — it takes a row too", () => {
    const view = buildAssetTable({
      assets: manyHoldings(ASSET_TABLE_AUTO_EXPAND_LIMIT, "Crypto"),
      accounts: [account({ name: "Main", balanceCents: 10_00 })],
    });
    expect(view.categories.every((category) => category.defaultExpanded === false)).toBe(true);
  });

  it("does not count the derived Cash asset row, which takes no row at all", () => {
    const view = buildAssetTable({
      assets: [
        ...manyHoldings(ASSET_TABLE_AUTO_EXPAND_LIMIT, "Crypto"),
        asset({ category: DERIVED_CASH_CATEGORY, currentValueCents: 900_00 }),
      ],
      accounts: noAccounts(),
    });
    expect(view.categories[0].defaultExpanded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The whole table, for the owner's actual data
// ---------------------------------------------------------------------------

describe("the owner's portfolio, row by row", () => {
  it("reads as three category rows, one of them expanding into two holdings", () => {
    const view = buildAssetTable(ownerPortfolio());

    const shape = view.categories.map((category) => ({
      name: category.name,
      total: category.totalLabel,
      share: category.entries.map((entry: AllocationRow) => formatShare(entry.percentage)),
      collapsible: category.collapsible,
      holdings: category.holdings.map((holding) => [holding.name, holding.amountLabel]),
    }));

    expect(shape).toEqual([
      {
        name: "Cash",
        total: "$4,496.18",
        share: ["86.54%"],
        collapsible: false,
        holdings: [["Main", "$4,496.18"]],
      },
      {
        name: "Crypto",
        total: "$399.34",
        share: ["7.69%"],
        collapsible: true,
        holdings: [
          ["BTC", "$99.62"],
          ["ETH", "$299.72"],
        ],
      },
      {
        name: "Commodities",
        total: "$300.00",
        share: ["5.77%"],
        collapsible: false,
        holdings: [["Gold", "$300.00"]],
      },
    ]);
  });

  it("the three category shares add to 100% of the one currency held", () => {
    const view = buildAssetTable(ownerPortfolio());
    const total = view.allocations.reduce((sum, entry) => sum + (entry.percentage ?? 0), 0);
    expect(total).toBeCloseTo(100, 10);
  });

  it("still adds to 100% of what remains once something is hidden", () => {
    const view = buildAssetTable({ ...ownerPortfolio(), hidden: ["account-1"] });
    const total = view.allocations.reduce((sum, entry) => sum + (entry.percentage ?? 0), 0);
    expect(total).toBeCloseTo(100, 10);
    expect(view.visibleTotalsLabel).toBe("$699.34");
  });
});
