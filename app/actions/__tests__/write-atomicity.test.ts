/**
 * A failed write must leave NOTHING behind.
 *
 * The four highest-traffic writes (`createTransaction`, `updateTransaction`,
 * `confirmTransaction`, `deleteTransaction`) used the deprecated
 * `getDb()` / `saveDb()` pair. `getDb()` returns a process-wide CACHED handle, so
 * a throw between the mutation and `saveDb()` left the change sitting in the
 * shared in-memory image — and the next successful action's flush wrote it to
 * disk. A rejected transaction could therefore appear on the ledger later, out of
 * band, with no user action.
 *
 * These tests pin the property that fixed it: every mutation runs inside
 * `withDb`, which discards the in-memory image when its callback throws.
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

/** Read the file straight off disk, bypassing any cached in-memory image. */
async function rowsOnDisk(): Promise<number> {
  await closeDb();
  return (await getTransactions()).length;
}

describe("a rejected write leaves nothing behind", () => {
  it("does not persist a rejected row via a LATER successful write's flush", async () => {
    // 1. A write that fails validation (bad amount) — must write nothing.
    const rejected = await createTransaction(
      form({ categoryId: FOOD, amount: "not-money", date: "2026-07-10T00:00:00" }),
    );
    expect(rejected).toMatchObject({ error: expect.any(String) });
    expect(await getTransactions()).toHaveLength(0);

    // 2. A write that succeeds. Under the old getDb/saveDb shape, THIS flush is
    //    what would have persisted step 1's abandoned mutation.
    const ok = await createTransaction(
      form({ categoryId: FOOD, amount: "12.00", date: "2026-07-11T00:00:00" }),
    );
    expect(ok).toMatchObject({ success: true });

    // 3. Exactly one row, on disk — not two.
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
    // Reopened from the file: the delete was actually flushed, not just in memory.
    expect(await rowsOnDisk()).toBe(0);
  });

  it("a successful create is durable on disk without a second call", async () => {
    await createTransaction(
      form({ categoryId: FOOD, amount: "42.50", date: "2026-07-15T00:00:00" }),
    );
    expect(await rowsOnDisk()).toBe(1);
  });
});
