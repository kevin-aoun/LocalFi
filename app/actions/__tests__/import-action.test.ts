/**
 * Regression tests for the batch import action (item 4).
 *
 * The old import called the single-row `createTransaction` once per spreadsheet
 * line. Each of those did a full database read + a full-ledger cash
 * re-derivation + a full atomic file write, with no transaction and no
 * de-duplication, so:
 *   - an n-row import performed n complete database rewrites;
 *   - a failure on row k left rows 1..k-1 committed with no way back;
 *   - re-importing the same file doubled every row.
 *
 * Each of those three is asserted below. Every test runs against its own
 * throwaway database via BUDGET_DB_PATH; data/budget.db is never touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDb, execOn, seedCategory, seedTransaction, type TempDb } from "./support/temp-db";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

/** Counts how many times the whole import takes the database lock and flushes. */
let withDbCalls = 0;
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return {
    ...actual,
    withDb: (fn: Parameters<typeof actual.withDb>[0]) => {
      withDbCalls += 1;
      return actual.withDb(fn);
    },
  };
});

const { importTransactions } = await import("../import");

let temp: TempDb;

beforeEach(async () => {
  withDbCalls = 0;
  temp = await createTempDb();
  seedCategory(temp, { id: 1, name: "Groceries", type: "Expense" });
  seedCategory(temp, { id: 2, name: "Salary", type: "Income" });
  seedCategory(temp, { id: 3, name: "Brokerage", type: "Investment" });
});

afterEach(async () => {
  await temp.cleanup();
});

const row = (over: Partial<{ date: string; categoryId: number; amount: string; comment: string }> = {}) => ({
  date: "2026-07-28",
  categoryId: 1,
  amount: "45.00",
  comment: "Spinneys",
  ...over,
});

function transactionRows() {
  return temp.query(
    "SELECT id, date, category_id, amount_cents, comment, pending FROM transactions ORDER BY id",
  );
}

describe("importTransactions inserts the whole batch in one database write", () => {
  it("takes the lock exactly once for a 250-row import", async () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      row({ amount: `${i + 1}.00`, comment: `row ${i}` }),
    );

    const result = await importTransactions(rows);

    expect(result).toEqual({ success: true, inserted: 250, duplicates: 0, repeated: 0 });
    expect(withDbCalls).toBe(1); // was 250 full read+write cycles
    expect(transactionRows()).toHaveLength(250);
  });

  it("stores the amount as a magnitude and the date as the named calendar day", async () => {
    await importTransactions([row({ amount: "-45.00" })]);

    const [stored] = transactionRows();
    expect(stored.amount_cents).toBe(4500); // magnitude; Expense category subtracts
    // The stored instant is local midnight of the day the sheet named.
    const readBack = new Date(Number(stored.date) * 1000);
    expect(readBack.getFullYear()).toBe(2026);
    expect(readBack.getMonth()).toBe(6);
    expect(readBack.getDate()).toBe(28);
  });

  it("re-derives the Cash asset once, from the whole ledger", async () => {
    await importTransactions([
      row({ categoryId: 2, amount: "5000.00", comment: "July salary" }),
      row({ categoryId: 1, amount: "45.00", comment: "Spinneys" }),
      row({ categoryId: 3, amount: "1000.00", comment: "Brokerage" }),
    ]);

    const [cash] = temp.query("SELECT current_value_cents FROM assets WHERE category = 'Cash'");
    // 5000 income − 45 expense − 1000 investment
    expect(cash.current_value_cents).toBe(500000 - 4500 - 100000);
  });
});

describe("importTransactions is all-or-nothing", () => {
  it("writes nothing when any row has an invalid amount", async () => {
    const result = await importTransactions([row(), row({ amount: "not a number" }), row()]);

    expect(result).toEqual({ error: 'Row 2: "not a number" is not a valid amount.' });
    expect(transactionRows()).toHaveLength(0); // the good row 1 was NOT committed
  });

  it("writes nothing when any row has an invalid date", async () => {
    const result = await importTransactions([row(), row({ date: "28/07/2026" })]);

    expect(result).toEqual({
      error: 'Row 2: "28/07/2026" is not a valid date (expected YYYY-MM-DD).',
    });
    expect(transactionRows()).toHaveLength(0);
  });

  it("writes nothing when any row names a category that does not exist", async () => {
    const result = await importTransactions([row(), row({ categoryId: 999 })]);

    expect(result).toEqual({ error: "Category 999 does not exist. Nothing was imported." });
    expect(transactionRows()).toHaveLength(0);
  });

  it("rejects a row with no category rather than orphaning it", async () => {
    const result = await importTransactions([row({ categoryId: 0 })]);
    expect(result).toEqual({ error: "Row 1: no category selected." });
    expect(transactionRows()).toHaveLength(0);
  });

  it("accepts an empty batch without touching anything", async () => {
    expect(await importTransactions([])).toEqual({
      success: true,
      inserted: 0,
      duplicates: 0,
      repeated: 0,
    });
    expect(withDbCalls).toBe(0);
  });
});

