import { describe, expect, it } from "vitest";

import { databaseBefore, runMigration } from "./support/migrations";

describe("migration 0007", () => {
  it("preserves existing countries and cascades country deletion to checkpoints", async () => {
    const db = await databaseBefore(7);
    try {
      db.run("INSERT INTO visited_countries (country_code, country_name) VALUES ('LBN', 'Lebanon')");

      runMigration(db, 7);

      expect(db.exec("SELECT COUNT(*) FROM visited_countries")[0].values[0][0]).toBe(1);
      db.run("PRAGMA foreign_keys = ON");
      db.run(
        "INSERT INTO travel_checkpoints (country_code, city_name, latitude, longitude) VALUES ('LBN', 'Beirut', 33.8938, 35.5018)",
      );
      db.run("DELETE FROM visited_countries WHERE country_code = 'LBN'");
      expect(db.exec("SELECT COUNT(*) FROM travel_checkpoints")[0].values[0][0]).toBe(0);
    } finally {
      db.close();
    }
  });
});
