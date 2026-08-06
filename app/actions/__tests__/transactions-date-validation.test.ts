/**
 * A malformed date must never reach the database.
 *
 * `new Date(<garbage>)` produces an Invalid Date, and the driver stores that as a
 * NaN timestamp — the row lands on the ledger permanently undated, counts toward
 * balances, and cannot be filed into any month. `createTransfer` already guarded
 * against this; `createTransaction` and `updateTransaction` did not, which is the
 * inconsistency these tests pin.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDomainDb,
  form,
  seedAccount,
  seedCategory,
  seedTransaction,
  type DomainDb,
} from "./support/domain-fixture";
import {
  createTransaction,
  getTransactions,
  updateTransaction,
} from "@/app/actions/transactions";

const FOOD = 1;
let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  seedAccount(temp, { id: 2, name: "Savings", kind: "asset", type: "Savings" });
  seedCategory(temp, { id: FOOD, name: "Food", type: "Expense" });
});

afterEach(async () => {
  await temp.cleanup();
});

const BAD_DATES = ["not-a-date", "2026-13-45", "tomorrow", "31/02/2026"];

describe("createTransaction date validation", () => {
  it.each(BAD_DATES)("refuses %s instead of storing an Invalid Date", async (bad) => {
    const result = await createTransaction(
      form({ categoryId: FOOD, amount: "10.00", date: bad, comment: "x" }),
    );

    expect(result).toMatchObject({ error: expect.any(String) });
    // The important half: nothing was written.
    expect(await getTransactions()).toHaveLength(0);
  });

  it("still accepts a well-formed date and stores the right day", async () => {
    const result = await createTransaction(
      form({ categoryId: FOOD, amount: "10.00", date: "2026-07-04T00:00:00", comment: "ok" }),
    );
    expect(result).toMatchObject({ success: true });

    const [row] = await getTransactions();
    // Local calendar components — never a UTC-shifted day.
    expect(row.date.getFullYear()).toBe(2026);
    expect(row.date.getMonth()).toBe(6); // July
    expect(row.date.getDate()).toBe(4);
  });

  it("defaults to now when the field is absent rather than storing NaN", async () => {
    const result = await createTransaction(form({ categoryId: FOOD, amount: "5.00" }));
    expect(result).toMatchObject({ success: true });
    const [row] = await getTransactions();
    expect(Number.isNaN(row.date.getTime())).toBe(false);
  });
});

describe("updateTransaction date validation", () => {
  beforeEach(() => {
    seedTransaction(temp, {
      id: 77,
      categoryId: FOOD,
      accountId: 1,
      amountCents: 2_500,
      dateKey: "2026-07-01",
    });
  });

  it.each(BAD_DATES)("refuses %s and leaves the stored date untouched", async (bad) => {
    const result = await updateTransaction(
      77,
      form({ categoryId: FOOD, amount: "25.00", date: bad }),
    );

    expect(result).toMatchObject({ error: expect.any(String) });

    const [row] = await getTransactions();
    expect(Number.isNaN(row.date.getTime())).toBe(false);
    expect(row.date.getDate()).toBe(1); // still 2026-07-01
  });
});
