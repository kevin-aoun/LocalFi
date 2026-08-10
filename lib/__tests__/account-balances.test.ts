/**
 * Per-account balances, transfers and net worth.
 *
 * The three properties that must never break:
 *   1. A transfer between two of your own accounts is NET-NEUTRAL to net worth.
 *   2. A liability account SUBTRACTS from net worth, and an expense charged to it
 *      increases the debt rather than shrinking a cash pile.
 *   3. The opening balance is part of the balance, so a user who imports only
 *      last month's transactions is not permanently negative.
 *
 * lib/__tests__/cash-balance.test.ts still pins the legacy whole-ledger figure;
 * this file pins the account-aware rules that were added around it.
 */
import { describe, expect, it } from "vitest";
import {
  deriveAccountBalances,
  deriveCashBalanceCents,
  deriveNetWorth,
  isTransfer,
  type LedgerAccount,
} from "@/lib/cash-balance";

const CATEGORIES = [
  { id: 1, type: "Income" },
  { id: 2, type: "Expense" },
  { id: 3, type: "Investment" },
];

const checking: LedgerAccount = { id: 10, kind: "asset", openingBalanceCents: 0 };
const savings: LedgerAccount = { id: 11, kind: "asset", openingBalanceCents: 0 };
/** A credit card owing $500 at inception. Liability openings are MAGNITUDES. */
const card: LedgerAccount = { id: 20, kind: "liability", openingBalanceCents: 50_000 };

function balanceOf(balances: ReturnType<typeof deriveAccountBalances>, accountId: number | null) {
  const found = balances.find((b) => b.accountId === accountId);
  if (!found) throw new Error(`no balance row for account ${String(accountId)}`);
  return found;
}

describe("isTransfer", () => {
  it("is true exactly when a destination account is set", () => {
    expect(isTransfer({ amountCents: 100, accountId: 10, transferAccountId: 11 })).toBe(true);
    expect(isTransfer({ amountCents: 100, accountId: 10, transferAccountId: null })).toBe(false);
    expect(isTransfer({ amountCents: 100, categoryId: 2 })).toBe(false);
  });

  it("uses stored direction instead of a later transfer-link interpretation", () => {
    expect(isTransfer({ amountCents: 100, direction: "transfer", transferAccountId: 11 })).toBe(true);
    expect(isTransfer({ amountCents: 100, direction: "outflow", transferAccountId: 11 })).toBe(false);
  });
});

describe("deriveAccountBalances — opening balance", () => {
  it("uses the opening balance as the starting point for an asset account", () => {
    const balances = deriveAccountBalances([{ ...checking, openingBalanceCents: 250_000 }], [], CATEGORIES);
    expect(balanceOf(balances, 10).balanceCents).toBe(250_000);
    expect(balanceOf(balances, 10).activityCents).toBe(0);
  });

  it("keeps a partially-imported ledger out of the red", () => {
    // $2,500 opening, then only this month's spending was imported.
    const balances = deriveAccountBalances(
      [{ ...checking, openingBalanceCents: 250_000 }],
      [{ categoryId: 2, amountCents: 30_000, accountId: 10 }],
      CATEGORIES,
    );
    expect(balanceOf(balances, 10).balanceCents).toBe(220_000);
  });

  it("reads a liability opening balance as a DEBT, not a credit", () => {
    const balances = deriveAccountBalances([card], [], CATEGORIES);
    expect(balanceOf(balances, 20).balanceCents).toBe(-50_000);
    expect(balanceOf(balances, 20).owedCents).toBe(50_000);
  });

  it("excludes an opening balance before its effective day", () => {
    const account = {
      ...checking,
      openingBalanceCents: 250_000,
      openingBalanceDate: "2026-03-10" as const,
    };
    expect(
      balanceOf(
        deriveAccountBalances([account], [], CATEGORIES, { asOfKey: "2026-03-09" }),
        10,
      ).balanceCents,
    ).toBe(0);
    expect(
      balanceOf(
        deriveAccountBalances([account], [], CATEGORIES, { asOfKey: "2026-03-10" }),
        10,
      ).balanceCents,
    ).toBe(250_000);
  });
});

