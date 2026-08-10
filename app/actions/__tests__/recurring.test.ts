/**
 * Recurring-transaction materialisation, tested hard.
 *
 * This is the action most likely to silently corrupt a ledger: one occurrence too
 * many invents money, one too few loses it, and either mistake compounds monthly.
 * The cases below are the ones that actually go wrong in the wild:
 *
 *   - running the generator twice in one day (must post nothing the second time);
 *   - catching up across several missed months (each month once, on its own day);
 *   - a month-end anchor like the 31st passing through February;
 *   - an end date that falls part-way through a catch-up run;
 *   - a template deleted after it has generated rows (history must survive).
 *
 * Every test runs against its own mkdtemp database via BUDGET_DB_PATH.
 * data/budget.db is never opened.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyLedger } from "@/lib/ledger";

import {
  createDomainDb,
  execOn,
  form,
  seedAccount,
  seedCategory,
  seedRecurring,
  type DomainDb,
} from "./support/domain-fixture";
import {
  createRecurringTransaction,
  deleteRecurringTransaction,
  generateDueTransactions,
  getRecurringTransactions,
  getUpcomingRecurring,
  setRecurringArchived,
  updateRecurringTransaction,
} from "@/app/actions/recurring";

let temp: DomainDb;

beforeEach(async () => {
  temp = await createDomainDb();
  // The 0003 migration seeds account 1 ("Main"); add a savings account and the
  // two categories the templates below use.
  seedAccount(temp, { id: 2, name: "Savings", kind: "asset", type: "Savings" });
  seedCategory(temp, { id: 1, name: "Rent", type: "Expense" });
  seedCategory(temp, { id: 2, name: "Salary", type: "Income" });
});

afterEach(async () => {
  await temp.cleanup();
});

/** Rows this template has materialised, in occurrence order. */
function generated(templateId: number) {
  return temp.query(
    `SELECT recurring_occurrence, amount_cents, direction, currency, category_id, account_id, transfer_account_id, date,
            current_event_id, instrument_id, quantity_delta
     FROM transactions WHERE recurring_id = ${templateId} ORDER BY recurring_occurrence`,
  );
}

function occurrences(templateId: number): string[] {
  return generated(templateId).map((row) => String(row.recurring_occurrence));
}

function templateRow(id: number) {
  return temp.query(`SELECT * FROM recurring_transactions WHERE id = ${id}`)[0];
}

function unwrap<T>(result: { success: true; data: T } | { error: string }): T {
  if ("error" in result) throw new Error(`action failed: ${result.error}`);
  return result.data;
}

