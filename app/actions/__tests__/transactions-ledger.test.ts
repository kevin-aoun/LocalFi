import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  confirmTransaction,
  createTransaction,
  createTransfer,
  deleteTransaction,
  getTransactions,
  previewInvestmentPurchase,
  updateTransaction,
  updateTransfer,
} from "@/app/actions/transactions";
import { readDb } from "@/lib/db/client";
import { verifyLedger } from "@/lib/ledger";
import {
  createDomainDb,
  execOn,
  form,
  seedAccount,
  seedCategory,
  type DomainDb,
} from "./support/domain-fixture";

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  seedAccount(temp, { id: 2, name: "Credit card", kind: "liability", type: "Credit Card" });
  seedAccount(temp, { id: 3, name: "Euro", kind: "asset", type: "Checking" });
  execOn(temp, (db) => db.run("UPDATE accounts SET currency = 'EUR' WHERE id = 3"));
  seedCategory(temp, { id: 10, name: "Food", type: "Expense" });
  seedCategory(temp, { id: 11, name: "Interest", type: "Expense" });
  seedCategory(temp, { id: 12, name: "Investments", type: "Investment" });
  seedCategory(temp, { id: 13, name: "Salary", type: "Income" });
  seedCategory(temp, { id: 14, name: "Temporary fee", type: "Expense" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await temp.cleanup();
});

function eventRows() {
  return temp.query(
    "SELECT event_id, sequence, amends_event_id, metadata_json FROM ledger_events ORDER BY sequence",
  );
}

function movementRows(sequence: number) {
  return temp.query(
    `SELECT a.target_type, a.target_ref, m.amount_minor, m.currency, m.quantity_delta
       FROM ledger_movements m
       JOIN ledger_accounts a ON a.id = m.ledger_account_id
       JOIN ledger_events e ON e.event_id = m.event_id
      WHERE e.sequence = ${sequence}
      ORDER BY m.position`,
  );
}

function financialState() {
  return {
    transactions: temp.query("SELECT * FROM transactions ORDER BY id"),
    allocations: temp.query("SELECT * FROM transaction_allocations ORDER BY transaction_id, position"),
    accounts: temp.query("SELECT * FROM accounts ORDER BY id"),
    cashAssets: temp.query("SELECT * FROM assets WHERE category = 'Cash' ORDER BY id"),
    events: temp.query("SELECT * FROM ledger_events ORDER BY sequence"),
    movements: temp.query("SELECT * FROM ledger_movements ORDER BY event_id, position"),
  };
}

const invalidAllocationCategories = [
  { label: "Income", categoryId: 13, error: /must be an Expense category.*Income/i },
  { label: "Investment", categoryId: 12, error: /must be an Expense category.*Investment/i },
  { label: "missing", categoryId: 999, error: /category 999 does not exist/i },
] as const;

