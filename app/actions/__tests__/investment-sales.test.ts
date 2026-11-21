import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransaction, updateTransaction, deleteTransaction, confirmTransaction, getTransactions, getLedgerReportMovements } from "@/app/actions/transactions";
import { getAssets, getInvestmentHistory } from "@/app/actions/assets";
import { getAccountBalances } from "@/app/actions/accounts";
import { verifyLedger, rebuildLedgerProjections } from "@/lib/ledger";
import { createDomainDb, form, seedAccount, seedCategory, type DomainDb } from "./support/domain-fixture";
import { flowInRange } from "@/lib/reports";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let temp: DomainDb;
beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 12, name: "Demo investments", type: "Investment" });
  seedCategory(temp, { id: 13, name: "Food", type: "Expense" });
  seedAccount(temp, { id: 9, name: "Demo cash", kind: "asset", type: "Checking", openingBalanceCents: 100_000, openingBalanceDate: "2026-01-01" });
});
afterEach(async () => { await temp.cleanup(); });
const trade = (symbol = "BTC", extra = {}) => form({ accountId: "9", categoryId: "12", instrumentSymbol: symbol,
  instrumentUnit: symbol.startsWith("STOCK:") ? "shares" : symbol === "XAU" ? "oz" : "coins", quantity: "0.25", unitPrice: "100", fees: "1", date: "2026-01-02", pending: "false", ...extra });

async function save(fields: FormData) {
  const result = await createTransaction(fields);
  if ("error" in result) throw new Error(result.error);
  return result.data;
}

