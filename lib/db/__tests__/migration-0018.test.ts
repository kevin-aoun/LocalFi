import { readFileSync } from "node:fs";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..", "..", "..");
const migrations = path.join(root, "drizzle/migrations");
function apply(db: Database, tag: string) {
  for (const sql of readFileSync(path.join(migrations, `${tag}.sql`), "utf8").split("--> statement-breakpoint")) {
    if (sql.trim()) db.run(sql);
  }
}

describe("migration 0018", () => {
  it("preserves older transfers and allocations and enforces one linked fee per transfer", async () => {
    const SQL = await initSqlJs({ locateFile: (file) => path.join(root, "node_modules/sql.js/dist", file) });
    const db = new SQL.Database();
    const journal = JSON.parse(readFileSync(path.join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    try {
      for (const migration of journal.entries.filter((entry) => entry.idx < 18)) apply(db, migration.tag);
      db.run("PRAGMA foreign_keys = ON");
      db.run("INSERT INTO accounts (id, name, kind, type, currency) VALUES (2, 'Demo savings', 'asset', 'Savings', 'USD')");
      db.run("INSERT INTO categories (id, name, type, icon, color) VALUES (10, 'Demo fee', 'Expense', 'Wallet', '#000')");
      db.run("INSERT INTO transactions (id, account_id, transfer_account_id, amount_cents, transfer_principal_amount_cents, direction, pending) VALUES (40, 1, 2, 10250, 10000, 'transfer', 1)");
      db.run("INSERT INTO transaction_allocations (transaction_id, position, category_id, amount_cents) VALUES (40, 0, 10, 250)");
      apply(db, journal.entries.find((entry) => entry.idx === 18)!.tag);
      expect(db.exec("SELECT id, amount_cents, transfer_principal_amount_cents, fee_for_transfer_id FROM transactions")[0].values).toEqual([[40, 10250, 10000, null]]);
      expect(db.exec("SELECT transaction_id, category_id, amount_cents FROM transaction_allocations")[0].values).toEqual([[40, 10, 250]]);
      db.run("INSERT INTO transactions (id, account_id, category_id, amount_cents, direction, pending, fee_for_transfer_id) VALUES (41, 1, 10, 250, 'outflow', 1, 40)");
      expect(() => db.run("INSERT INTO transactions (account_id, category_id, amount_cents, direction, fee_for_transfer_id) VALUES (1, 10, 250, 'outflow', 40)")).toThrow(/UNIQUE/);
      expect(() => db.run("INSERT INTO transactions (account_id, category_id, amount_cents, direction, fee_for_transfer_id) VALUES (1, 10, 250, 'outflow', 999)")).toThrow(/FOREIGN KEY/);
      expect(() => db.run("DELETE FROM transactions WHERE id = 40")).toThrow(/FOREIGN KEY/);
    } finally { db.close(); }
  });
});
