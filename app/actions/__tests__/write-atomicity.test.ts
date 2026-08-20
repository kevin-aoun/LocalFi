
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
  deleteTransaction,
  getTransactions,
} from "@/app/actions/transactions";
import { closeDb } from "@/lib/db/client";

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

async function rowsOnDisk(): Promise<number> {
  await closeDb();
  return (await getTransactions()).length;
}

describe("a rejected write leaves nothing behind", () => {
  it("does not persist a rejected row via a LATER successful write's flush", async () => {

    const rejected = await createTransaction(
      form({ categoryId: FOOD, amount: "not-money", date: "2026-07-10T00:00:00" }),
    );
    expect(rejected).toMatchObject({ error: expect.any(String) });
    expect(await getTransactions()).toHaveLength(0);

    const ok = await createTransaction(
      form({ categoryId: FOOD, amount: "12.00", date: "2026-07-11T00:00:00" }),
    );
    expect(ok).toMatchObject({ success: true });

    expect(await rowsOnDisk()).toBe(1);
    const [row] = await getTransactions();
    expect(row.amountCents).toBe(1_200);
  });

  it("a rejected DATE does not survive into a later flush either", async () => {
    expect(
      await createTransaction(form({ categoryId: FOOD, amount: "5.00", date: "not-a-date" })),
    ).toMatchObject({ error: expect.any(String) });

    await createTransaction(form({ categoryId: FOOD, amount: "7.00", date: "2026-07-12T00:00:00" }));

    expect(await rowsOnDisk()).toBe(1);
  });

  it("a successful delete is durable on disk", async () => {
    seedTransaction(temp, {
      id: 91,
      categoryId: FOOD,
      accountId: 1,
      amountCents: 3_000,
      dateKey: "2026-07-01",
    });
    expect(await getTransactions()).toHaveLength(1);

    expect(await deleteTransaction(91)).toMatchObject({ success: true });

    expect(await rowsOnDisk()).toBe(0);
  });

  it("a successful create is durable on disk without a second call", async () => {
    await createTransaction(
      form({ categoryId: FOOD, amount: "42.50", date: "2026-07-15T00:00:00" }),
    );
    expect(await rowsOnDisk()).toBe(1);
  });
});