describe("ledger asset sales", () => {
  it.each(["BTC", "ETH", "STOCK:AAPL", "XAU"])("sells fractional %s, credits net cash, and preserves the profit after a full exit and rebuild", async (symbol) => {
    await save(trade(symbol));
    const sale = await save(trade(symbol, { investmentSide: "sell", unitPrice: "120.1234", fees: "0.25", date: "2026-01-03" }));
    expect(sale).toMatchObject({ direction: "inflow", quantityDelta: "-0.25", amountCents: 2978 });
    expect((await getAccountBalances()).find((row) => row.id === 9)?.balanceCents).toBe(100378);
    expect((await getTransactions()).find((row) => row.id === sale.id)).toMatchObject({ investmentUnitPrice: "120.1234", investmentFeeAmountCents: 25 });
    expect((await getAssets()).find((row) => row.priceSymbol === symbol)).toMatchObject({ quantityExact: "0", currentValueCents: 0, costBasisCents: -378 });
    expect((await getInvestmentHistory()).at(-1)).toMatchObject({ valueCents: 0, costBasisCents: -378, realizedGainCents: 378 });
    const totals = flowInRange(await getLedgerReportMovements(), [{ id: 12, type: "Investment" }], "2026-01-01", "2026-01-31");
    expect(totals).toMatchObject({ incomeCents: 0, investmentCents: -378, netCents: 378 });
    expect((await verifyLedger()).failures).toEqual([]);
    await rebuildLedgerProjections();
    expect((await getTransactions()).find((row) => row.id === sale.id)).toMatchObject({ direction: "inflow", quantityDelta: "-0.25", investmentFeeAmountCents: 25 });
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("records zero-net sales when fees equal proceeds", async () => {
    await save(trade());
    await save(trade("BTC", { investmentSide: "sell", unitPrice: "4", fees: "1", date: "2026-01-03" }));
    expect((await getInvestmentHistory()).at(-1)).toMatchObject({ valueCents: 0, costBasisCents: 2600, realizedGainCents: -2600 });
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("uses weighted average purchase cost for partial sales, including fees", async () => {
    await save(trade("BTC", { quantity: "1", unitPrice: "100", fees: "1" }));
    await save(trade("BTC", { quantity: "1", unitPrice: "200", fees: "1", date: "2026-01-03" }));
    await save(trade("BTC", { investmentSide: "sell", quantity: "0.5", unitPrice: "300", fees: "1", date: "2026-01-04" }));
    expect((await getInvestmentHistory()).at(-1)).toMatchObject({ costBasisCents: 15300, realizedGainCents: 7350 });
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("corrects and deletes a sale through balancing ledger events", async () => {
    await save(trade());
    const sale = await save(trade("BTC", { investmentSide: "sell", quantity: "0.1", date: "2026-01-03" }));
    expect(await updateTransaction(sale.id, trade("BTC", { investmentSide: "sell", quantity: "0.05", unitPrice: "120", fees: "0.1", date: "2026-01-03" }))).toMatchObject({ success: true, data: { quantityDelta: "-0.05", amountCents: 590, direction: "inflow" } });
    expect(await updateTransaction(sale.id, form({ comment: "Changed note", categoryId: "12" }))).toMatchObject({ success: true, data: { direction: "inflow", amountCents: 590 } });
    expect((await getAssets()).find((row) => row.priceSymbol === "BTC")?.quantityExact).toBe("0.2");
    expect(await deleteTransaction(sale.id)).toMatchObject({ success: true });
    expect((await getAssets()).find((row) => row.priceSymbol === "BTC")?.quantityExact).toBe("0.25");
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("keeps draft sale units, four-decimal price and fees until confirmation", async () => {
    await save(trade());
    const sale = await save(trade("BTC", { investmentSide: "sell", pending: "true", unitPrice: "120.1234", fees: "0.25" }));
    expect((await getAssets()).find((row) => row.priceSymbol === "BTC")?.quantityExact).toBe("0.25");
    expect((await getTransactions()).find((row) => row.id === sale.id)).toMatchObject({ investmentUnitPrice: "120.1234", investmentFeeAmountCents: 25 });
    expect(await confirmTransaction(sale.id, "2026-01-03")).toMatchObject({ success: true, data: { amountCents: 2978, quantityDelta: "-0.25", investmentDraft: null } });
    expect((await getTransactions()).find((row) => row.id === sale.id)).toMatchObject({ investmentUnitPrice: "120.1234", investmentFeeAmountCents: 25 });
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("preserves sale details when confirming a draft through the editor", async () => {
    await save(trade());
    const sale = await save(trade("BTC", { investmentSide: "sell", pending: "true", unitPrice: "120.1234", fees: "0.25", date: "2026-01-03" }));
    expect(await updateTransaction(sale.id, form({ pending: "false" }))).toMatchObject({ success: true });
    expect((await getTransactions()).find((row) => row.id === sale.id)).toMatchObject({ investmentUnitPrice: "120.1234", investmentFeeAmountCents: 25 });
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("rejects overselling, backdated sales and edits/deletes that invalidate later sales atomically", async () => {
    const buy = await save(trade());
    const sale = await save(trade("BTC", { investmentSide: "sell", quantity: "0.2", date: "2026-01-03" }));
    const count = temp.scalar("SELECT count(*) FROM ledger_events");
    expect(await createTransaction(trade("BTC", { investmentSide: "sell", quantity: "0.050000000000000001", date: "2026-01-04" }))).toHaveProperty("error");
    expect(await createTransaction(trade("BTC", { investmentSide: "sell", quantity: "0.01", date: "2026-01-01" }))).toHaveProperty("error");
    expect(await updateTransaction(buy.id, trade("BTC", { quantity: "0.1" }))).toHaveProperty("error");
    expect(await deleteTransaction(buy.id)).toHaveProperty("error");
    expect(await updateTransaction(sale.id, trade("BTC", { investmentSide: "sell", quantity: "0.3" }))).toHaveProperty("error");
    expect(temp.scalar("SELECT count(*) FROM ledger_events")).toBe(count);
    expect((await getAssets()).find((row) => row.priceSymbol === "BTC")?.quantityExact).toBe("0.05");
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it.each([{ fees: "30" }, { investmentSide: "oops" }, { categoryId: "13" }, { quantity: "-0.1" }])("rejects invalid sale inputs %j", async (extra) => {
    await save(trade());
    expect(await createTransaction(trade("BTC", { investmentSide: "sell", ...extra }))).toHaveProperty("error");
    expect((await getTransactions())).toHaveLength(1);
  });
});
