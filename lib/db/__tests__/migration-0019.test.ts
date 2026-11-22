import { readFileSync } from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { upgradeDatabaseImage } from "../upgrade";

const root = path.resolve(__dirname, "..", "..", "..");
const migrations = path.join(root, "drizzle/migrations");
describe("category-driven asset forms migration", () => {
  it("preserves categories and ledger facts, recognizes existing Stock/Crypto, and adds missing defaults once", async () => {
    const SQL = await initSqlJs({ locateFile: (file) => path.join(root, "node_modules/sql.js/dist", file) });
    const before = new SQL.Database();
    const journal = JSON.parse(readFileSync(path.join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    try {
      for (const entry of journal.entries.filter((entry) => entry.idx < 19)) {
        for (const sql of readFileSync(path.join(migrations, `${entry.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (sql.trim()) before.run(sql);
      }
      before.run("INSERT INTO categories (id, name, type, icon, color) VALUES (10, 'Stock', 'Investment', 'Wallet', '#000'), (11, 'Crypto', 'Investment', 'Coins', '#111'), (12, 'Savings', 'Investment', 'Wallet', '#222')");
      const result = await upgradeDatabaseImage(before.export());
      const after = new SQL.Database(result.image);
      try {
        expect(after.exec("SELECT id, name, investment_kind FROM categories WHERE id <= 12 ORDER BY id")[0].values).toEqual([[10, "Stock", "stock"], [11, "Crypto", "crypto"], [12, "Savings", null]]);
        expect(after.exec("SELECT name, investment_kind FROM categories WHERE id > 12")[0].values).toEqual([["Commodities", "commodity"]]);
        expect(after.exec("SELECT count(*) FROM ledger_events")[0].values).toEqual([[0]]);
        expect(after.exec("PRAGMA table_info(transactions)")[0].values.some((row) => row[1] === "investment_draft")).toBe(true);
        expect((await upgradeDatabaseImage(result.image)).changed).toBe(false);
      } finally { after.close(); }
    } finally { before.close(); }
  });
});
