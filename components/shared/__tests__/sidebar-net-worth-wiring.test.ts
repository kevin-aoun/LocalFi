/**
 * End-to-end wiring for the sidebar's net-worth panel.
 *
 * THE BUG THIS DEFENDS AGAINST spanned two files that each looked right alone:
 * the sidebar called `getAssets()` and grouped the raw rows (derived `Cash` row
 * included), while the home page and /accounts called `getNetWorth()` (derived
 * `Cash` row deliberately excluded, accounts and liabilities included). The
 * chrome on every page therefore showed a Cash figure the home page had left out
 * and no accounts at all.
 *
 * These tests run the REAL actions against a throwaway database and assert that
 * what the sidebar draws is exactly what `getNetWorth()` supplies — the same
 * property, over the same actions, as the dashboard's net-worth-wiring test. The
 * pure logic is unit-tested separately in sidebar-assets.test.ts.
 *
 * data/budget.db (the owner's real financial history) is never opened: the fixture
 * creates its own file under mkdtemp and points BUDGET_DB_PATH at it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDomainDb,
  seedAccount,
  seedAsset,
  seedCategory,
  seedTransaction,
  type DomainDb,
} from "@/app/actions/__tests__/support/domain-fixture";
import { getAccountBalances, getNetWorth } from "@/app/actions/accounts";
import { getAssets } from "@/app/actions/assets";
import { syncCashAssetManually } from "@/app/actions/transactions";
import { todayKey } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { auditSidebarTotals, buildSidebarView, type SidebarViewInput } from "../sidebar-assets";

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 1, name: "Food", type: "Expense" });
  seedCategory(temp, { id: 2, name: "Salary", type: "Income" });
});

afterEach(async () => {
  await temp.cleanup();
});

/** Exactly what components/shared/sidebar.tsx loads on mount. */
async function loadSidebarInput(): Promise<SidebarViewInput> {
  const [netWorth, accounts, assets] = await Promise.all([
    getNetWorth(),
    getAccountBalances({ includeArchived: true }),
    getAssets(),
  ]);
  return { netWorth, accounts, assets };
}

describe("the sidebar cannot disagree with the home page", () => {
  it("echoes getNetWorth() and lists rows that add up to it", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 500_000 });
    seedAccount(temp, { name: "Visa", kind: "liability", type: "CreditCard", openingBalanceCents: 60_000 });
    seedAsset(temp, { category: "Properties", currentValueCents: 30_000_000 });
    seedTransaction(temp, { categoryId: 1, accountId: 1, amountCents: 4_500, dateKey: todayKey() });
    seedTransaction(temp, { categoryId: 2, accountId: 1, amountCents: 300_000, dateKey: todayKey() });

    const input = await loadSidebarInput();
    const view = buildSidebarView(input);

    // The headline is the action's figure, formatted — never re-subtracted.
    expect(view.summary.netWorthLabel).toBe(formatMoney(input.netWorth.netWorthCents));
    // And the rows the user can expand add up to it.
    expect(auditSidebarTotals(input)).toEqual({
      totalAssetsCents: input.netWorth.totalAssetsCents,
      totalLiabilitiesCents: input.netWorth.totalLiabilitiesCents,
      netWorthCents: input.netWorth.netWorthCents,
      standaloneAssetsCents: input.netWorth.standaloneAssetsCents,
    });
  });

  it("does not double-count the Cash row syncCashAsset writes", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 100_000 });
    seedTransaction(temp, { categoryId: 2, accountId: 1, amountCents: 250_000, dateKey: todayKey() });
    seedAsset(temp, { category: "Savings", currentValueCents: 25_000 });

    // Let the REAL writer create the derived Cash row, the way the app does.
    const synced = await syncCashAssetManually();
    expect(synced).not.toHaveProperty("error");

    const input = await loadSidebarInput();
    const view = buildSidebarView(input);

    // The Cash row exists in the table...
    expect(input.assets.some((a) => a.category === "Cash")).toBe(true);
    // ...but it is not a group, and it is not in the standalone subtotal.
    expect(view.groups.map((g) => g.name)).not.toContain("Cash");
    expect(view.derivedCashCount).toBe(1);
    expect(input.netWorth.standaloneAssetsCents).toBe(25_000);
    // 100_000 opening + 250_000 income + 25_000 standalone. The old sidebar would
    // have shown the 250_000 Cash row on top of that.
    expect(view.summary.netWorthLabel).toBe(formatMoney(375_000));
    expect(auditSidebarTotals(input).netWorthCents).toBe(375_000);
  });

  it("shows the mortgage the old sidebar could not show at all", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 500_000 });
    seedAccount(temp, {
      name: "Mortgage",
      kind: "liability",
      type: "Mortgage",
      openingBalanceCents: 25_000_000,
    });

    const input = await loadSidebarInput();
    const view = buildSidebarView(input);
    const liabilities = view.groups.find((g) => g.name === "Liabilities")!;

    expect(liabilities.rows.map((r) => r.name)).toEqual(["Mortgage"]);
    expect(liabilities.rows[0].amountLabel).toBe(formatMoney(25_000_000));
    expect(liabilities.rows[0].amountLabel).not.toContain("-");
    expect(liabilities.rows[0].note).toBe("owed");
    expect(view.summary.isNegative).toBe(true);
    expect(view.summary.netWorthLabel).toBe(formatMoney(-24_500_000));
  });

  it("reads a fresh database as zero, not as broken", async () => {
    const input = await loadSidebarInput();
    const view = buildSidebarView(input);

    // Migration 0003 creates the default 'Main' account every pre-accounts
    // transaction hangs off, so a fresh database is not empty — it is worth zero.
    expect(view.groups.map((g) => g.name)).toEqual(["Accounts", "Liabilities"]);
    expect(view.groups.find((g) => g.name === "Accounts")?.rows.map((r) => r.name)).toEqual([
      "Main",
    ]);
    expect(view.groups.find((g) => g.name === "Liabilities")?.rows).toEqual([]);
    expect(view.summary.netWorthLabel).toBe(formatMoney(0));
    expect(view.summary.isNegative).toBe(false);
    expect(auditSidebarTotals(input).netWorthCents).toBe(0);
  });

  it("keeps agreeing after the ledger moves", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 100_000 });
    const before = buildSidebarView(await loadSidebarInput());
    expect(before.summary.netWorthLabel).toBe(formatMoney(100_000));

    seedTransaction(temp, { categoryId: 1, accountId: 1, amountCents: 30_000, dateKey: todayKey() });
    seedAsset(temp, { category: "Crypto", currentValueCents: 45_000 });

    const input = await loadSidebarInput();
    const after = buildSidebarView(input);

    expect(after.summary.netWorthLabel).toBe(formatMoney(115_000));
    expect(auditSidebarTotals(input).netWorthCents).toBe(input.netWorth.netWorthCents);
  });
});