describe("importTransactions de-duplicates", () => {
  it("skips rows that already exist in the ledger and reports the count", async () => {
    seedTransaction(temp, {
      categoryId: 1,
      amountCents: 4500,
      dateKey: "2026-07-28",
      comment: "Spinneys",
    });

    const result = await importTransactions([row(), row({ comment: "Coffee", amount: "12.00" })]);

    expect(result).toEqual({ success: true, inserted: 1, duplicates: 1, repeated: 0 });
    expect(transactionRows()).toHaveLength(2);
  });

  it("ignores cosmetic comment differences when matching an existing row", async () => {
    seedTransaction(temp, {
      categoryId: 1,
      amountCents: 4500,
      dateKey: "2026-07-28",
      comment: "Spinneys",
    });

    const result = await importTransactions([row({ comment: "  spinneys  " })]);
    expect(result).toEqual({ success: true, inserted: 0, duplicates: 1, repeated: 0 });
  });

  it("collapses rows repeated inside the same batch", async () => {
    const result = await importTransactions([row(), row(), row()]);
    expect(result).toEqual({ success: true, inserted: 1, duplicates: 0, repeated: 2 });
    expect(transactionRows()).toHaveLength(1);
  });

  it("importing the same file twice does not double the ledger", async () => {
    const batch = [
      row({ comment: "Spinneys" }),
      row({ comment: "Coffee", amount: "12.00" }),
      row({ categoryId: 2, amount: "5000.00", comment: "July salary" }),
    ];

    const first = await importTransactions(batch);
    expect(first).toMatchObject({ inserted: 3 });

    const second = await importTransactions(batch);
    expect(second).toEqual({ success: true, inserted: 0, duplicates: 3, repeated: 0 });
    expect(transactionRows()).toHaveLength(3);
  });

  it("does not treat a different day, amount or category as a duplicate", async () => {
    await importTransactions([row()]);
    const result = await importTransactions([
      row({ date: "2026-07-29" }),
      row({ amount: "45.01" }),
      row({ categoryId: 3 }),
    ]);
    expect(result).toEqual({ success: true, inserted: 3, duplicates: 0, repeated: 0 });
  });
});

/**
 * Imported rows can now be filed against an account.
 *
 * Before accounts existed every imported row landed with `account_id` NULL, which
 * `deriveAccountBalances` puts in an explicit "unassigned" bucket — money the user
 * entered that belongs to no account. That is still the behaviour when no account
 * is named, so an old caller cannot break; naming one files the whole batch.
 */
describe("importTransactions files the batch against an account", () => {
  /** Insert an account directly, bypassing the accounts action. */
  const seedAccount = (values: { id: number; name: string }) =>
    execOn(temp, (db) => {
      db.run(
        "INSERT INTO accounts (id, name, kind, type, opening_balance_cents, currency, archived) " +
          "VALUES (?, ?, 'asset', 'Checking', 0, 'USD', 0)",
        [values.id, values.name],
      );
    });

  const accountIds = () =>
    temp.query("SELECT account_id FROM transactions ORDER BY id").map((r) => r.account_id);

  it("leaves rows unassigned when no account is named (unchanged behaviour)", async () => {
    await importTransactions([row()]);
    expect(accountIds()).toEqual([null]);
  });

  it("treats an explicit null the same as omitting it", async () => {
    await importTransactions([row()], { accountId: null });
    expect(accountIds()).toEqual([null]);
  });

  it("files every row of the batch against the account", async () => {
    seedAccount({ id: 5, name: "Main Checking" });
    const result = await importTransactions(
      [row({ comment: "a" }), row({ comment: "b" }), row({ comment: "c" })],
      { accountId: 5 },
    );
    expect(result).toMatchObject({ inserted: 3 });
    expect(accountIds()).toEqual([5, 5, 5]);
  });

  it("writes NOTHING when the account does not exist", async () => {
    const result = await importTransactions([row()], { accountId: 999 });
    expect(result).toEqual({ error: "Account 999 does not exist. Nothing was imported." });
    expect(transactionRows()).toHaveLength(0);
  });

  it("rejects a non-integer account instead of storing NaN", async () => {
    const result = await importTransactions([row()], { accountId: 1.5 });
    expect(result).toMatchObject({ error: expect.stringContaining("Invalid account") });
    expect(transactionRows()).toHaveLength(0);
  });

  it("still de-duplicates across accounts — the same line is the same transaction", async () => {
    seedAccount({ id: 5, name: "Main Checking" });
    seedAccount({ id: 6, name: "Savings" });

    expect(await importTransactions([row()], { accountId: 5 })).toMatchObject({ inserted: 1 });
    // Re-importing the same statement line into a different account must not
    // double the ledger: `dedupeKey` deliberately excludes the account.
    expect(await importTransactions([row()], { accountId: 6 })).toEqual({
      success: true,
      inserted: 0,
      duplicates: 1,
      repeated: 0,
    });
    expect(accountIds()).toEqual([5]);
  });

  it("still takes the database lock exactly once when an account is named", async () => {
    seedAccount({ id: 5, name: "Main Checking" });
    withDbCalls = 0;
    await importTransactions(
      Array.from({ length: 50 }, (_, i) => row({ comment: `row ${i}` })),
      { accountId: 5 },
    );
    expect(withDbCalls).toBe(1);
  });
});
