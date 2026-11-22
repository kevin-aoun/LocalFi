import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDomainDb,
  execOn,
  seedAccount,
  seedAsset,
  seedCategory,
  seedTransaction,
  type DomainDb,
} from "@/app/actions/__tests__/support/domain-fixture";
import { countLedgerReplays } from "@/app/actions/__tests__/support/ledger-replays";
import { getAccountBalances, getNetWorth, getSidebarData } from "@/app/actions/accounts";
import { getAssets } from "@/app/actions/assets";
import { getSettings } from "@/app/actions/settings";
import { withDb } from "@/lib/db/client";
import { syncCashAssetWithin } from "@/lib/db/sync-cash";
import { todayKey } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { buildSidebarView, type SidebarViewInput } from "../sidebar-assets";
import { auditSidebarTotals } from "./support/sidebar-audit";

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 1, name: "Food", type: "Expense" });
  seedCategory(temp, { id: 2, name: "Salary", type: "Income" });
});

afterEach(async () => {
  await temp.cleanup();
});

async function loadSidebarInput(): Promise<SidebarViewInput> {
  const { netWorth, accounts, assets } = await getSidebarData();
  return { netWorth, accounts, assets };
}

describe("getSidebarData", () => {
  it("is the sidebar's only financial load, so each financial-updated reload replays once", () => {
    const sidebar = readFileSync(path.resolve(__dirname, "../sidebar.tsx"), "utf8");
    expect(sidebar).toMatch(/const data = await getSidebarData\(\);/);
    expect(sidebar).not.toMatch(/\b(getAssets|getNetWorth|getAccountBalances)\b/);
  });

  it("returns exactly what the separate sidebar reads returned, from one ledger replay", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 500_000 });
    seedAccount(temp, { name: "Visa", kind: "liability", type: "CreditCard", openingBalanceCents: 60_000 });
    seedAccount(temp, { name: "Old", kind: "asset", type: "Checking", openingBalanceCents: 1_000, archived: true });
    seedAsset(temp, { category: "Properties", currentValueCents: 30_000_000, notes: "Flat" });
    seedAsset(temp, { category: "Vehicles", currentValueCents: 900_000, notes: "Sold car" });
    execOn(temp, (db) => db.run("UPDATE assets SET archived = 1 WHERE notes = 'Sold car'"));
    seedTransaction(temp, { categoryId: 2, accountId: 1, amountCents: 300_000, dateKey: todayKey() });
    seedTransaction(temp, { categoryId: 1, accountId: null, amountCents: 4_500, dateKey: todayKey() });
    execOn(temp, (db) => db.run("INSERT INTO settings (id, user_name, show_ledger) VALUES (1, 'Sam', 1)"));

    const { result, replays } = await countLedgerReplays(() => getSidebarData());

    expect(replays).toBe(1);
    expect(result.netWorth).toEqual(await getNetWorth());
    expect(result.accounts).toEqual(await getAccountBalances({ includeArchived: true }));
    expect(result.assets).toEqual(await getAssets());
    const settings = await getSettings();
    expect({ userName: result.userName, showLedger: result.showLedger })
      .toEqual({ userName: settings.userName, showLedger: settings.showLedger });
    expect(result.userName).toBe("Sam");
    expect(result.showLedger).toBe(true);
  });
});

describe("the sidebar cannot disagree with the home page", () => {
  it("echoes getNetWorth() and lists rows that add up to it", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 500_000 });
    seedAccount(temp, { name: "Visa", kind: "liability", type: "CreditCard", openingBalanceCents: 60_000 });
    seedAsset(temp, { category: "Properties", currentValueCents: 30_000_000 });
    seedTransaction(temp, { categoryId: 1, accountId: 1, amountCents: 4_500, dateKey: todayKey() });
    seedTransaction(temp, { categoryId: 2, accountId: 1, amountCents: 300_000, dateKey: todayKey() });

    const input = await loadSidebarInput();
    const view = buildSidebarView(input);

    expect(view.summary.netWorthLabel).toBe(formatMoney(input.netWorth.netWorthCents));

    expect(auditSidebarTotals(input)).toEqual({
      totalAssetsCents: input.netWorth.totalAssetsCents,
      totalLiabilitiesCents: input.netWorth.totalLiabilitiesCents,
      netWorthCents: input.netWorth.netWorthCents,
      standaloneAssetsCents: input.netWorth.standaloneAssetsCents,
      currencyTotals: [
        {
          currency: "USD",
          totalAssetsCents: input.netWorth.totalAssetsCents,
          totalLiabilitiesCents: input.netWorth.totalLiabilitiesCents,
          netWorthCents: input.netWorth.netWorthCents,
          standaloneAssetsCents: input.netWorth.standaloneAssetsCents,
        },
      ],
    });
  });

  it("does not double-count the Cash row syncCashAsset writes", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 100_000 });
    seedTransaction(temp, { categoryId: 2, accountId: 1, amountCents: 250_000, dateKey: todayKey() });
    seedAsset(temp, { category: "Savings", currentValueCents: 25_000 });

    await withDb((db) => syncCashAssetWithin(db));

    const input = await loadSidebarInput();
    const view = buildSidebarView(input);

    expect(input.assets.some((a) => a.category === "Cash")).toBe(true);

    expect(view.groups.map((g) => g.name)).not.toContain("Cash");
    expect(view.derivedCashCount).toBe(1);
    expect(input.netWorth.standaloneAssetsCents).toBe(25_000);

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
    seedAsset(temp, { category: "Investments", currentValueCents: 45_000 });

    const input = await loadSidebarInput();
    const after = buildSidebarView(input);

    expect(after.summary.netWorthLabel).toBe(formatMoney(115_000));
    expect(auditSidebarTotals(input).netWorthCents).toBe(input.netWorth.netWorthCents);
  });
});
