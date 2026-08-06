import type { Database } from "sql.js";

import { applyAdditiveMigration, tableExists, tableHasColumn } from "./migrate-additive";

const migration = {
  id: "0007",
  sqlPath: "drizzle/migrations/0007_travel_checkpoints.sql",
  isApplied: (db: Database) => tableExists(db, "travel_checkpoints"),
  assertPrerequisites(db: Database) {
    if (!tableExists(db, "visited_countries")) {
      throw new Error("visited_countries is missing; initialize the base schema first.");
    }
  },
  assertResult(db: Database) {
    if (!tableExists(db, "travel_checkpoints")) {
      throw new Error("travel_checkpoints was not created");
    }
    for (const column of ["country_code", "city_name", "latitude", "longitude", "visited_at"]) {
      if (!tableHasColumn(db, "travel_checkpoints", column)) {
        throw new Error(`travel_checkpoints.${column} is missing`);
      }
    }
  },
};

export function migrateToTravelCheckpoints(options: { dbPath?: string; dryRun?: boolean } = {}) {
  return applyAdditiveMigration(migration, options);
}

async function main() {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf("--db");
  const result = await migrateToTravelCheckpoints({
    dbPath: dbIndex >= 0 ? args[dbIndex + 1] : undefined,
    dryRun: args.includes("--dry-run"),
  });
  console.log(result.alreadyMigrated ? "Migration 0007 is already applied." : "Migration 0007 verified.");
  console.log(`Database: ${result.dbPath}`);
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
  if (args.includes("--dry-run")) console.log("Dry run only; the database was not changed.");
}

if (/migrate-to-travel-checkpoints\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("Migration 0007 failed; the database was left unchanged or restored.");
    console.error(error);
    process.exit(1);
  });
}
