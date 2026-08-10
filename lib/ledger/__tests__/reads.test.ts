import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assignOrphanTransactions, createAccount, updateAccount } from "@/app/actions/accounts";
import {
  createTransaction,
  createTransfer,
  deleteTransaction,
  updateTransaction,
  updateTransfer,
} from "@/app/actions/transactions";
import {
  createDomainDb,
  form,
  seedAccount,
  seedCategory,
  seedTransaction,
  type DomainDb,
} from "@/app/actions/__tests__/support/domain-fixture";
import { readDb } from "@/lib/db/client";
import {
  readAccountBalances,
  readAccountMovements,
  readCategoryMovements,
  readCurrentMovements,
  readPositionStates,
  readUnassignedAccountMovements,
} from "@/lib/ledger";

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 10, name: "Food", type: "Expense" });
  seedCategory(temp, { id: 11, name: "Travel", type: "Expense" });
  seedCategory(temp, { id: 12, name: "Interest", type: "Expense" });
  seedCategory(temp, { id: 13, name: "Investments", type: "Investment" });
});

afterEach(async () => {
  await temp.cleanup();
});

function dataId(result: unknown): number {
  if (!result || typeof result !== "object" || !("data" in result)) {
    throw new Error(`action failed: ${JSON.stringify(result)}`);
  }
  return Number((result as { data: { id: number } }).data.id);
}

describe("DEC-011 canonical current movement reads", () => {
  it("moves a corrected amount, category, and date out of the old bucket", async () => {
    const id = dataId(await createTransaction(form({
      accountId: 1,
      categoryId: 10,
      amount: "40.00",
      date: "2026-01-31T00:00:00",
    })));
    expect(await updateTransaction(id, form({
      accountId: 1,
      categoryId: 11,
      amount: "55.00",
      date: "2026-02-01T00:00:00",
    }))).toMatchObject({ success: true });

    const state = await readDb((_db, raw) => ({
      january: readCategoryMovements(raw, { toKey: "2026-01-31" }),
      february: readCategoryMovements(raw, { fromKey: "2026-02-01", toKey: "2026-02-28" }),
      accounts: readAccountMovements(raw),
    }));
    expect(state.january).toEqual([]);
    expect(state.february).toHaveLength(1);
    expect(state.february[0]).toMatchObject({
      categoryId: 11,
      movementCents: 5_500,
      dateKey: "2026-02-01",
    });
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]).toMatchObject({ amountCents: -5_500, dateKey: "2026-02-01" });
  });

  it("collapses a corrected principal/interest transfer split exactly once", async () => {
    seedAccount(temp, { id: 2, name: "Card", kind: "liability", type: "CreditCard" });
    const id = dataId(await createTransfer(form({
      fromAccountId: 1,
      toAccountId: 2,
      amount: "110.00",
      principalAmount: "100.00",
      interestCategoryId: 12,
      date: "2026-03-01T00:00:00",
    })));
    expect(await updateTransfer(id, form({
      fromAccountId: 1,
      toAccountId: 2,
      amount: "130.00",
      principalAmount: "120.00",
      interestCategoryId: 12,
      date: "2026-03-02T00:00:00",
    }))).toMatchObject({ success: true });

    const movements = await readDb((_db, raw) => readCurrentMovements(raw));
    expect(movements.map(({ targetType, targetRef, amountMinor, dateKey }) => ({
      targetType,
      targetRef,
      amountMinor,
      dateKey,
    }))).toEqual([
      { targetType: "category", targetRef: "12", amountMinor: 1_000, dateKey: "2026-03-02" },
      { targetType: "real_account", targetRef: "1", amountMinor: -13_000, dateKey: "2026-03-02" },
      { targetType: "real_account", targetRef: "2", amountMinor: 12_000, dateKey: "2026-03-02" },
    ]);
  });

  it("uses only the latest investment purchase state and drops a deleted chain", async () => {
    const id = dataId(await createTransaction(form({
      accountId: 1,
      categoryId: 13,
      amount: "1000.00",
      date: "2026-04-01T00:00:00",
      instrumentSymbol: "BTC",
      instrumentUnit: "coins",
      quantity: "0.02",
      unitPrice: "50000.00",
    })));
    expect(await updateTransaction(id, form({
      accountId: 1,
      categoryId: 13,
      amount: "1200.00",
      date: "2026-04-02T00:00:00",
      instrumentSymbol: "BTC",
      instrumentUnit: "coins",
      quantity: "0.03",
      unitPrice: "40000.00",
    }))).toMatchObject({ success: true });
    expect(await readDb((_db, raw) => readPositionStates(raw))).toEqual([{
      instrumentId: "instrument:security:BTC",
      currency: "USD",
      quantity: "0.03",
      bookAmountMinor: 120_000,
    }]);

    expect(await deleteTransaction(id)).toEqual({ success: true });
    expect(await readDb((_db, raw) => readPositionStates(raw))).toEqual([]);
    expect(await readDb((_db, raw) => readCurrentMovements(raw))).toEqual([]);
  });

  it("redates and replaces an opening, then removes it when cleared", async () => {
    const created = await createAccount(form({
      name: "Dated opening",
      type: "Checking",
      openingBalance: "125.00",
      openingBalanceDate: "2026-05-01",
    }));
    const id = dataId(created);
    expect(await updateAccount(id, form({
      openingBalance: "200.00",
      openingBalanceDate: "2026-06-01",
    }))).toMatchObject({ success: true });

    expect(await readDb((_db, raw) => readAccountBalances(raw, { asOfKey: "2026-05-31" })))
      .toEqual([]);
    expect(await readDb((_db, raw) => readAccountBalances(raw, { asOfKey: "2026-06-01" })))
      .toEqual([{
        accountId: id,
        currency: "USD",
        balanceCents: 20_000,
        openingCents: 20_000,
        activityCents: 0,
      }]);

    expect(await updateAccount(id, form({ openingBalance: "0" }))).toMatchObject({ success: true });
    expect(await readDb((_db, raw) => readAccountBalances(raw))).toEqual([]);
  });

  it("reassigns a legacy-unassigned chain without counting its prior leg", async () => {
    seedTransaction(temp, {
      id: 81,
      categoryId: 10,
      accountId: null,
      amountCents: 5_000,
      dateKey: "2026-07-01",
    });
    expect(await readDb((_db, raw) => readUnassignedAccountMovements(raw))).toHaveLength(1);
    expect(await assignOrphanTransactions(1)).toMatchObject({ success: true, data: { moved: 1 } });

    const state = await readDb((_db, raw) => ({
      unassigned: readUnassignedAccountMovements(raw),
      accounts: readAccountMovements(raw),
      categories: readCategoryMovements(raw),
    }));
    expect(state.unassigned).toEqual([]);
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]).toMatchObject({ accountId: 1, amountCents: -5_000 });
    expect(state.categories).toHaveLength(1);
    expect(state.categories[0]).toMatchObject({ categoryId: 10, movementCents: 5_000 });
  });
});
