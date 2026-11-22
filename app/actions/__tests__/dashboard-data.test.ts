import { readFileSync } from "node:fs";
import path from "node:path";
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
import { countLedgerReplays } from "./support/ledger-replays";
import {
  getAccountBalances,
  getDashboardData,
  getNetWorth,
  getNetWorthHistory,
  snapshotNetWorth,
  updateAccount,
} from "@/app/actions/accounts";
import { getAssets } from "@/app/actions/assets";
import { getCategories } from "@/app/actions/categories";
import { createTransfer } from "@/app/actions/transactions";
import { buildCashCandles, computeCashGrowth } from "@/components/dashboard/cash-series";
import { deriveCashBalancesByCurrency } from "@/lib/cash-balance";
import { readDb } from "@/lib/db/client";
import { fromDateKey } from "@/lib/dates";
import { readAccountMovements, readUnassignedAccountMovements } from "@/lib/ledger";

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 1, name: "Food", type: "Expense" });
  seedCategory(temp, { id: 2, name: "Salary", type: "Income" });
  seedAccount(temp, { id: 2, name: "Savings", kind: "asset", type: "Savings" });
  seedAccount(temp, { id: 3, name: "Card", kind: "liability", type: "CreditCard", openingBalanceCents: 30_000, openingBalanceDate: "2026-01-01" });
  seedAccount(temp, { id: 4, name: "Old", kind: "asset", type: "Checking", openingBalanceCents: 1_000, openingBalanceDate: "2026-01-01", archived: true });
  seedAsset(temp, { category: "Properties", currentValueCents: 25_000_000, notes: "Flat" });
});

afterEach(async () => {
  await temp.cleanup();
});

async function seedLedger() {
  expect(await updateAccount(1, form({ openingBalance: "100.00", openingBalanceDate: "2026-01-01" })))
    .toMatchObject({ success: true });
  seedTransaction(temp, { categoryId: 2, accountId: 1, amountCents: 500_000, dateKey: "2026-02-01" });
  seedTransaction(temp, { categoryId: 1, accountId: 1, amountCents: 12_000, dateKey: "2026-02-01" });
  seedTransaction(temp, { categoryId: 1, accountId: null, amountCents: 4_000, dateKey: "2026-02-03" });
  seedTransaction(temp, { categoryId: 1, accountId: 1, amountCents: 9_000, dateKey: "2099-01-01" });
  expect(await createTransfer(form({ fromAccountId: 1, toAccountId: 2, amount: "250.00", date: "2026-02-05" })))
    .toMatchObject({ success: true });
  expect(await snapshotNetWorth({ dateKey: "2026-03-01" })).toMatchObject({ success: true });
  seedAccount(temp, { id: 5, name: "Euro", kind: "asset", type: "Checking", currency: "EUR", openingBalanceCents: 7_000, openingBalanceDate: "2026-06-01" });
}

describe("getDashboardData", () => {
  it("is Home's only load, so each reload (including live-price refreshes) replays once", () => {
    const home = readFileSync(path.resolve(__dirname, "../../(dashboard)/page.tsx"), "utf8");
    expect(home).toMatch(/const data = await getDashboardData\(\);/);
    expect(home).not.toMatch(/\b(getAssets|getNetWorth|getAccountBalances|getNetWorthHistory|getCategories|getSettings)\b/);
    expect(home).toContain("<LivePriceRefresh onRefresh={loadData} />");
  });

  it("returns exactly what Home's separate reads return, from one ledger replay", async () => {
    await seedLedger();

    const { result, replays } = await countLedgerReplays(() => getDashboardData());

    expect(replays).toBe(1);
    expect(result.assets).toEqual(await getAssets({ includeArchived: true }));
    expect(result.netWorth).toEqual(await getNetWorth());
    expect(result.accounts).toEqual(await getAccountBalances({ includeArchived: true }));
    expect(result.history).toEqual(await getNetWorthHistory());
    expect(result.categories).toEqual(await getCategories());
    expect(result.userName).toBe("");
    expect(result.netWorth.aggregate).toBeNull();
    expect(result.history).toHaveLength(1);
    expect(result.assets.some((asset) => asset.category === "Properties")).toBe(true);
    expect(result.accounts.some((account) => account.archived)).toBe(true);
  });

  it("charts the same cash as one row per account movement did", async () => {
    await seedLedger();
    const { cashMovements } = await getDashboardData();
    const perMovement = await readDb((_db, raw) =>
      [...readAccountMovements(raw), ...readUnassignedAccountMovements(raw)].map((movement) => ({
        date: fromDateKey(movement.dateKey),
        categoryId: null,
        amountCents: Math.abs(movement.amountCents),
        direction: movement.amountCents < 0 ? "outflow" as const : "inflow" as const,
        currency: movement.currency,
        pending: false,
        transferAccountId: null,
      })));

    expect(cashMovements.length).toBeLessThan(perMovement.length);
    expect(deriveCashBalancesByCurrency(cashMovements, [])).toEqual(deriveCashBalancesByCurrency(perMovement, []));
    for (const currency of ["USD", "EUR"]) {
      for (const period of ["daily", "weekly", "monthly"] as const) {
        expect(buildCashCandles(cashMovements, [], period, currency))
          .toEqual(buildCashCandles(perMovement, [], period, currency));
      }
      expect(computeCashGrowth(cashMovements, [], new Date(2026, 1, 20), currency))
        .toEqual(computeCashGrowth(perMovement, [], new Date(2026, 1, 20), currency));
    }
  });
});
