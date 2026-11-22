import { describe, expect, it } from "vitest";

import { toDateKey } from "../../dates";
import { upgradeDatabaseImage } from "../upgrade";
import { databaseBefore, runMigration } from "./support/migrations";

async function pre0009Database(options?: { mixedTransfer?: boolean }) {
  const db = await databaseBefore(9);
  db.run("UPDATE accounts SET created_at = strftime('%s', '2020-02-03T12:00:00Z') WHERE id = 1");
  db.run(
    "INSERT INTO accounts (id, name, kind, type, opening_balance_cents, currency, archived, created_at) " +
      "VALUES (2, 'Savings', 'asset', 'Savings', -5000, ?, 0, strftime('%s', '2021-04-05T23:00:00Z'))",
    [options?.mixedTransfer ? "EUR" : "USD"],
  );
  db.run(
    "INSERT INTO categories (id, name, type, icon, color) VALUES " +
      "(1, 'Salary', 'Income', 'Wallet', '#0f0'), (2, 'Food', 'Expense', 'Wallet', '#f00')",
  );
  db.run(
    "INSERT INTO transactions (id, date, category_id, account_id, amount_cents) VALUES " +
      "(1, 1, 1, 1, 10000), (2, 2, 2, 1, -2500)",
  );
  db.run(
    "INSERT INTO transactions (id, date, category_id, account_id, transfer_account_id, amount_cents) " +
      "VALUES (3, 3, NULL, 1, 2, -3000)",
  );
  return db;
}

describe("migration 0009", () => {
  it.each([
    ["Pacific/Kiritimati", "2021-04-06"],
    ["Pacific/Niue", "2021-04-05"],
  ])("backfills opening dates as local calendar keys in %s", async (timezone, expectedDate) => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = timezone;
    try {
      const db = await pre0009Database();
      try {
        runMigration(db, 9);
        expect(
          db.exec("SELECT opening_balance_date FROM accounts WHERE id = 2")[0].values,
        ).toEqual([[expectedDate]]);
      } finally {
        db.close();
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("backfills immutable semantics and opening dates while preserving signed effects", async () => {
    const db = await pre0009Database();
    runMigration(db, 9);
    expect(db.exec("SELECT id, opening_balance_cents, opening_balance_date FROM accounts ORDER BY id")[0].values)
      .toEqual([
        [1, 0, toDateKey(new Date("2020-02-03T12:00:00Z"))],
        [2, 5000, toDateKey(new Date("2021-04-05T23:00:00Z"))],
      ]);
    expect(
      db.exec(
        "SELECT id, account_id, transfer_account_id, amount_cents, direction, currency FROM transactions ORDER BY id",
      )[0].values,
    ).toEqual([
      [1, 1, null, 10000, "inflow", "USD"],
      [2, 1, null, 2500, "inflow", "USD"],
      [3, 2, 1, 3000, "transfer", "USD"],
    ]);

    expect(() =>
      db.run(
        "INSERT INTO transactions (date, category_id, account_id, amount_cents, direction, currency) VALUES (4, 2, 1, -1, 'outflow', 'USD')",
      ),
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      db.run(
        "INSERT INTO transactions (date, category_id, account_id, amount_cents, direction, currency) VALUES (4, 2, 1, 1.5, 'outflow', 'USD')",
      ),
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      db.run(
        "INSERT INTO transactions (date, category_id, account_id, amount_cents, direction, currency) VALUES (4, 2, 1, 1, 'sideways', 'USD')",
      ),
    ).toThrow(/CHECK constraint/i);
    expect(() => db.run("UPDATE transactions SET direction = 'legacy' WHERE id = 1")).toThrow(
      /insert-only/i,
    );
    expect(() => db.run("UPDATE accounts SET opening_balance_cents = -1 WHERE id = 1")).toThrow(
      /CHECK constraint/i,
    );
    expect(() => db.run("UPDATE accounts SET opening_balance_cents = 1.5 WHERE id = 1")).toThrow(
      /CHECK constraint/i,
    );
    expect(() => db.run("UPDATE accounts SET currency = 'EUR' WHERE id = 1")).toThrow(
      /currency is immutable/i,
    );
    db.run(
      "INSERT INTO accounts (id, name, kind, type, opening_balance_cents, opening_balance_date, currency, archived) " +
        "VALUES (4, 'Euro', 'asset', 'Checking', 0, '2020-01-01', 'EUR', 0)",
    );
    expect(() =>
      db.run(
        "INSERT INTO transactions (date, category_id, account_id, transfer_account_id, amount_cents, direction, currency) " +
          "VALUES (5, NULL, 1, 4, 100, 'transfer', 'USD')",
      ),
    ).toThrow(/cross-currency/i);
    db.close();
  });

  it("refuses an existing cross-currency transfer instead of inventing FX", async () => {
    const db = await pre0009Database({ mixedTransfer: true });
    const image = db.export();
    db.close();
    await expect(upgradeDatabaseImage(image)).rejects.toThrow(/cross-currency/i);
  });
});
