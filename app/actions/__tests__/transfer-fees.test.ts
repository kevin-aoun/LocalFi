import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmTransaction, createTransfer, deleteTransaction, getLedgerReportMovements, getTransactions, updateTransfer } from "@/app/actions/transactions";
import { getAccountBalances } from "@/app/actions/accounts";
import { withDb } from "@/lib/db/client";
import { rebuildLedgerProjections, verifyLedger } from "@/lib/ledger";
import { toDateKey } from "@/lib/dates";
import { summarizeLedger } from "@/components/transactions/ledger-summary-logic";
import { createDomainDb, execOn, form, seedAccount, seedCategory, type DomainDb } from "./support/domain-fixture";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let temp: DomainDb;
let openingEvents: Array<Record<string, unknown>>;
beforeEach(async () => {
  temp = await createDomainDb();
  execOn(temp, (db) => db.run("DELETE FROM accounts WHERE id = 1"));
  seedAccount(temp, { id: 1, name: "Demo checking", kind: "asset", type: "Checking", openingBalanceCents: 500000, openingBalanceDate: "2026-01-01" });
  seedAccount(temp, { id: 2, name: "Demo savings", kind: "asset", type: "Savings", openingBalanceCents: 10000, openingBalanceDate: "2026-01-01" });
  seedCategory(temp, { id: 10, name: "Bank fees", type: "Expense" });
  seedCategory(temp, { id: 11, name: "Income", type: "Income" });
  openingEvents = temp.query("SELECT event_id FROM ledger_events");
});
afterEach(async () => { await temp.cleanup(); });
const transferForm = (extra = {}) => form({ fromAccountId: "1", toAccountId: "2", amount: "100", fees: "2.50", feeCategoryId: "10", date: "2026-06-01", pending: "false", comment: "Synthetic transfer", ...extra });
async function create(extra = {}) {
  const result = await createTransfer(transferForm(extra));
  if ("error" in result) throw new Error(result.error);
  return result.data;
}
const balances = async () => (await getAccountBalances()).filter((row) => row.id === 1 || row.id === 2).map((row) => [row.id, row.balanceCents]);