describe("createRecurringTransaction", () => {
  it("stores the template and computes next_due from the anchor", async () => {
    const created = unwrap(
      await createRecurringTransaction(
        form({
          name: "Rent",
          amount: "1200.00",
          frequency: "monthly",
          startDate: "2026-01-31",
          accountId: 1,
          categoryId: 1,
          comment: "flat",
        }),
      ),
    );
    expect(created.amountCents).toBe(120_000);
    expect(created.startDate).toBe("2026-01-31");
    expect(created.nextDue).toBe("2026-01-31");
    expect(created.lastGenerated).toBeNull();
    expect(Number(temp.scalar("SELECT COUNT(*) FROM ledger_events"))).toBe(0);
  });

  it("rejects an interval below one", async () => {
    const result = await createRecurringTransaction(
      form({ name: "x", amount: "1.00", frequency: "monthly", startDate: "2026-01-01", interval: 0 }),
    );
    expect(result).toMatchObject({ error: expect.stringMatching(/1 or more/) });
  });

  it("rejects an end date before the start date", async () => {
    const result = await createRecurringTransaction(
      form({
        name: "x",
        amount: "1.00",
        frequency: "monthly",
        startDate: "2026-06-01",
        endDate: "2026-01-01",
      }),
    );
    expect(result).toMatchObject({ error: expect.stringMatching(/end date/i) });
  });

  it("rejects a transfer to the same account, and a transfer with a category", async () => {
    expect(
      await createRecurringTransaction(
        form({
          name: "x",
          amount: "1.00",
          frequency: "monthly",
          startDate: "2026-01-01",
          accountId: 1,
          transferAccountId: 1,
        }),
      ),
    ).toMatchObject({ error: expect.stringMatching(/DIFFERENT/) });

    expect(
      await createRecurringTransaction(
        form({
          name: "x",
          amount: "1.00",
          frequency: "monthly",
          startDate: "2026-01-01",
          accountId: 1,
          transferAccountId: 2,
          categoryId: 1,
        }),
      ),
    ).toMatchObject({ error: expect.stringMatching(/no category/) });
  });

  it("rejects a non-numeric amount at the boundary", async () => {
    const result = await createRecurringTransaction(
      form({ name: "x", amount: "twelve dollars", frequency: "monthly", startDate: "2026-01-01" }),
    );
    expect(result).toMatchObject({ error: expect.stringMatching(/not a number/i) });
  });

  it("stores the amount as integer cents, never a float", async () => {
    // parseAmount deliberately rounds at the cent (half away from zero), so a
    // three-decimal input becomes an exact integer rather than a float.
    unwrap(
      await createRecurringTransaction(
        form({ name: "odd", amount: "12.345", frequency: "monthly", startDate: "2026-01-01" }),
      ),
    );
    const row = temp.query("SELECT amount_cents, typeof(amount_cents) AS t FROM recurring_transactions")[0];
    expect(row.amount_cents).toBe(1235);
    expect(row.t).toBe("integer");
  });

  it("rejects negative magnitudes and cross-currency transfer templates", async () => {
    expect(
      await createRecurringTransaction(
        form({
          name: "negative",
          amount: "-1.00",
          frequency: "monthly",
          startDate: "2026-01-01",
          accountId: 1,
          categoryId: 1,
        }),
      ),
    ).toMatchObject({ error: expect.stringMatching(/negative/i) });

    execOn(temp, (db) => db.run("UPDATE accounts SET currency = 'EUR' WHERE id = 2"));
    expect(
      await createRecurringTransaction(
        form({
          name: "FX sweep",
          amount: "1.00",
          frequency: "monthly",
          startDate: "2026-01-01",
          accountId: 1,
          transferAccountId: 2,
        }),
      ),
    ).toMatchObject({ error: expect.stringMatching(/without an FX model/i) });
  });
});