describe("deriveAccountBalances — ledger activity", () => {
  it("adds Income and subtracts Expense and Investment, per account", () => {
    const balances = deriveAccountBalances(
      [checking, savings],
      [
        { categoryId: 1, amountCents: 500_000, accountId: 10 },
        { categoryId: 2, amountCents: 12_050, accountId: 10 },
        { categoryId: 3, amountCents: 10_000, accountId: 11 },
      ],
      CATEGORIES,
    );
    expect(balanceOf(balances, 10).balanceCents).toBe(500_000 - 12_050);
    expect(balanceOf(balances, 11).balanceCents).toBe(-10_000);
  });

  it("ignores pending transactions", () => {
    const balances = deriveAccountBalances(
      [checking],
      [
        { categoryId: 1, amountCents: 100_000, accountId: 10 },
        { categoryId: 2, amountCents: 5_000, accountId: 10, pending: true },
      ],
      CATEGORIES,
    );
    expect(balanceOf(balances, 10).balanceCents).toBe(100_000);
  });

  it("ignores a transaction whose category no longer exists", () => {
    const balances = deriveAccountBalances(
      [checking],
      [
        { categoryId: 1, amountCents: 100_000, accountId: 10 },
        { categoryId: 999, amountCents: 5_000, accountId: 10 },
        { categoryId: null, amountCents: 7_000, accountId: 10 },
      ],
      CATEGORIES,
    );
    expect(balanceOf(balances, 10).balanceCents).toBe(100_000);
  });

  it("charges an expense on a credit card to the DEBT", () => {
    const balances = deriveAccountBalances(
      [card],
      [{ categoryId: 2, amountCents: 10_000, accountId: 20 }],
      CATEGORIES,
    );
    expect(balanceOf(balances, 20).balanceCents).toBe(-60_000);
    expect(balanceOf(balances, 20).owedCents).toBe(60_000);
  });

  it("puts transactions with no account into an unassigned bucket rather than dropping them", () => {
    const balances = deriveAccountBalances(
      [checking],
      [
        { categoryId: 1, amountCents: 100_000, accountId: 10 },
        { categoryId: 2, amountCents: 2_500, accountId: null },
      ],
      CATEGORIES,
    );
    expect(balanceOf(balances, 10).balanceCents).toBe(100_000);
    expect(balanceOf(balances, null).balanceCents).toBe(-2_500);
  });

  it("puts a transaction pointing at a missing account into the unassigned bucket", () => {
    const balances = deriveAccountBalances(
      [checking],
      [{ categoryId: 2, amountCents: 2_500, accountId: 777 }],
      CATEGORIES,
    );
    expect(balanceOf(balances, null).balanceCents).toBe(-2_500);
  });

  it("emits a zero row for an account with no activity", () => {
    const balances = deriveAccountBalances([checking, savings], [], CATEGORIES);
    expect(balances.map((b) => b.accountId)).toEqual([10, 11]);
    expect(balances.every((b) => b.balanceCents === 0)).toBe(true);
  });

  it("rejects a float amount instead of silently drifting", () => {
    expect(() =>
      deriveAccountBalances([checking], [{ categoryId: 1, amountCents: 45.5, accountId: 10 }], CATEGORIES),
    ).toThrow(/integer number of cents/);
  });

  it("rejects a float opening balance", () => {
    expect(() =>
      deriveAccountBalances([{ ...checking, openingBalanceCents: 12.34 }], [], CATEGORIES),
    ).toThrow(/integer number of cents/);
  });

  it("rejects negative transaction and opening magnitudes", () => {
    expect(() =>
      deriveAccountBalances([checking], [{ direction: "outflow", amountCents: -1 }], CATEGORIES),
    ).toThrow(/non-negative magnitude/i);
    expect(() =>
      deriveAccountBalances([{ ...checking, openingBalanceCents: -1 }], [], CATEGORIES),
    ).toThrow(/non-negative magnitude/i);
  });

  it("keeps stored direction after category metadata changes", () => {
    const transaction = { categoryId: 1, amountCents: 10_000, accountId: 10, direction: "inflow" as const };
    const changedCategories = [{ id: 1, type: "Expense" }];
    expect(balanceOf(deriveAccountBalances([checking], [transaction], changedCategories), 10).balanceCents)
      .toBe(10_000);
    expect(deriveCashBalanceCents([transaction], changedCategories)).toBe(10_000);
  });
});