describe("transfer amount plus a separate fee expense", () => {
  it("creates two ledger transactions, transfers the entered amount, and counts only fees as expenses", async () => {
    const transfer = await create();
    const rows = await getTransactions();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === transfer.id)).toMatchObject({ direction: "transfer", amountCents: 10000, categoryId: null, feeAmountCents: 250, feeCategoryId: 10, allocations: [] });
    expect(rows.find((row) => row.feeForTransferId === transfer.id)).toMatchObject({ direction: "outflow", amountCents: 250, categoryId: 10, accountId: 1, transferAccountId: null, pending: false, currentEventId: expect.any(String) });
    expect(await balances()).toEqual([[1, 489750], [2, 20000]]);
    expect(await getLedgerReportMovements()).toMatchObject([{ amountCents: 250, categoryId: 10 }]);
    expect(summarizeLedger(rows, [{ id: 10, name: "Bank fees", type: "Expense" }])).toMatchObject({ expenseCents: 250, transferCents: 10000, transferCount: 1 });
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it.each(["0", "", "0.00"])("creates just a transfer for fee %j", async (fees) => {
    await create({ fees, feeCategoryId: "" });
    expect(await getTransactions()).toHaveLength(1);
    expect(await balances()).toEqual([[1, 490000], [2, 20000]]);
  });

  it("updates the linked fee in place, follows the source account and date, and removes it when set to zero", async () => {
    const transfer = await create();
    const feeId = (await getTransactions()).find((row) => row.feeForTransferId === transfer.id)!.id;
    expect(await updateTransfer(transfer.id, transferForm({ fromAccountId: "2", toAccountId: "1", amount: "50", fees: "3", date: "2026-07-01" }))).toHaveProperty("success", true);
    expect((await getTransactions()).find((row) => row.id === feeId)).toMatchObject({ accountId: 2, amountCents: 300, feeForTransferId: transfer.id });
    expect((await getTransactions()).map((row) => toDateKey(row.date))).toEqual(["2026-07-01", "2026-07-01"]);
    expect(await balances()).toEqual([[1, 505000], [2, 4700]]);
    await rebuildLedgerProjections();
    expect((await getTransactions()).find((row) => row.id === feeId)).toMatchObject({ amountCents: 300, feeForTransferId: transfer.id });
    expect(await updateTransfer(transfer.id, transferForm({ fees: "0", feeCategoryId: "" }))).toHaveProperty("success", true);
    expect(await getTransactions()).toHaveLength(1);
    expect(await balances()).toEqual([[1, 490000], [2, 20000]]);
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("deletes both confirmed entries together and preserves the audit history", async () => {
    const transfer = await create();
    expect(await deleteTransaction(transfer.id)).toEqual({ success: true });
    expect(await getTransactions()).toEqual([]);
    expect(await balances()).toEqual([[1, 500000], [2, 10000]]);
    await rebuildLedgerProjections();
    expect(await getTransactions()).toEqual([]);
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("can delete just the fee while keeping the transfer", async () => {
    const transfer = await create();
    const fee = (await getTransactions()).find((row) => row.feeForTransferId === transfer.id)!;
    expect(await deleteTransaction(fee.id)).toHaveProperty("success", true);
    expect(await getTransactions()).toMatchObject([{ id: transfer.id, feeAmountCents: null }]);
    expect(await balances()).toEqual([[1, 490000], [2, 20000]]);
  });

  it.each(["transfer", "fee"])("keeps drafts eventless and confirms both entries through the %s on the picked day", async (entry) => {
    const transfer = await create({ pending: "true" });
    expect((await getTransactions()).every((row) => row.pending && row.currentEventId === null)).toBe(true);
    expect(await balances()).toEqual([[1, 500000], [2, 10000]]);
    expect(await updateTransfer(transfer.id, transferForm({ amount: "200", fees: "3", pending: "true" }))).toHaveProperty("success", true);
    const fee = (await getTransactions()).find((row) => row.feeForTransferId === transfer.id)!;
    expect(await confirmTransaction(entry === "fee" ? fee.id : transfer.id, "2026-08-01")).toHaveProperty("success", true);
    expect((await getTransactions()).map((row) => [row.pending, toDateKey(row.date)])).toEqual([[false, "2026-08-01"], [false, "2026-08-01"]]);
    expect(await balances()).toEqual([[1, 479700], [2, 30000]]);
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("removes both pending entries without posting events", async () => {
    const transfer = await create({ pending: "true" });
    expect(await deleteTransaction(transfer.id)).toHaveProperty("success", true);
    expect(await getTransactions()).toEqual([]);
    expect(temp.query("SELECT event_id FROM ledger_events")).toEqual(openingEvents);
  });

  it("confirms both entries when a pending transfer is saved as cleared", async () => {
    const transfer = await create({ pending: "true" });
    expect(await updateTransfer(transfer.id, transferForm({ pending: "false", fees: "4" }))).toHaveProperty("success", true);
    expect((await getTransactions()).map((row) => row.pending)).toEqual([false, false]);
    expect(await balances()).toEqual([[1, 489600], [2, 20000]]);
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("rolls back edits to both rows and events when the new fee category is invalid", async () => {
    const transfer = await create();
    const before = await getTransactions();
    const events = temp.query("SELECT event_id FROM ledger_events");
    expect(await updateTransfer(transfer.id, transferForm({ amount: "300", fees: "5", feeCategoryId: "11" }))).toHaveProperty("error");
    expect(await getTransactions()).toEqual(before);
    expect(temp.query("SELECT event_id FROM ledger_events")).toEqual(events);
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("turns an older combined transfer into two entries when edited without double-charging", async () => {
    const legacy = await createTransfer(form({ fromAccountId: "1", toAccountId: "2", amount: "102.50", principalAmount: "100", interestCategoryId: "10", date: "2026-06-01" }));
    if ("error" in legacy) throw new Error(legacy.error);
    const before = await balances();
    expect(await updateTransfer(legacy.data.id, transferForm())).toHaveProperty("success", true);
    expect(await balances()).toEqual(before);
    expect(await getTransactions()).toHaveLength(2);
    expect(await getLedgerReportMovements()).toMatchObject([{ amountCents: 250, categoryId: 10 }]);
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it.each([{ fees: "-1" }, { fees: "bad" }, { feeCategoryId: "" }, { feeCategoryId: "11" }, { fees: "90071992547409.91" }])("rejects invalid fees %j atomically", async (extra) => {
    expect(await createTransfer(transferForm(extra))).toHaveProperty("error");
    expect(await getTransactions()).toEqual([]);
    expect(temp.query("SELECT event_id FROM ledger_events")).toEqual(openingEvents);
  });

  it("rolls back the transfer, its event, and its fee if the fee write fails", async () => {
    await withDb((_db, raw) => raw.run("CREATE TRIGGER reject_fee BEFORE INSERT ON transactions WHEN NEW.fee_for_transfer_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic fee failure'); END"));
    expect(await createTransfer(transferForm())).toHaveProperty("error");
    expect(await getTransactions()).toEqual([]);
    expect(temp.query("SELECT event_id FROM ledger_events")).toEqual(openingEvents);
    expect(await balances()).toEqual([[1, 500000], [2, 10000]]);
  });
});