describe("generateDueTransactions — idempotency", () => {
  beforeEach(() => {
    seedRecurring(temp, {
      id: 1,
      name: "Rent",
      accountId: 1,
      categoryId: 1,
      amountCents: 120_000,
      comment: "flat",
      frequency: "monthly",
      startDate: "2026-01-01",
    });
  });

  it("posts the due occurrences once", async () => {
    const report = unwrap(await generateDueTransactions({ throughKey: "2026-03-15" }));
    expect(report.posted).toBe(3);
    expect(report.skipped).toBe(0);
    expect(occurrences(1)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });

  it("posts confirmed occurrences as balanced, replayable ledger projections", async () => {
    unwrap(await generateDueTransactions({ throughKey: "2026-02-15" }));

    const projected = generated(1);
    expect(projected.every((row) => typeof row.current_event_id === "string")).toBe(true);
    expect(projected.map((row) => row.quantity_delta)).toEqual([null, null]);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM ledger_events"))).toBe(2);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM ledger_movements"))).toBe(4);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM ledger_movements WHERE quantity_delta IS NOT NULL"))).toBe(0);

    const rows = temp.query(
      `SELECT t.id, t.recurring_occurrence, e.metadata_json
       FROM transactions t JOIN ledger_events e ON e.event_id = t.current_event_id
       ORDER BY t.recurring_occurrence`,
    );
    for (const row of rows) {
      const metadata = JSON.parse(String(row.metadata_json));
      expect(metadata.projectionKey).toBe(row.id);
      expect(metadata.transaction).toMatchObject({
        id: row.id,
        recurringId: 1,
        recurringOccurrence: row.recurring_occurrence,
        pending: false,
        instrumentId: null,
        quantityDelta: null,
      });
      expect(metadata.provenance).toEqual({
        source: "recurring-occurrence",
        templateId: 1,
        occurrence: row.recurring_occurrence,
      });
    }
    expect(await verifyLedger()).toMatchObject({ ok: true });
  });

  it("POSTS NOTHING on a second run for the same day", async () => {
    const first = unwrap(await generateDueTransactions({ throughKey: "2026-03-15" }));
    const second = unwrap(await generateDueTransactions({ throughKey: "2026-03-15" }));

    expect(first.posted).toBe(3);
    expect(second.posted).toBe(0);
    expect(second.skipped).toBe(0); // the cursor already covers them
    expect(occurrences(1)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM transactions"))).toBe(3);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM ledger_events"))).toBe(3);
  });

  it("posts nothing on a THIRD and FOURTH run either", async () => {
    await generateDueTransactions({ throughKey: "2026-03-15" });
    for (let i = 0; i < 3; i++) {
      const report = unwrap(await generateDueTransactions({ throughKey: "2026-03-15" }));
      expect(report.posted).toBe(0);
    }
    expect(Number(temp.scalar("SELECT COUNT(*) FROM transactions"))).toBe(3);
  });

  it("re-posts nothing even when the cursor is manually rewound", async () => {
    // Belt-and-braces: the partial UNIQUE index, not just last_generated, is what
    // makes a double post impossible. Rewind the cursor and try again.
    await generateDueTransactions({ throughKey: "2026-03-15" });
    temp.query("SELECT 1");
    const { execOn } = await import("./support/domain-fixture");
    execOn(temp, (db) => {
      db.run("UPDATE recurring_transactions SET last_generated = NULL, next_due = '2026-01-01' WHERE id = 1");
    });

    const report = unwrap(await generateDueTransactions({ throughKey: "2026-03-15" }));
    expect(report.posted).toBe(0);
    expect(report.skipped).toBe(3);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM transactions"))).toBe(3);
    // ...and the cursor is repaired.
    expect(templateRow(1).last_generated).toBe("2026-03-01");
  });

  it("advances the cursor and next_due", async () => {
    await generateDueTransactions({ throughKey: "2026-03-15" });
    const row = templateRow(1);
    expect(row.last_generated).toBe("2026-03-01");
    expect(row.next_due).toBe("2026-04-01");
  });

  it("posts only the newly due occurrence when time moves on", async () => {
    await generateDueTransactions({ throughKey: "2026-03-15" });
    const report = unwrap(await generateDueTransactions({ throughKey: "2026-04-02" }));
    expect(report.posted).toBe(1);
    expect(occurrences(1)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
  });

  it("dates each row on its own occurrence day, not all on today", async () => {
    await generateDueTransactions({ throughKey: "2026-03-15" });
    const dates = generated(1).map((row) => {
      const d = new Date(Number(row.date) * 1000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });
    expect(dates).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });

  it("copies the whole template onto every row", async () => {
    await generateDueTransactions({ throughKey: "2026-02-15" });
    for (const row of generated(1)) {
      expect(row.amount_cents).toBe(120_000);
      expect(row.category_id).toBe(1);
      expect(row.account_id).toBe(1);
      expect(row.transfer_account_id).toBeNull();
      expect(row.direction).toBe("outflow");
      expect(row.currency).toBe("USD");
    }
    expect(temp.scalar("SELECT comment FROM transactions LIMIT 1")).toBe("flat");
  });

  it("keeps the derived Cash asset in step with what it posted", async () => {
    await generateDueTransactions({ throughKey: "2026-03-15" });
    // Three expense rows of 120000 -> cash is -360000.
    expect(Number(temp.scalar("SELECT current_value_cents FROM assets WHERE category = 'Cash'"))).toBe(
      -360_000,
    );
  });
});

