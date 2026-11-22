import { describe, expect, it } from "vitest";

import { databaseBefore, runMigration } from "./support/migrations";

describe("migration 0006", () => {
  it("adds budget reallocations and preserves existing rows", async () => {
    const db = await databaseBefore(6);
    try {
      db.run("INSERT INTO categories (id, name, type, icon, color) VALUES (1, 'Gifts', 'Expense', 'Gift', '#fff')");

      runMigration(db, 6);

      expect(db.exec("SELECT id, name FROM categories")[0].values).toEqual([[1, "Gifts"]]);
      expect(
        db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='budget_reallocations'")[0]?.values,
      ).toEqual([[1]]);
      expect(db.exec("PRAGMA foreign_key_check")[0]?.values ?? []).toEqual([]);
    } finally {
      db.close();
    }
  });
});