describe("deriveAccountBalances — transfers", () => {
  const transfer = { amountCents: 25_000, accountId: 10, transferAccountId: 11, categoryId: null };

  it("debits the source and credits the destination", () => {
    const balances = deriveAccountBalances(
      [
        { ...checking, openingBalanceCents: 100_000 },
        { ...savings, openingBalanceCents: 0 },
      ],
      [transfer],
      CATEGORIES,
    );
    expect(balanceOf(balances, 10).balanceCents).toBe(75_000);
    expect(balanceOf(balances, 11).balanceCents).toBe(25_000);
  });

  it("is net-neutral across the two accounts", () => {
    const balances = deriveAccountBalances(
      [{ ...checking, openingBalanceCents: 100_000 }, savings],
      [transfer],
      CATEGORIES,
    );
    const total = balances.reduce((sum, b) => sum + b.balanceCents, 0);
    expect(total).toBe(100_000);
  });

  it("ignores any category on a transfer row — a transfer is never income or expense", () => {
    const withCategory = { ...transfer, categoryId: 2 };
    const balances = deriveAccountBalances(
      [{ ...checking, openingBalanceCents: 100_000 }, savings],
      [withCategory],
      CATEGORIES,
    );
    expect(balanceOf(balances, 10).balanceCents).toBe(75_000);
    expect(balanceOf(balances, 11).balanceCents).toBe(25_000);
  });

  it("ignores a pending transfer", () => {
    const balances = deriveAccountBalances(
      [{ ...checking, openingBalanceCents: 100_000 }, savings],
      [{ ...transfer, pending: true }],
      CATEGORIES,
    );
    expect(balanceOf(balances, 10).balanceCents).toBe(100_000);
    expect(balanceOf(balances, 11).balanceCents).toBe(0);
  });

  it("reduces a credit-card debt when cash is transferred to it", () => {
    const balances = deriveAccountBalances(
      [{ ...checking, openingBalanceCents: 100_000 }, card],
      [{ amountCents: 20_000, accountId: 10, transferAccountId: 20, categoryId: null }],
      CATEGORIES,
    );
    expect(balanceOf(balances, 10).balanceCents).toBe(80_000);
    expect(balanceOf(balances, 20).owedCents).toBe(30_000);
  });
});

