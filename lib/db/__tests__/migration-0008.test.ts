import { describe, expect, it } from "vitest";

import { databaseBefore, runMigration } from "./support/migrations";

describe("migration 0008", () => {
  it("preserves existing cities and clears routes when an origin is deleted", async () => {
    const db = await databaseBefore(8);
    try {
      db.run(
        "INSERT INTO visited_countries (country_code, country_name) VALUES ('DEU', 'Germany'), ('FRA', 'France')",
      );
      db.run(
        "INSERT INTO travel_checkpoints (id, country_code, city_name, latitude, longitude) VALUES (1, 'DEU', 'Munich', 48.14, 11.58), (2, 'FRA', 'Paris', 48.86, 2.35)",
      );

      runMigration(db, 8);

      expect(db.exec("SELECT COUNT(*) FROM travel_checkpoints")[0].values[0][0]).toBe(2);
      db.run("PRAGMA foreign_keys = ON");
      db.run("UPDATE travel_checkpoints SET origin_city_id = 1 WHERE id = 2");
      db.run("DELETE FROM travel_checkpoints WHERE id = 1");
      expect(db.exec("SELECT origin_city_id FROM travel_checkpoints WHERE id = 2")[0].values[0][0]).toBeNull();
    } finally {
      db.close();
    }
  });
});
