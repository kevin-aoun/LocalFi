/**
 * Accounts, liabilities, transfers, net worth and net-worth history.
 *
 * The properties this file exists to defend:
 *   - a liability reduces net worth (before this, "net worth" was gross assets);
 *   - an opening balance means an incomplete import is not permanently negative;
 *   - a transfer is net-neutral and is NOT an expense (it used to be booked as an
 *     "Investment" expense, i.e. as a net-worth loss);
 *   - a snapshot taken twice on one day updates rather than duplicating.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDomainDb,
  form,
  seedAccount,
  seedAsset,
  seedCategory,
  seedTransaction,
  type DomainDb,
} from "./support/domain-fixture";
import {
  assignOrphanTransactions,
  createAccount,
  deleteAccount,
  deleteNetWorthSnapshot,
  getAccountBalances,
  getAccounts,
  getDefaultAccountId,
  getLatestNetWorthSnapshot,
  getNetWorth,
  getNetWorthHistory,
  setAccountArchived,
  snapshotNetWorth,
  updateAccount,
} from "@/app/actions/accounts";
import { createTransfer, getTransfers, updateTransfer } from "@/app/actions/transactions";
import { todayKey } from "@/lib/dates";

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 1, name: "Food", type: "Expense" });
  seedCategory(temp, { id: 2, name: "Salary", type: "Income" });
  seedCategory(temp, { id: 3, name: "Savings", type: "Investment" });
});

afterEach(async () => {
  await temp.cleanup();
});

function unwrap<T>(result: { success: true; data: T } | { error: string }): T {
  if ("error" in result) throw new Error(`action failed: ${result.error}`);
  return result.data;
}

function balanceOf(rows: Awaited<ReturnType<typeof getAccountBalances>>, name: string) {
  const found = rows.find((r) => r.name === name);
  if (!found) throw new Error(`no account named ${name}`);
  return found;
}

describe("createAccount", () => {
  it("creates an asset account and infers its kind from the type", async () => {
    const account = unwrap(await createAccount(form({ name: "Savings", type: "Savings" })));
    expect(account.kind).toBe("asset");
    expect(account.openingBalanceCents).toBe(0);
    expect(account.currency).toBe("USD");
  });

  it("infers 'liability' for a credit card, a loan and a mortgage", async () => {
    for (const [name, type] of [["Amex", "CreditCard"], ["Car", "Loan"], ["House", "Mortgage"]]) {
      const account = unwrap(await createAccount(form({ name, type })));
      expect(account.kind, `${type} should be a liability`).toBe("liability");
    }
  });

  it("parses the opening balance into exact cents", async () => {
    const account = unwrap(
      await createAccount(form({ name: "Chequing", type: "Checking", openingBalance: "2,500.75" })),
    );
    expect(account.openingBalanceCents).toBe(250_075);
    expect(temp.query("SELECT typeof(opening_balance_cents) AS t FROM accounts WHERE id = 2")[0].t).toBe(
      "integer",
    );
  });

  it("refuses to file a mortgage as an asset", async () => {
    const result = await createAccount(form({ name: "House", type: "Mortgage", kind: "asset" }));
    expect(result).toMatchObject({ error: expect.stringMatching(/must have kind 'liability'/) });
  });

  it("lets 'Other' be either side of the balance sheet", async () => {
    expect(unwrap(await createAccount(form({ name: "Odd asset", type: "Other", kind: "asset" }))).kind).toBe("asset");
    expect(unwrap(await createAccount(form({ name: "Odd debt", type: "Other", kind: "liability" }))).kind).toBe("liability");
  });

  it("rejects an unknown type and a missing name", async () => {
    expect(await createAccount(form({ name: "x", type: "Crypto" }))).toMatchObject({
      error: expect.stringMatching(/Invalid account type/),
    });
    expect(await createAccount(form({ name: "", type: "Checking" }))).toMatchObject({
      error: expect.stringMatching(/needs a name/),
    });
  });

  it("rejects a duplicate name with a readable message", async () => {
    await createAccount(form({ name: "Savings", type: "Savings" }));
    expect(await createAccount(form({ name: "Savings", type: "Savings" }))).toMatchObject({
      error: expect.stringMatching(/already exists/),
    });
  });
});

describe("getAccounts / getDefaultAccountId", () => {
  it("returns the migration's default account", async () => {
    expect((await getAccounts()).map((a) => a.name)).toEqual(["Main"]);
    expect(await getDefaultAccountId()).toBe(1);
  });

  it("hides archived accounts by default and shows them on request", async () => {
    seedAccount(temp, { id: 2, name: "Old", kind: "asset", type: "Checking", archived: true });
    expect((await getAccounts()).map((a) => a.name)).toEqual(["Main"]);
    expect((await getAccounts({ includeArchived: true })).map((a) => a.name)).toEqual(["Main", "Old"]);
  });

  it("never defaults to a liability account", async () => {
    seedAccount(temp, { id: 2, name: "Amex", kind: "liability", type: "CreditCard" });
    expect(await getDefaultAccountId()).toBe(1);
  });
});

describe("getAccountBalances", () => {
  it("starts from the opening balance", async () => {
    seedAccount(temp, { id: 2, name: "Savings", kind: "asset", type: "Savings", openingBalanceCents: 1_000_000 });
    expect(balanceOf(await getAccountBalances(), "Savings").balanceCents).toBe(1_000_000);
  });

  it("keeps a partially-imported ledger out of the red", async () => {
    unwrap(await updateAccount(1, form({ openingBalance: "2500.00" })));
    seedTransaction(temp, { categoryId: 1, accountId: 1, amountCents: 30_000, dateKey: "2026-07-01" });
    expect(balanceOf(await getAccountBalances(), "Main").balanceCents).toBe(220_000);
  });

  it("reports a credit-card debt as a negative balance and a positive owed figure", async () => {
    seedAccount(temp, { id: 2, name: "Amex", kind: "liability", type: "CreditCard", openingBalanceCents: 50_000 });
    seedTransaction(temp, { categoryId: 1, accountId: 2, amountCents: 10_000, dateKey: "2026-07-01" });
    const amex = balanceOf(await getAccountBalances(), "Amex");
    expect(amex.balanceCents).toBe(-60_000);
    expect(amex.owedCents).toBe(60_000);
  });

  it("ignores pending rows", async () => {
    seedTransaction(temp, { categoryId: 2, accountId: 1, amountCents: 100_000, dateKey: "2026-07-01" });
    seedTransaction(temp, { categoryId: 1, accountId: 1, amountCents: 5_000, dateKey: "2026-07-02", pending: true });
    expect(balanceOf(await getAccountBalances(), "Main").balanceCents).toBe(100_000);
  });
});

describe("createTransfer", () => {
  beforeEach(() => {
    seedAccount(temp, { id: 2, name: "Savings", kind: "asset", type: "Savings" });
    seedTransaction(temp, { categoryId: 2, accountId: 1, amountCents: 500_000, dateKey: "2026-07-01" });
  });

  it("moves money between accounts with NO category", async () => {
    const transfer = unwrap(
      await createTransfer(
        form({ fromAccountId: 1, toAccountId: 2, amount: "1000.00", date: "2026-07-10", comment: "sweep" }),
      ),
    );
    expect(transfer.categoryId).toBeNull();
    expect(transfer.accountId).toBe(1);
    expect(transfer.transferAccountId).toBe(2);

    const balances = await getAccountBalances();
    expect(balanceOf(balances, "Main").balanceCents).toBe(400_000);
    expect(balanceOf(balances, "Savings").balanceCents).toBe(100_000);
  });

  it("is NET-NEUTRAL to net worth", async () => {
    const before = await getNetWorth();
    await createTransfer(form({ fromAccountId: 1, toAccountId: 2, amount: "1000.00", date: "2026-07-10" }));
    const after = await getNetWorth();
    expect(after.netWorthCents).toBe(before.netWorthCents);
  });

  it("does NOT book a savings transfer as a net-worth loss, unlike the old Investment hack", async () => {
    const before = await getNetWorth();

    // The old way: an "Investment" expense of the same amount.
    seedTransaction(temp, { categoryId: 3, accountId: 1, amountCents: 100_000, dateKey: "2026-07-09" });
    const viaInvestmentExpense = await getNetWorth();
    expect(viaInvestmentExpense.netWorthCents).toBe(before.netWorthCents - 100_000);

    // The new way leaves net worth alone.
    await createTransfer(form({ fromAccountId: 1, toAccountId: 2, amount: "1000.00", date: "2026-07-10" }));
    const viaTransfer = await getNetWorth();
    expect(viaTransfer.netWorthCents).toBe(viaInvestmentExpense.netWorthCents);
  });

  it("reduces a credit-card debt when it is paid from cash", async () => {
    seedAccount(temp, { id: 3, name: "Amex", kind: "liability", type: "CreditCard", openingBalanceCents: 50_000 });
    unwrap(await createTransfer(form({ fromAccountId: 1, toAccountId: 3, amount: "200.00", date: "2026-07-10" })));

    const balances = await getAccountBalances();
    expect(balanceOf(balances, "Main").balanceCents).toBe(480_000);
    expect(balanceOf(balances, "Amex").owedCents).toBe(30_000);
  });

  it("refuses a transfer to the same account and an unknown account", async () => {
    expect(await createTransfer(form({ fromAccountId: 1, toAccountId: 1, amount: "10.00" }))).toMatchObject({
      error: expect.stringMatching(/DIFFERENT/),
    });
    expect(await createTransfer(form({ fromAccountId: 1, toAccountId: 99, amount: "10.00" }))).toMatchObject({
      error: expect.stringMatching(/No account with id 99/),
    });
    expect(Number(temp.scalar("SELECT COUNT(*) FROM transactions WHERE transfer_account_id IS NOT NULL"))).toBe(0);
  });

  it("is listed by getTransfers and excluded from the derived Cash figure", async () => {
    await createTransfer(form({ fromAccountId: 1, toAccountId: 2, amount: "1000.00", date: "2026-07-10" }));
    expect(await getTransfers()).toHaveLength(1);
    // 500000 income; the transfer contributes nothing.
    expect(Number(temp.scalar("SELECT current_value_cents FROM assets WHERE category='Cash'"))).toBe(500_000);
  });

  it("can be edited, and stays a transfer", async () => {
    const created = unwrap(
      await createTransfer(form({ fromAccountId: 1, toAccountId: 2, amount: "1000.00", date: "2026-07-10" })),
    );
    const updated = unwrap(await updateTransfer(created.id, form({ amount: "1500.00" })));
    expect(updated.amountCents).toBe(150_000);
    expect(updated.categoryId).toBeNull();
    expect(balanceOf(await getAccountBalances(), "Savings").balanceCents).toBe(150_000);
  });

  it("refuses to edit a non-transfer row as a transfer", async () => {
    const id = Number(temp.scalar("SELECT id FROM transactions LIMIT 1"));
    expect(await updateTransfer(id, form({ amount: "1.00" }))).toMatchObject({
      error: expect.stringMatching(/not a transfer/),
    });
  });
});

describe("getNetWorth", () => {
  it("subtracts liabilities — net worth is no longer gross assets", async () => {
    seedAccount(temp, { id: 2, name: "House", kind: "asset", type: "Other", openingBalanceCents: 30_000_000 });
    seedAccount(temp, { id: 3, name: "Mortgage", kind: "liability", type: "Mortgage", openingBalanceCents: 22_000_000 });

    const worth = await getNetWorth();
    expect(worth.totalAssetsCents).toBe(30_000_000);
    expect(worth.totalLiabilitiesCents).toBe(22_000_000);
    expect(worth.netWorthCents).toBe(8_000_000);
  });

  it("adds standalone assets but NOT the derived Cash row", async () => {
    seedTransaction(temp, { categoryId: 2, accountId: 1, amountCents: 449_618, dateKey: "2026-07-01" });
    seedAsset(temp, { category: "Cash", currentValueCents: 449_618, notes: "Auto-calculated" });
    seedAsset(temp, { category: "Commodities", currentValueCents: 532_371 });
    seedAsset(temp, { category: "Crypto", currentValueCents: 7_000 });

    const worth = await getNetWorth();
    expect(worth.standaloneAssetsCents).toBe(539_371);
    // Cash counted ONCE, through the account.
    expect(worth.totalAssetsCents).toBe(449_618 + 539_371);
    expect(worth.netWorthCents).toBe(988_989);
  });

  it("reports the unassigned bucket rather than dropping account-less rows", async () => {
    seedTransaction(temp, { categoryId: 2, accountId: null, amountCents: 12_345, dateKey: "2026-07-01" });
    const worth = await getNetWorth();
    expect(worth.unassignedCents).toBe(12_345);
    expect(worth.totalAssetsCents).toBe(12_345);
  });
});

describe("snapshotNetWorth", () => {
  beforeEach(() => {
    seedAccount(temp, { id: 2, name: "Amex", kind: "liability", type: "CreditCard", openingBalanceCents: 50_000 });
    seedTransaction(temp, { categoryId: 2, accountId: 1, amountCents: 200_000, dateKey: "2026-07-01" });
  });

  it("records assets, liabilities and net worth for a day", async () => {
    const snapshot = unwrap(await snapshotNetWorth({ dateKey: "2026-07-28" }));
    expect(snapshot.date).toBe("2026-07-28");
    expect(snapshot.totalAssetsCents).toBe(200_000);
    expect(snapshot.totalLiabilitiesCents).toBe(50_000);
    expect(snapshot.netWorthCents).toBe(150_000);
  });

  it("UPDATES rather than duplicating when re-run on the same day", async () => {
    unwrap(await snapshotNetWorth({ dateKey: "2026-07-28" }));
    seedTransaction(temp, { categoryId: 2, accountId: 1, amountCents: 100_000, dateKey: "2026-07-28" });
    const second = unwrap(await snapshotNetWorth({ dateKey: "2026-07-28" }));

    expect(Number(temp.scalar("SELECT COUNT(*) FROM net_worth_snapshots"))).toBe(1);
    expect(second.netWorthCents).toBe(250_000);
    expect(await getNetWorthHistory()).toHaveLength(1);
  });

  it("stays at one row per day across five runs", async () => {
    for (let i = 0; i < 5; i++) await snapshotNetWorth({ dateKey: "2026-07-28" });
    expect(Number(temp.scalar("SELECT COUNT(*) FROM net_worth_snapshots"))).toBe(1);
  });

  it("records an idempotent per-holding breakdown with the snapshot", async () => {
    seedAsset(temp, { category: "Commodities", currentValueCents: 532_371, notes: "Gold" });
    seedAsset(temp, { category: "Crypto", currentValueCents: 7_000, notes: "BTC" });
    seedAsset(temp, { category: "Cash", currentValueCents: 200_000, notes: "Derived" });

    const day = todayKey();
    unwrap(await snapshotNetWorth({ dateKey: day }));
    unwrap(await snapshotNetWorth({ dateKey: day }));

    expect(temp.query("SELECT value_cents FROM asset_history ORDER BY asset_id")).toEqual([
      { value_cents: 532_371 },
      { value_cents: 7_000 },
    ]);

    unwrap(await deleteNetWorthSnapshot(day));
    expect(temp.query("SELECT * FROM asset_history")).toEqual([]);
  });

  it("accrues history across days, oldest first", async () => {
    for (const day of ["2026-07-26", "2026-07-27", "2026-07-28"]) {
      await snapshotNetWorth({ dateKey: day });
    }
    expect((await getNetWorthHistory()).map((s) => s.date)).toEqual([
      "2026-07-26",
      "2026-07-27",
      "2026-07-28",
    ]);
    expect((await getLatestNetWorthSnapshot())!.date).toBe("2026-07-28");
  });

  it("can be filtered by day range", async () => {
    for (const day of ["2026-06-01", "2026-07-01", "2026-08-01"]) {
      await snapshotNetWorth({ dateKey: day });
    }
    const rows = await getNetWorthHistory({ fromKey: "2026-06-15", toKey: "2026-07-15" });
    expect(rows.map((r) => r.date)).toEqual(["2026-07-01"]);
  });

  it("stores integer cents, never a float", async () => {
    await snapshotNetWorth({ dateKey: "2026-07-28" });
    const row = temp.query(
      "SELECT typeof(total_assets_cents) a, typeof(total_liabilities_cents) l, typeof(net_worth_cents) n FROM net_worth_snapshots",
    )[0];
    expect(row).toEqual({ a: "integer", l: "integer", n: "integer" });
  });

  it("rejects a malformed date key", async () => {
    expect(await snapshotNetWorth({ dateKey: "2026-13-99" })).toMatchObject({
      error: expect.stringMatching(/dateKey/),
    });
  });

  it("can delete one day", async () => {
    await snapshotNetWorth({ dateKey: "2026-07-28" });
    unwrap(await deleteNetWorthSnapshot("2026-07-28"));
    expect(await getNetWorthHistory()).toEqual([]);
  });
});

describe("archiving and deleting accounts", () => {
  it("archives without losing the balance", async () => {
    seedAccount(temp, { id: 2, name: "Old", kind: "asset", type: "Checking", openingBalanceCents: 10_000 });
    unwrap(await setAccountArchived(2, true));
    expect((await getAccounts()).map((a) => a.name)).toEqual(["Main"]);
    // Still part of net worth: hiding money is not the same as not having it.
    expect((await getNetWorth()).totalAssetsCents).toBe(10_000);
  });

  it("deletes an unused account", async () => {
    seedAccount(temp, { id: 2, name: "Spare", kind: "asset", type: "Checking" });
    unwrap(await deleteAccount(2));
    expect((await getAccounts()).map((a) => a.name)).toEqual(["Main"]);
  });

  it("REFUSES to delete an account that has transactions, and keeps them", async () => {
    seedTransaction(temp, { categoryId: 1, accountId: 1, amountCents: 5_000, dateKey: "2026-07-01" });
    const result = await deleteAccount(1);
    expect(result).toMatchObject({ error: expect.stringMatching(/Archive it instead/) });
    expect(Number(temp.scalar("SELECT COUNT(*) FROM transactions"))).toBe(1);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM accounts"))).toBe(1);
  });

  it("refuses to delete an account referenced only as a transfer destination", async () => {
    seedAccount(temp, { id: 2, name: "Savings", kind: "asset", type: "Savings" });
    seedTransaction(temp, { accountId: 1, transferAccountId: 2, amountCents: 5_000, dateKey: "2026-07-01" });
    expect(await deleteAccount(2)).toMatchObject({ error: expect.stringMatching(/Archive it instead/) });
  });
});

describe("assignOrphanTransactions", () => {
  it("empties the unassigned bucket onto a real account", async () => {
    seedTransaction(temp, { categoryId: 2, accountId: null, amountCents: 100_000, dateKey: "2026-07-01" });
    seedTransaction(temp, { categoryId: 1, accountId: null, amountCents: 4_000, dateKey: "2026-07-02" });
    seedTransaction(temp, { categoryId: 1, accountId: 1, amountCents: 1_000, dateKey: "2026-07-03" });

    expect((await getNetWorth()).unassignedCents).toBe(96_000);
    const { moved } = unwrap(await assignOrphanTransactions(1));
    expect(moved).toBe(2);

    const worth = await getNetWorth();
    expect(worth.unassignedCents).toBe(0);
    expect(worth.totalAssetsCents).toBe(95_000);
  });

  it("refuses an unknown account", async () => {
    expect(await assignOrphanTransactions(99)).toMatchObject({
      error: expect.stringMatching(/No account with id 99/),
    });
  });
});

describe("snapshotNetWorth date guard", () => {
  it("refuses a FUTURE date rather than plotting a value that was never true", async () => {
    // A snapshot stores TODAY's derived figures. Filing them under a future day
    // makes the net-worth chart claim a historical value that never happened.
    const result = await snapshotNetWorth({ dateKey: "2099-01-01" });
    expect(result).toMatchObject({ error: expect.stringMatching(/future/i) });
    expect(await getNetWorthHistory()).toHaveLength(0);
  });

  it("still accepts today and a past backfill", async () => {
    unwrap(await snapshotNetWorth({ dateKey: todayKey() }));
    unwrap(await snapshotNetWorth({ dateKey: "2026-01-15" }));
    expect((await getNetWorthHistory()).length).toBe(2);
  });
});