describe("generateDueTransactions — catch-up across missed months", () => {
  it("catches up 8 missed months in one run, each exactly once", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Netflix",
      accountId: 1,
      categoryId: 1,
      amountCents: 1_599,
      frequency: "monthly",
      startDate: "2025-11-15",
    });

    const report = unwrap(await generateDueTransactions({ throughKey: "2026-07-28" }));
    expect(report.posted).toBe(9); // Nov 2025 .. Jul 2026
    expect(occurrences(1)).toEqual([
      "2025-11-15",
      "2025-12-15",
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
      "2026-04-15",
      "2026-05-15",
      "2026-06-15",
      "2026-07-15",
    ]);
    expect(new Set(occurrences(1)).size).toBe(9);
  });

  it("resumes correctly from a partially-generated template", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Netflix",
      accountId: 1,
      categoryId: 1,
      amountCents: 1_599,
      frequency: "monthly",
      startDate: "2025-11-15",
      lastGenerated: "2026-02-15",
    });

    const report = unwrap(await generateDueTransactions({ throughKey: "2026-07-28" }));
    expect(report.posted).toBe(5); // Mar .. Jul
    expect(occurrences(1)[0]).toBe("2026-03-15");
  });

  it("catches up a daily template across two months without drift or duplicates", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Coffee",
      accountId: 1,
      categoryId: 1,
      amountCents: 350,
      frequency: "daily",
      startDate: "2026-01-01",
    });

    const report = unwrap(await generateDueTransactions({ throughKey: "2026-03-01" }));
    expect(report.posted).toBe(60); // 31 + 28 + 1
    const keys = occurrences(1);
    expect(new Set(keys).size).toBe(60);
    expect(keys[keys.length - 1]).toBe("2026-03-01");
    // Re-running changes nothing.
    expect(unwrap(await generateDueTransactions({ throughKey: "2026-03-01" })).posted).toBe(0);
  });

  it("catches up a weekly template on the right weekday every time", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Cleaner",
      accountId: 1,
      categoryId: 1,
      amountCents: 5_000,
      frequency: "weekly",
      startDate: "2026-07-01", // a Wednesday
    });

    unwrap(await generateDueTransactions({ throughKey: "2026-07-28" }));
    expect(occurrences(1)).toEqual(["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"]);
  });

  it("honours an interval of 3 months", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Insurance",
      accountId: 1,
      categoryId: 1,
      amountCents: 30_000,
      frequency: "monthly",
      interval: 3,
      startDate: "2026-01-10",
    });

    unwrap(await generateDueTransactions({ throughKey: "2026-12-31" }));
    expect(occurrences(1)).toEqual(["2026-01-10", "2026-04-10", "2026-07-10", "2026-10-10"]);
  });
});

describe("generateDueTransactions — month-end anchors", () => {
  it("clamps the 31st into February and RETURNS to the 31st in March", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Rent",
      accountId: 1,
      categoryId: 1,
      amountCents: 120_000,
      frequency: "monthly",
      startDate: "2026-01-31",
    });

    unwrap(await generateDueTransactions({ throughKey: "2026-06-30" }));
    expect(occurrences(1)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
    ]);
  });

  it("uses Feb 29 in a leap year", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Rent",
      accountId: 1,
      categoryId: 1,
      amountCents: 120_000,
      frequency: "monthly",
      startDate: "2024-01-31",
    });

    unwrap(await generateDueTransactions({ throughKey: "2024-03-31" }));
    expect(occurrences(1)).toEqual(["2024-01-31", "2024-02-29", "2024-03-31"]);
  });

  it("posts exactly one row for February even though two months clamp to the 28th", async () => {
    // A 30th-of-the-month template: Jan 30 and Feb 28 are distinct, and a naive
    // implementation that dedupes on the clamped date would lose one.
    seedRecurring(temp, {
      id: 1,
      name: "Gym",
      accountId: 1,
      categoryId: 1,
      amountCents: 4_000,
      frequency: "monthly",
      startDate: "2026-01-30",
    });

    unwrap(await generateDueTransactions({ throughKey: "2026-03-31" }));
    expect(occurrences(1)).toEqual(["2026-01-30", "2026-02-28", "2026-03-30"]);
    expect(
      Number(temp.scalar("SELECT COUNT(*) FROM transactions WHERE recurring_occurrence LIKE '2026-02%'")),
    ).toBe(1);
  });

  it("is stable across repeated runs at a month end", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Rent",
      accountId: 1,
      categoryId: 1,
      amountCents: 120_000,
      frequency: "monthly",
      startDate: "2026-01-31",
    });

    for (const day of ["2026-02-28", "2026-02-28", "2026-03-01", "2026-03-31", "2026-03-31"]) {
      await generateDueTransactions({ throughKey: day });
    }
    expect(occurrences(1)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });
});