describe("immutable interactive transaction flows", () => {
  it("previews provider quantity while leaving the confirmed quantity overridable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ bitcoin: { usd: 50_000 } }),
    }));
    expect(await previewInvestmentPurchase("BTC", "1000.00")).toMatchObject({
      success: true,
      data: {
        symbol: "BTC",
        instrumentUnit: "coins",
        unitPriceMinor: 5_000_000,
        quantity: "0.02",
        sourceLabel: "CoinGecko",
      },
    });
  });

  it("rolls back a projection when posting fails and rolls back an event when projection update fails", async () => {
    execOn(temp, (db) => db.run(
      "CREATE TRIGGER force_event_failure BEFORE INSERT ON ledger_events BEGIN SELECT RAISE(ABORT, 'forced event failure'); END",
    ));
    expect(await createTransaction(form({
      accountId: 1,
      categoryId: 10,
      amount: "10.00",
      date: "2026-08-01T00:00:00",
    }))).toMatchObject({ error: expect.stringMatching(/forced event failure/i) });
    expect(await getTransactions()).toHaveLength(0);
    expect(eventRows()).toHaveLength(0);

    execOn(temp, (db) => db.run("DROP TRIGGER force_event_failure"));
    const created = await createTransaction(form({
      accountId: 1,
      categoryId: 10,
      amount: "10.00",
      date: "2026-08-01T00:00:00",
    }));
    const id = (created as { data: { id: number } }).data.id;
    const firstEventId = String(eventRows()[0].event_id);
    execOn(temp, (db) => db.run(
      `CREATE TRIGGER force_projection_failure
       BEFORE UPDATE OF current_event_id ON transactions
       WHEN OLD.id = ${id}
       BEGIN SELECT RAISE(ABORT, 'forced projection failure'); END`,
    ));
    expect(await updateTransaction(id, form({
      accountId: 1,
      categoryId: 10,
      amount: "20.00",
      date: "2026-08-02T00:00:00",
    }))).toMatchObject({ error: expect.stringMatching(/forced projection failure/i) });
    expect(eventRows()).toHaveLength(1);
    expect((await getTransactions())[0]).toMatchObject({
      id,
      amountCents: 1_000,
      currentEventId: firstEventId,
    });
  });

  it("keeps pending drafts mutable and eventless until confirmation", async () => {
    const created = await createTransaction(form({
      accountId: 1,
      categoryId: 10,
      amount: "25.00",
      comment: "Draft",
      date: "2026-08-01T00:00:00",
      pending: true,
    }));
    expect(created).toMatchObject({ success: true, data: { pending: true, currentEventId: null } });
    expect(eventRows()).toHaveLength(0);

    const id = (created as { data: { id: number } }).data.id;
    const edited = await updateTransaction(id, form({
      accountId: 1,
      categoryId: 10,
      amount: "30.00",
      comment: "Edited draft",
      date: "2026-08-02T00:00:00",
      pending: true,
    }));
    expect(edited).toMatchObject({ success: true, data: { amountCents: 3_000, pending: true } });
    expect(eventRows()).toHaveLength(0);

    const draftTransfer = await createTransfer(form({
      fromAccountId: 1,
      toAccountId: 2,
      amount: "15.00",
      date: "2026-08-02T00:00:00",
      pending: true,
    }));
    const draftTransferId = (draftTransfer as { data: { id: number } }).data.id;
    expect(await updateTransfer(draftTransferId, form({
      fromAccountId: 1,
      toAccountId: 2,
      amount: "16.00",
      date: "2026-08-02T00:00:00",
      pending: true,
    }))).toMatchObject({ success: true, data: { amountCents: 1_600, pending: true } });
    expect(eventRows()).toHaveLength(0);
    expect(await deleteTransaction(draftTransferId)).toEqual({ success: true });
    expect(eventRows()).toHaveLength(0);

    expect(await confirmTransaction(id, "2026-08-03")).toMatchObject({ success: true });
    expect(eventRows()).toHaveLength(1);
    expect(movementRows(1)).toEqual([
      expect.objectContaining({ target_type: "real_account", target_ref: "1", amount_minor: -3_000 }),
      expect.objectContaining({ target_type: "category", target_ref: "10", amount_minor: 3_000 }),
    ]);
    expect((await verifyLedger()).ok).toBe(true);
  });

  it("appends one correction and one deletion while preserving the projection key", async () => {
    const created = await createTransaction(form({
      accountId: 1,
      categoryId: 10,
      amount: "40.00",
      comment: "Original",
      date: "2026-08-01T00:00:00",
    }));
    expect(created).toMatchObject({ success: true });
    const id = (created as { data: { id: number } }).data.id;
    const firstEventId = String(eventRows()[0].event_id);

    expect(await updateTransaction(id, form({
      accountId: 1,
      categoryId: 10,
      amount: "55.00",
      comment: "Corrected",
      date: "2026-08-02T00:00:00",
    }))).toMatchObject({ success: true, data: { id, amountCents: 5_500 } });
    const afterEdit = eventRows();
    expect(afterEdit).toHaveLength(2);
    expect(afterEdit[1].amends_event_id).toBe(firstEventId);
    expect(JSON.parse(String(afterEdit[1].metadata_json))).toMatchObject({ projectionKey: id });
    expect((await getTransactions()).map((row) => row.id)).toEqual([id]);

    const currentEventId = String(afterEdit[1].event_id);
    expect(await deleteTransaction(id)).toEqual({ success: true });
    const afterDelete = eventRows();
    expect(afterDelete).toHaveLength(3);
    expect(afterDelete[2].amends_event_id).toBe(currentEventId);
    expect(JSON.parse(String(afterDelete[2].metadata_json))).toEqual({
      projectionKey: id,
      transaction: null,
    });
    expect(await getTransactions()).toHaveLength(0);
    expect((await verifyLedger()).ok).toBe(true);
  });

  it("uses signed liability arithmetic and books interest exactly once", async () => {
    expect(await createTransaction(form({
      accountId: 2,
      categoryId: 10,
      amount: "100.00",
      comment: "Card charge",
      date: "2026-08-01T00:00:00",
    }))).toMatchObject({ success: true });
    expect(movementRows(1)).toEqual([
      expect.objectContaining({ target_type: "real_account", target_ref: "2", amount_minor: -10_000 }),
      expect.objectContaining({ target_type: "category", target_ref: "10", amount_minor: 10_000 }),
    ]);

    const payment = await createTransfer(form({
      fromAccountId: 1,
      toAccountId: 2,
      amount: "110.00",
      principalAmount: "100.00",
      interestCategoryId: 11,
      comment: "Card payment",
      date: "2026-08-02T00:00:00",
    }));
    expect(payment).toMatchObject({
      success: true,
      data: { transferPrincipalAmountCents: 10_000 },
    });
    const paymentId = (payment as { data: { id: number } }).data.id;
    expect(movementRows(2)).toEqual([
      expect.objectContaining({ target_type: "real_account", target_ref: "1", amount_minor: -11_000 }),
      expect.objectContaining({ target_type: "real_account", target_ref: "2", amount_minor: 10_000 }),
      expect.objectContaining({ target_type: "category", target_ref: "11", amount_minor: 1_000 }),
    ]);
    expect(temp.query("SELECT category_id, amount_cents FROM transaction_allocations")).toEqual([
      { category_id: 11, amount_cents: 1_000 },
    ]);

    const paymentEventId = String(eventRows()[1].event_id);
    expect(await updateTransfer(paymentId, form({
      fromAccountId: 1,
      toAccountId: 2,
      amount: "105.00",
      principalAmount: "100.00",
      interestCategoryId: 11,
      comment: "Corrected card payment",
      date: "2026-08-02T00:00:00",
    }))).toMatchObject({
      success: true,
      data: { id: paymentId, amountCents: 10_500, transferPrincipalAmountCents: 10_000 },
    });
    expect(eventRows()).toHaveLength(3);
    expect(eventRows()[2].amends_event_id).toBe(paymentEventId);
    expect(temp.query("SELECT category_id, amount_cents FROM transaction_allocations")).toEqual([
      { category_id: 11, amount_cents: 500 },
    ]);

    expect(await createTransfer(form({
      fromAccountId: 1,
      toAccountId: 2,
      amount: "25.00",
      comment: "Overpayment",
      date: "2026-08-03T00:00:00",
    }))).toMatchObject({ success: true });
    expect(temp.scalar(
      `SELECT SUM(m.amount_minor)
         FROM ledger_movements m
         JOIN ledger_accounts a ON a.id = m.ledger_account_id
        WHERE a.target_type = 'real_account' AND a.target_ref = '2'`,
    )).toBe(2_500);
    expect((await verifyLedger()).ok).toBe(true);
  });

  it.each(invalidAllocationCategories.flatMap((category) => [true, false].map((pending) => ({
    ...category,
    pending,
  }))))("rejects $label allocation when creating a pending=$pending transfer without changing financial state", async ({
    categoryId,
    error,
    pending,
  }) => {
    const before = financialState();

    const result = await createTransfer(form({
      fromAccountId: 1,
      toAccountId: 2,
      amount: "110.00",
      principalAmount: "100.00",
      interestCategoryId: categoryId,
      date: "2026-08-04T00:00:00",
      pending,
    }));

    expect(result).toMatchObject({ error: expect.stringMatching(error) });
    expect(financialState()).toEqual(before);
  });

  it.each(invalidAllocationCategories.flatMap((category) => [
    { ...category, flow: "pending confirmation", pending: true },
    { ...category, flow: "confirmed correction", pending: false },
  ]))("rejects $label allocation during $flow without changing financial state", async ({
    categoryId,
    error,
    pending,
  }) => {
    const created = await createTransfer(form({
      fromAccountId: 1,
      toAccountId: 2,
      amount: "100.00",
      date: "2026-08-04T00:00:00",
      pending,
    }));
    const id = (created as { data: { id: number } }).data.id;
    const before = financialState();

    const result = await updateTransfer(id, form({
      fromAccountId: 1,
      toAccountId: 2,
      amount: "110.00",
      principalAmount: "100.00",
      interestCategoryId: categoryId,
      date: "2026-08-05T00:00:00",
      pending: false,
    }));

    expect(result).toMatchObject({ error: expect.stringMatching(error) });
    expect(financialState()).toEqual(before);
    if (pending) {
      expect(eventRows()).toHaveLength(0);
      expect((await getTransactions())[0]).toMatchObject({ id, pending: true, currentEventId: null });
    }
  });

  it.each(invalidAllocationCategories)(
    "revalidates a stored $label allocation before confirming an eventless draft",
    async ({ categoryId, error }) => {
      const storedCategoryId = categoryId === 999 ? 14 : 11;
      const created = await createTransfer(form({
        fromAccountId: 1,
        toAccountId: 2,
        amount: "110.00",
        principalAmount: "100.00",
        interestCategoryId: storedCategoryId,
        date: "2026-08-04T00:00:00",
        pending: true,
      }));
      const id = (created as { data: { id: number } }).data.id;
      if (categoryId === 999) {
        await readDb((_db, raw) => {
          raw.run("PRAGMA foreign_keys = OFF");
          raw.run("DELETE FROM categories WHERE id = ?", [storedCategoryId]);
          raw.run("PRAGMA foreign_keys = ON");
        });
      } else {
        execOn(temp, (db) => db.run(
          "UPDATE transaction_allocations SET category_id = ? WHERE transaction_id = ?",
          [categoryId, id],
        ));
      }
      const before = financialState();
      const projectionBefore = await getTransactions();

      const result = await confirmTransaction(id, "2026-08-06");

      expect(result).toMatchObject({
        error: expect.stringMatching(categoryId === 999 ? /category 14 does not exist/i : error),
      });
      expect(financialState()).toEqual(before);
      expect(await getTransactions()).toEqual(projectionBefore);
      expect(eventRows()).toHaveLength(0);
      expect((await getTransactions())[0]).toMatchObject({ id, pending: true, currentEventId: null });
    },
  );

  it("confirms a pending transfer with a valid Expense allocation", async () => {
    const created = await createTransfer(form({
      fromAccountId: 1,
      toAccountId: 2,
      amount: "110.00",
      principalAmount: "100.00",
      interestCategoryId: 11,
      date: "2026-08-04T00:00:00",
      pending: true,
    }));
    const id = (created as { data: { id: number } }).data.id;
    expect(eventRows()).toHaveLength(0);

    expect(await confirmTransaction(id, "2026-08-06")).toMatchObject({ success: true });
    expect(eventRows()).toHaveLength(1);
    expect(movementRows(1)).toEqual([
      expect.objectContaining({ target_type: "real_account", target_ref: "1", amount_minor: -11_000 }),
      expect.objectContaining({ target_type: "real_account", target_ref: "2", amount_minor: 10_000 }),
      expect.objectContaining({ target_type: "category", target_ref: "11", amount_minor: 1_000 }),
    ]);
    expect((await verifyLedger()).ok).toBe(true);
  });

  it("rejects cross-currency transfers without a projection or event", async () => {
    const result = await createTransfer(form({
      fromAccountId: 1,
      toAccountId: 3,
      amount: "10.00",
      date: "2026-08-01T00:00:00",
    }));
    expect(result).toMatchObject({ error: expect.stringMatching(/FX model/i) });
    expect(await getTransactions()).toHaveLength(0);
    expect(eventRows()).toHaveLength(0);
  });

  it("posts purchases with four movements and preserves exact quantity through correction and delete", async () => {
    const created = await createTransaction(form({
      accountId: 1,
      categoryId: 12,
      amount: "1000.00",
      comment: "BTC purchase",
      date: "2026-08-01T00:00:00",
      instrumentSymbol: "BTC",
      instrumentUnit: "coins",
      quantity: "0.020000000000",
      unitPrice: "50000.00",
    }));
    expect(created).toMatchObject({
      success: true,
      data: { instrumentId: "instrument:security:BTC", quantityDelta: "0.02" },
    });
    const id = (created as { data: { id: number } }).data.id;
    expect(movementRows(1)).toEqual([
      expect.objectContaining({ target_type: "real_account", amount_minor: -100_000 }),
      expect.objectContaining({ target_type: "category", amount_minor: 100_000 }),
      expect.objectContaining({ target_type: "instrument", amount_minor: 100_000, quantity_delta: "0.02" }),
      expect.objectContaining({ target_type: "system", amount_minor: -100_000 }),
    ]);
    expect(temp.query("SELECT quantity, book_amount_minor FROM instrument_positions")).toEqual([
      { quantity: "0.02", book_amount_minor: 100_000 },
    ]);

    expect(await updateTransaction(id, form({
      accountId: 1,
      categoryId: 12,
      amount: "1200.00",
      comment: "Corrected BTC purchase",
      date: "2026-08-02T00:00:00",
      instrumentSymbol: "BTC",
      instrumentUnit: "coins",
      quantity: "0.02",
      unitPrice: "60000.00",
    }))).toMatchObject({ success: true, data: { id, quantityDelta: "0.02" } });
    expect(eventRows()).toHaveLength(2);
    expect(temp.query("SELECT quantity, book_amount_minor FROM instrument_positions")).toEqual([
      { quantity: "0.02", book_amount_minor: 120_000 },
    ]);

    expect(await deleteTransaction(id)).toEqual({ success: true });
    expect(eventRows()).toHaveLength(3);
    expect(temp.query("SELECT quantity, book_amount_minor FROM instrument_positions")).toEqual([
      { quantity: "0", book_amount_minor: 0 },
    ]);
    expect(temp.query("SELECT id FROM assets WHERE category <> 'Cash'")).toEqual([]);
    expect(await getTransactions()).toHaveLength(0);
    expect((await verifyLedger()).ok).toBe(true);
  });

  it("reprojects a shared crypto holding when one purchase is deleted", async () => {
    const first = await createTransaction(form({
      accountId: 1,
      categoryId: 12,
      amount: "1000.00",
      comment: "First BTC purchase",
      date: "2026-08-01T00:00:00",
      instrumentSymbol: "BTC",
      instrumentUnit: "coins",
      quantity: "0.02",
      unitPrice: "50000.00",
    }));
    const second = await createTransaction(form({
      accountId: 1,
      categoryId: 12,
      amount: "600.00",
      comment: "Second BTC purchase",
      date: "2026-08-02T00:00:00",
      instrumentSymbol: "BTC",
      instrumentUnit: "coins",
      quantity: "0.01",
      unitPrice: "60000.00",
    }));
    const firstId = (first as { data: { id: number } }).data.id;
    expect(second).toMatchObject({ success: true });
    expect(temp.query("SELECT quantity, book_amount_minor FROM instrument_positions")).toEqual([
      { quantity: "0.03", book_amount_minor: 160_000 },
    ]);

    expect(await deleteTransaction(firstId)).toEqual({ success: true });

    expect(temp.query("SELECT quantity, book_amount_minor FROM instrument_positions")).toEqual([
      { quantity: "0.01", book_amount_minor: 60_000 },
    ]);
    expect(temp.query(
      "SELECT category, quantity, current_value_cents FROM assets WHERE category <> 'Cash'",
    )).toEqual([
      { category: "Crypto", quantity: 0.01, current_value_cents: 60_000 },
    ]);
    expect(await verifyLedger()).toMatchObject({ ok: true });
  });

  it("appends a balanced same-dollar purchase correction when only quantity changes", async () => {
    const created = await createTransaction(form({
      accountId: 1,
      categoryId: 12,
      amount: "1000.00",
      date: "2026-08-01T00:00:00",
      instrumentSymbol: "BTC",
      instrumentUnit: "coins",
      quantity: "0.02",
      unitPrice: "50000.00",
    }));
    const id = (created as { data: { id: number } }).data.id;

    expect(await updateTransaction(id, form({
      accountId: 1,
      categoryId: 12,
      amount: "1000.00",
      date: "2026-08-01T00:00:00",
      instrumentSymbol: "BTC",
      instrumentUnit: "coins",
      quantity: "0.021",
      unitPrice: "50000.00",
    }))).toMatchObject({ success: true, data: { quantityDelta: "0.021" } });

    const correction = movementRows(2);
    expect(correction).toHaveLength(2);
    expect(correction.reduce((sum, row) => sum + Number(row.amount_minor), 0)).toBe(0);
    expect(correction).toContainEqual(expect.objectContaining({
      target_type: "instrument",
      amount_minor: 0,
      quantity_delta: "0.001",
    }));
    expect(temp.query("SELECT quantity, book_amount_minor FROM instrument_positions")).toEqual([
      { quantity: "0.021", book_amount_minor: 100_000 },
    ]);
    expect((await verifyLedger()).ok).toBe(true);
  });
});