describe("deriveNetWorth", () => {
  it("returns exact currency buckets and no mixed aggregate", () => {
    const result = deriveNetWorth({
      accounts: [
        { ...checking, openingBalanceCents: 500_000, currency: "USD" },
        { ...savings, openingBalanceCents: 200_000, currency: "EUR" },
      ],
      transactions: [],
      categories: CATEGORIES,
      standaloneAssets: [
        { category: "Crypto", currentValueCents: 50_000, currency: "USD" },
        { category: "Properties", currentValueCents: 25_000, currency: "EUR" },
      ],
    });

    expect(result.currencyTotals).toEqual([
      {
        currency: "EUR",
        totalAssetsCents: 225_000,
        totalLiabilitiesCents: 0,
        netWorthCents: 225_000,
        standaloneAssetsCents: 25_000,
        unbackedAssetsCents: 0,
        unassignedCents: 0,
      },
      {
        currency: "USD",
        totalAssetsCents: 550_000,
        totalLiabilitiesCents: 0,
        netWorthCents: 550_000,
        standaloneAssetsCents: 50_000,
        unbackedAssetsCents: 0,
        unassignedCents: 0,
      },
    ]);
    expect(result.aggregate).toBeNull();
    expect(result.aggregateCurrency).toBeNull();
    // Compatibility fields are a refusal sentinel, never 775_000.
    expect(result.netWorthCents).toBe(0);
  });

  it("omits archived holdings from current buckets without deleting the row", () => {
    const result = deriveNetWorth({
      accounts: [],
      transactions: [],
      categories: CATEGORIES,
      standaloneAssets: [
        { category: "Crypto", currentValueCents: 10_000, currency: "USD", archived: true },
        { category: "Crypto", currentValueCents: 20_000, currency: "USD", archived: false },
      ],
    });
    expect(result.aggregate?.netWorthCents).toBe(20_000);
  });

  it("subtracts liability accounts from asset accounts", () => {
    const result = deriveNetWorth({
      accounts: [{ ...checking, openingBalanceCents: 500_000 }, card],
      transactions: [],
      categories: CATEGORIES,
    });
    expect(result.totalAssetsCents).toBe(500_000);
    expect(result.totalLiabilitiesCents).toBe(50_000);
    expect(result.netWorthCents).toBe(450_000);
  });

  it("adds standalone assets that are not accounts", () => {
    const result = deriveNetWorth({
      accounts: [{ ...checking, openingBalanceCents: 500_000 }],
      transactions: [],
      categories: CATEGORIES,
      standaloneAssets: [
        { category: "Commodities", currentValueCents: 532_371 },
        { category: "Crypto", currentValueCents: 7_000 },
      ],
    });
    expect(result.standaloneAssetsCents).toBe(539_371);
    expect(result.totalAssetsCents).toBe(500_000 + 539_371);
    expect(result.netWorthCents).toBe(1_039_371);
  });

  it("excludes the derived Cash asset so it is not double-counted against the accounts", () => {
    const result = deriveNetWorth({
      accounts: [{ ...checking, openingBalanceCents: 449_618 }],
      transactions: [],
      categories: CATEGORIES,
      standaloneAssets: [
        { category: "Cash", currentValueCents: 449_618 },
        { category: "Crypto", currentValueCents: 7_000 },
      ],
    });
    expect(result.standaloneAssetsCents).toBe(7_000);
    expect(result.totalAssetsCents).toBe(456_618);
  });

  it("is unchanged by a transfer between two accounts", () => {
    const accounts = [{ ...checking, openingBalanceCents: 500_000 }, savings, card];
    const before = deriveNetWorth({ accounts, transactions: [], categories: CATEGORIES });
    const after = deriveNetWorth({
      accounts,
      transactions: [
        { amountCents: 120_000, accountId: 10, transferAccountId: 11, categoryId: null },
        { amountCents: 30_000, accountId: 11, transferAccountId: 20, categoryId: null },
      ],
      categories: CATEGORIES,
    });
    expect(after.netWorthCents).toBe(before.netWorthCents);
    expect(after.totalAssetsCents - after.totalLiabilitiesCents).toBe(before.netWorthCents);
  });

  it("classifies an overdrawn asset account as a liability by current sign", () => {
    const result = deriveNetWorth({
      accounts: [checking],
      transactions: [{ categoryId: 2, amountCents: 5_000, accountId: 10 }],
      categories: CATEGORIES,
    });
    expect(result.totalAssetsCents).toBe(0);
    expect(result.totalLiabilitiesCents).toBe(5_000);
    expect(result.netWorthCents).toBe(-5_000);
  });

  it("counts an OVERPAID credit card as an asset, not a negative liability", () => {
    const result = deriveNetWorth({
      accounts: [{ ...card, openingBalanceCents: 10_000 }],
      transactions: [{ amountCents: 15_000, accountId: null, transferAccountId: 20, categoryId: null }],
      categories: CATEGORIES,
    });
    // Owed 100.00, paid 150.00 -> the card holds 50.00 of your money, and the
    // 150.00 came out of the unassigned bucket.
    expect(result.totalLiabilitiesCents).toBe(0);
    expect(result.accounts[0].balanceCents).toBe(5_000);
    expect(result.unassignedCents).toBe(-15_000);
    expect(result.netWorthCents).toBe(5_000 - 15_000);
  });

  it("includes the unassigned bucket in total assets so no money vanishes", () => {
    const result = deriveNetWorth({
      accounts: [checking],
      transactions: [{ categoryId: 1, amountCents: 100_000, accountId: null }],
      categories: CATEGORIES,
    });
    expect(result.unassignedCents).toBe(100_000);
    expect(result.totalAssetsCents).toBe(100_000);
    expect(result.netWorthCents).toBe(100_000);
  });

  it("reconciles: net worth equals the sum of every signed account balance plus standalone assets", () => {
    const result = deriveNetWorth({
      accounts: [{ ...checking, openingBalanceCents: 380_000 }, { ...savings, openingBalanceCents: 1_200_000 }, card],
      transactions: [
        { categoryId: 1, amountCents: 250_000, accountId: 10 },
        { categoryId: 2, amountCents: 43_704, accountId: 10 },
        { categoryId: 2, amountCents: 9_999, accountId: 20 },
        { amountCents: 100_000, accountId: 10, transferAccountId: 11, categoryId: null },
      ],
      categories: CATEGORIES,
      standaloneAssets: [{ category: "Properties", currentValueCents: 25_000_000 }],
    });
    const signedSum = result.accounts.reduce((sum, b) => sum + b.balanceCents, 0);
    expect(result.netWorthCents).toBe(signedSum + result.standaloneAssetsCents + result.unassignedCents);
  });
});

describe("deriveCashBalanceCents (legacy whole-ledger figure)", () => {
  it("still ignores transfers entirely", () => {
    const cash = deriveCashBalanceCents(
      [
        { categoryId: 1, amountCents: 100_000 },
        { amountCents: 40_000, accountId: 10, transferAccountId: 11, categoryId: null },
      ],
      CATEGORIES,
    );
    expect(cash).toBe(100_000);
  });

  it("ignores a transfer even if it carries a category", () => {
    const cash = deriveCashBalanceCents(
      [
        { categoryId: 1, amountCents: 100_000 },
        { categoryId: 2, amountCents: 40_000, accountId: 10, transferAccountId: 11 },
      ],
      CATEGORIES,
    );
    expect(cash).toBe(100_000);
  });

  it("agrees with the account-aware total when every row sits on one asset account", () => {
    const transactions = [
      { categoryId: 1, amountCents: 500_000, accountId: 10 },
      { categoryId: 2, amountCents: 43_704, accountId: 10 },
      { categoryId: 3, amountCents: 6_678, accountId: 10 },
    ];
    const cash = deriveCashBalanceCents(transactions, CATEGORIES);
    const balances = deriveAccountBalances([checking], transactions, CATEGORIES);
    expect(balanceOf(balances, 10).balanceCents).toBe(cash);
  });
});