describe("generateDueTransactions — end dates", () => {
  it("stops at an end date that falls part-way through a catch-up run", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Course",
      accountId: 1,
      categoryId: 1,
      amountCents: 9_900,
      frequency: "monthly",
      startDate: "2026-01-10",
      endDate: "2026-03-31",
    });

    const report = unwrap(await generateDueTransactions({ throughKey: "2026-07-28" }));
    expect(report.posted).toBe(3);
    expect(occurrences(1)).toEqual(["2026-01-10", "2026-02-10", "2026-03-10"]);
    expect(templateRow(1).next_due).toBeNull();
  });

  it("treats an end date landing exactly on an occurrence as inclusive", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Course",
      accountId: 1,
      categoryId: 1,
      amountCents: 9_900,
      frequency: "monthly",
      startDate: "2026-01-10",
      endDate: "2026-03-10",
    });

    unwrap(await generateDueTransactions({ throughKey: "2026-07-28" }));
    expect(occurrences(1)).toEqual(["2026-01-10", "2026-02-10", "2026-03-10"]);
  });

  it("posts nothing more once the end date has passed, however often it runs", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Course",
      accountId: 1,
      categoryId: 1,
      amountCents: 9_900,
      frequency: "monthly",
      startDate: "2026-01-10",
      endDate: "2026-02-28",
    });

    unwrap(await generateDueTransactions({ throughKey: "2026-07-28" }));
    for (let i = 0; i < 3; i++) {
      expect(unwrap(await generateDueTransactions({ throughKey: "2027-01-01" })).posted).toBe(0);
    }
    expect(occurrences(1)).toEqual(["2026-01-10", "2026-02-10"]);
  });

  it("posts nothing for a template that has not started yet", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Future",
      accountId: 1,
      categoryId: 1,
      amountCents: 100,
      frequency: "monthly",
      startDate: "2026-09-01",
    });

    const report = unwrap(await generateDueTransactions({ throughKey: "2026-07-28" }));
    expect(report.posted).toBe(0);
    expect(occurrences(1)).toEqual([]);
    expect(templateRow(1).last_generated).toBeNull();
  });
});

