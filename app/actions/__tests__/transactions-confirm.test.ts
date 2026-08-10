import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDomainDb,
  seedCategory,
  seedTransaction,
  type DomainDb,
} from "./support/domain-fixture";
import { confirmTransaction, getTransactions } from "@/app/actions/transactions";

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 2, name: "Food", type: "Expense" });
  seedTransaction(temp, {
    id: 42,
    accountId: 1,
    categoryId: 2,
    amountCents: 2500,
    dateKey: "2026-07-01",
    pending: true,
  });
});

afterEach(async () => {
  await temp.cleanup();
});

describe("confirmTransaction DateKey boundary", () => {
  it("confirms on an explicitly selected calendar day", async () => {
    const result = await confirmTransaction(42, "2026-08-07");

    expect(result).toMatchObject({ success: true });
    const [row] = await getTransactions();
    expect(row.pending).toBe(false);
    expect(row.date.getFullYear()).toBe(2026);
    expect(row.date.getMonth()).toBe(7);
    expect(row.date.getDate()).toBe(7);
    expect(row.currentEventId).toEqual(expect.any(String));
    expect(temp.scalar("SELECT COUNT(*) FROM ledger_events")).toBe(1);
    expect(temp.scalar("SELECT COUNT(*) FROM ledger_movements")).toBe(2);
  });

  it("rejects an invalid DateKey without changing the pending row", async () => {
    const result = await confirmTransaction(42, "2026-02-30");

    expect(result).toEqual({ error: "Invalid confirmation date" });
    const [row] = await getTransactions();
    expect(row.pending).toBe(true);
    expect(row.date.getDate()).toBe(1);
  });
});
