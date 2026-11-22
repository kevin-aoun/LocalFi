import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAsset, getAssets } from "@/app/actions/assets";
import { getAccountBalances, getNetWorth } from "@/app/actions/accounts";
import { deleteTransaction, getTransactions, sellManualHolding, updateTransaction } from "@/app/actions/transactions";
import { todayKey } from "@/lib/dates";
import { verifyLedger, rebuildLedgerProjections } from "@/lib/ledger";
import { createDomainDb, execOn, form, seedAccount, seedCategory, type DomainDb } from "./support/domain-fixture";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let temp: DomainDb;
beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 12, name: "Asset sales", type: "Investment" });
  seedCategory(temp, { id: 13, name: "Food", type: "Expense" });
  seedCategory(temp, { id: 14, name: "Demo stock", type: "Investment" });
  execOn(temp, (db) => db.run("UPDATE categories SET investment_kind = 'stock' WHERE id = 14"));
  seedAccount(temp, { id: 9, name: "Demo cash", kind: "asset", type: "Checking", openingBalanceCents: 100_000, openingBalanceDate: "2026-01-01" });
  seedAccount(temp, { id: 10, name: "Euro cash", kind: "asset", type: "Checking", currency: "EUR", openingBalanceCents: 0, openingBalanceDate: "2026-01-01" });
});
afterEach(async () => { await temp.cleanup(); });

async function addProperty(value = "250000") {
  const result = await createAsset(form({ category: "Properties", currentValue: value, currency: "USD", notes: "Demo flat", useLivePrice: "false" }));
  if ("error" in result) throw new Error(result.error);
  return result.data;
}

// The EUR account makes net worth multi-currency, so read the USD total directly.
async function usdNetWorth() {
  return (await getNetWorth()).currencyTotals.find((total) => total.currency === "USD")?.netWorthCents;
}

const sale = (extra: Record<string, string> = {}) =>
  form({ accountId: "9", categoryId: "12", amount: "300000", date: todayKey(), ...extra });

async function sell(assetId: number, extra: Record<string, string> = {}) {
  const result = await sellManualHolding(assetId, sale(extra));
  if ("error" in result) throw new Error(result.error);
  return result.data;
}

describe("selling manually valued holdings", () => {
  it("moves the proceeds into the account, drops the holding from net worth once, and survives a rebuild", async () => {
    const property = await addProperty();
    expect(await usdNetWorth()).toBe(25_100_000);

    const row = await sell(property.id);
    expect(row).toMatchObject({ direction: "inflow", amountCents: 30_000_000, quantityDelta: "-1", categoryId: 12, comment: "Sold Demo flat" });
    expect((await getAccountBalances()).find((account) => account.id === 9)?.balanceCents).toBe(30_100_000);
    expect((await getAssets()).find((asset) => asset.id === property.id)).toBeUndefined();
    expect(await usdNetWorth()).toBe(30_100_000);
    expect((await verifyLedger()).failures).toEqual([]);
    await rebuildLedgerProjections();
    expect(await usdNetWorth()).toBe(30_100_000);
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("edits the proceeds through Transactions and restores the holding when the sale is deleted", async () => {
    const property = await addProperty();
    const row = await sell(property.id);
    expect(await updateTransaction(row.id, form({ categoryId: "12", accountId: "9", amount: "280000", comment: "Sold the flat", date: todayKey() })))
      .toMatchObject({ success: true, data: { amountCents: 28_000_000, direction: "inflow", quantityDelta: "-1" } });
    expect((await getAccountBalances()).find((account) => account.id === 9)?.balanceCents).toBe(28_100_000);
    expect(await deleteTransaction(row.id)).toMatchObject({ success: true });
    expect((await getAssets()).find((asset) => asset.id === property.id)).toMatchObject({ currentValueCents: 25_000_000, quantityExact: "1" });
    expect(await usdNetWorth()).toBe(25_100_000);
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("records a sale with no proceeds, such as a scrapped vehicle", async () => {
    const property = await addProperty();
    await sell(property.id, { amount: "0" });
    expect(await usdNetWorth()).toBe(100_000);
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it.each([
    [{ categoryId: "13" }, /Investment category/],
    [{ categoryId: "14" }, /record units and prices/],
    [{ accountId: "10" }, /USD account/],
    [{ amount: "" }, /sale proceeds/],
    [{ amount: "-5" }, /cannot be negative/],
    [{ date: "2020-01-01" }, /Not enough units/],
  ])("rejects %j without writing anything", async (extra, message) => {
    const property = await addProperty();
    const events = temp.scalar("SELECT count(*) FROM ledger_events");
    const result = await sellManualHolding(property.id, sale(extra));
    expect(result).toMatchObject({ error: expect.stringMatching(message) });
    expect(temp.scalar("SELECT count(*) FROM ledger_events")).toBe(events);
    expect(await getTransactions()).toHaveLength(0);
  });

  it("refuses to sell the same holding twice or to move its sale into a stock category", async () => {
    const property = await addProperty();
    const row = await sell(property.id);
    expect(await sellManualHolding(property.id, sale())).toMatchObject({ error: "This holding has already been sold" });
    expect(await updateTransaction(row.id, form({ categoryId: "14", accountId: "9", amount: "300000", comment: "x", date: todayKey() }))).toHaveProperty("error");
    expect((await verifyLedger()).failures).toEqual([]);
  });
});