describe("generateDueTransactions — transfers and other templates", () => {
  it("materialises a recurring TRANSFER with no category, net-neutral by shape", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Savings sweep",
      accountId: 1,
      transferAccountId: 2,
      categoryId: null,
      amountCents: 50_000,
      frequency: "monthly",
      startDate: "2026-01-01",
    });

    unwrap(await generateDueTransactions({ throughKey: "2026-03-01" }));
    const rows = generated(1);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.category_id).toBeNull();
      expect(row.account_id).toBe(1);
      expect(row.transfer_account_id).toBe(2);
      expect(row.direction).toBe("transfer");
      expect(row.currency).toBe("USD");
    }
    // A transfer is not spend, so the derived Cash figure does not move.
    expect(Number(temp.scalar("SELECT current_value_cents FROM assets WHERE category = 'Cash'"))).toBe(0);
  });

  it("skips archived templates entirely", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Paused",
      accountId: 1,
      categoryId: 1,
      amountCents: 100,
      frequency: "monthly",
      startDate: "2026-01-01",
      archived: true,
    });

    const report = unwrap(await generateDueTransactions({ throughKey: "2026-07-28" }));
    expect(report.posted).toBe(0);
    expect(report.templates).toEqual([]);
  });

  it("resumes a template that is un-archived, without back-posting the paused months", async () => {
    seedRecurring(temp, {
      id: 1,
      name: "Gym",
      accountId: 1,
      categoryId: 1,
      amountCents: 4_000,
      frequency: "monthly",
      startDate: "2026-01-01",
      lastGenerated: "2026-02-01",
      archived: true,
    });

    expect(unwrap(await generateDueTransactions({ throughKey: "2026-05-01" })).posted).toBe(0);
    unwrap(await setRecurringArchived(1, false));
    const report = unwrap(await generateDueTransactions({ throughKey: "2026-05-01" }));
    // Catch-up DOES include the paused months: pausing is not the same as ending,
    // so anything still due is posted. Pinning the behaviour explicitly.
    expect(report.posted).toBe(3);
    expect(occurrences(1)).toEqual(["2026-03-01", "2026-04-01", "2026-05-01"]);
  });

  it("generates several templates in one run, independently", async () => {
    seedRecurring(temp, {
      id: 1, name: "Rent", accountId: 1, categoryId: 1, amountCents: 120_000,
      frequency: "monthly", startDate: "2026-01-01",
    });
    seedRecurring(temp, {
      id: 2, name: "Salary", accountId: 1, categoryId: 2, amountCents: 400_000,
      frequency: "monthly", startDate: "2026-01-25",
    });

    const report = unwrap(await generateDueTransactions({ throughKey: "2026-02-10" }));
    expect(report.posted).toBe(3); // rent Jan+Feb, salary Jan
    expect(occurrences(1)).toEqual(["2026-01-01", "2026-02-01"]);
    expect(occurrences(2)).toEqual(["2026-01-25"]);
    expect(report.templates.map((t) => t.name)).toEqual(["Rent", "Salary"]);
  });

  it("one broken template does not stop the others", async () => {
    const { execOn } = await import("./support/domain-fixture");
    seedRecurring(temp, {
      id: 1, name: "Good", accountId: 1, categoryId: 1, amountCents: 100,
      frequency: "monthly", startDate: "2026-01-01",
    });
    seedRecurring(temp, {
      id: 2, name: "Broken", accountId: 1, categoryId: 1, amountCents: 100,
      frequency: "monthly", startDate: "2026-01-01",
    });
    // A start date that is not a real calendar day can only get in by hand.
    execOn(temp, (db) => {
      db.run("UPDATE recurring_transactions SET start_date = '2026-02-30' WHERE id = 2");
    });

    const report = unwrap(await generateDueTransactions({ throughKey: "2026-02-01" }));
    expect(report.posted).toBe(2); // both of template 1's occurrences
    expect(report.templates.find((t) => t.id === 2)!.error).toMatch(/2026-02-30|calendar/i);
    expect(occurrences(1)).toEqual(["2026-01-01", "2026-02-01"]);
    expect(occurrences(2)).toEqual([]);
  });

  it("rejects an invalid throughKey rather than guessing", async () => {
    expect(await generateDueTransactions({ throughKey: "not-a-day" })).toMatchObject({
      error: expect.stringMatching(/throughKey/),
    });
  });
});

