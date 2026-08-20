
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDomainDb,
  execOn,
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

const BAD_DATES = [
  "not-a-date",
  "2026-13-45",
  "2026-02-30",
  "2026-07-04T99:00:00",
  "tomorrow",
  "31/02/2026",
];

describe("createTransaction date validation", () => {
  it.each(BAD_DATES)("refuses %s instead of storing an Invalid Date", async (bad) => {
    const result = await createTransaction(
      form({ categoryId: FOOD, amount: "10.00", date: bad, comment: "x" }),
    );

    expect(result).toMatchObject({ error: expect.any(String) });

    expect(await getTransactions()).toHaveLength(0);
  });

  it("still accepts a well-formed date and stores the right day", async () => {
    const result = await createTransaction(
      form({ categoryId: FOOD, amount: "10.00", date: "2026-07-04T00:00:00", comment: "ok" }),
    );
    expect(result).toMatchObject({ success: true });

    const [row] = await getTransactions();

    expect(row.date.getFullYear()).toBe(2026);
    expect(row.date.getMonth()).toBe(6);
    expect(row.date.getDate()).toBe(4);
    expect(row.direction).toBe("outflow");
    expect(row.currency).toBe("USD");
  });

  it("defaults to now when the field is absent rather than storing NaN", async () => {
    const result = await createTransaction(form({ categoryId: FOOD, amount: "5.00" }));
    expect(result).toMatchObject({ success: true });
    const [row] = await getTransactions();
    expect(Number.isNaN(row.date.getTime())).toBe(false);
  });

  it("rejects a negative magnitude without writing a row", async () => {
    const result = await createTransaction(
      form({ categoryId: FOOD, amount: "-10.00", date: "2026-07-04T00:00:00" }),
    );
    expect(result).toMatchObject({ error: expect.stringMatching(/negative/i) });
    expect(await getTransactions()).toHaveLength(0);
  });

  it("snapshots account currency and deliberately refreshes it when the row is moved", async () => {
    execOn(temp, (db) => db.run("UPDATE accounts SET currency = 'EUR' WHERE id = 2"));
    const created = await createTransaction(
      form({
        categoryId: FOOD,
        accountId: 2,
        amount: "10.00",
        date: "2026-07-04T00:00:00",
      }),
    );
    expect(created).toMatchObject({ success: true, data: { direction: "outflow", currency: "EUR" } });
    const [stored] = await getTransactions();
    const updated = await updateTransaction(
      stored.id,
      form({
        categoryId: FOOD,
        accountId: 1,
        amount: "10.00",
        date: "2026-07-05T00:00:00",
      }),
    );
    expect(updated).toMatchObject({ success: true, data: { direction: "outflow", currency: "USD" } });
  });

  it("does not rewrite direction on category metadata change, but an explicit row edit re-snapshots it", async () => {
    await createTransaction(
      form({ categoryId: FOOD, amount: "10.00", date: "2026-07-04T00:00:00" }),
    );
    const [created] = await getTransactions();
    expect(created.direction).toBe("outflow");

    execOn(temp, (db) => db.run("UPDATE categories SET type = 'Income' WHERE id = ?", [FOOD]));
    expect((await getTransactions())[0].direction).toBe("outflow");

    const updated = await updateTransaction(
      created.id,
      form({ categoryId: FOOD, amount: "10.00", date: "2026-07-05T00:00:00" }),
    );
    expect(updated).toMatchObject({ success: true, data: { direction: "inflow" } });
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
    expect(row.date.getDate()).toBe(1);
  });

  it("rejects a negative edit and preserves the stored amount and semantics", async () => {
    const [before] = await getTransactions();
    const result = await updateTransaction(
      77,
      form({ categoryId: FOOD, amount: "-1.00", date: "2026-07-02T00:00:00" }),
    );
    expect(result).toMatchObject({ error: expect.stringMatching(/negative/i) });
    const [after] = await getTransactions();
    expect(after.amountCents).toBe(before.amountCents);
    expect(after.direction).toBe(before.direction);
    expect(after.currency).toBe(before.currency);
  });
});