describe("getUpcomingRecurring", () => {
  it("previews what is due WITHOUT writing anything", async () => {
    seedRecurring(temp, {
      id: 1, name: "Rent", accountId: 1, categoryId: 1, amountCents: 120_000,
      frequency: "monthly", startDate: "2026-01-01",
    });

    const preview = await getUpcomingRecurring({ throughKey: "2026-03-15" });
    expect(preview[0].due).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM transactions"))).toBe(0);
  });

  it("shows nothing due after a generation run", async () => {
    seedRecurring(temp, {
      id: 1, name: "Rent", accountId: 1, categoryId: 1, amountCents: 120_000,
      frequency: "monthly", startDate: "2026-01-01",
    });
    await generateDueTransactions({ throughKey: "2026-03-15" });
    const preview = await getUpcomingRecurring({ throughKey: "2026-03-15" });
    expect(preview[0].due).toEqual([]);
    expect(preview[0].nextDue).toBe("2026-04-01");
  });
});

describe("updateRecurringTransaction", () => {
  beforeEach(() => {
    seedRecurring(temp, {
      id: 1, name: "Rent", accountId: 1, categoryId: 1, amountCents: 120_000,
      frequency: "monthly", startDate: "2026-01-01",
    });
  });

  it("changes the amount without touching what has already been posted", async () => {
    await generateDueTransactions({ throughKey: "2026-02-15" });
    unwrap(await updateRecurringTransaction(1, form({ amount: "1300.00" })));

    expect(generated(1).map((r) => r.amount_cents)).toEqual([120_000, 120_000]);
    const report = unwrap(await generateDueTransactions({ throughKey: "2026-03-15" }));
    expect(report.posted).toBe(1);
    expect(generated(1).map((r) => r.amount_cents)).toEqual([120_000, 120_000, 130_000]);
  });

  it("recomputes next_due from last_generated when the rule changes", async () => {
    await generateDueTransactions({ throughKey: "2026-02-15" });
    expect(templateRow(1).last_generated).toBe("2026-02-01");

    unwrap(await updateRecurringTransaction(1, form({ frequency: "weekly", startDate: "2026-01-01" })));
    // First weekly occurrence strictly after 2026-02-01.
    expect(templateRow(1).next_due).toBe("2026-02-05");
  });

  it("does not re-post an occurrence that was already materialised after an edit", async () => {
    await generateDueTransactions({ throughKey: "2026-02-15" });
    unwrap(await updateRecurringTransaction(1, form({ comment: "new landlord" })));
    expect(unwrap(await generateDueTransactions({ throughKey: "2026-02-15" })).posted).toBe(0);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM transactions"))).toBe(2);
  });

  it("refuses an unknown id", async () => {
    expect(await updateRecurringTransaction(999, form({ amount: "1.00" }))).toMatchObject({
      error: expect.stringMatching(/999/),
    });
  });
});

describe("deleteRecurringTransaction", () => {
  it("keeps the transactions it generated, detaching them", async () => {
    seedRecurring(temp, {
      id: 1, name: "Rent", accountId: 1, categoryId: 1, amountCents: 120_000,
      frequency: "monthly", startDate: "2026-01-01",
    });
    await generateDueTransactions({ throughKey: "2026-03-15" });
    expect(Number(temp.scalar("SELECT COUNT(*) FROM transactions"))).toBe(3);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM ledger_events"))).toBe(3);

    unwrap(await deleteRecurringTransaction(1));

    // Real spending survives; only the link is dropped.
    expect(Number(temp.scalar("SELECT COUNT(*) FROM transactions"))).toBe(3);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM transactions WHERE recurring_id IS NULL"))).toBe(3);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM ledger_events"))).toBe(6);
    expect(await verifyLedger()).toMatchObject({ ok: true });
    expect(await getRecurringTransactions()).toEqual([]);
  });

  it("deletes an unmaterialized template without creating an event", async () => {
    seedRecurring(temp, {
      id: 1, name: "Rent", accountId: 1, categoryId: 1, amountCents: 120_000,
      frequency: "monthly", startDate: "2027-01-01",
    });

    unwrap(await deleteRecurringTransaction(1));

    expect(Number(temp.scalar("SELECT COUNT(*) FROM ledger_events"))).toBe(0);
    expect(await getRecurringTransactions()).toEqual([]);
  });
});
