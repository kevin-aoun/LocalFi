import type { Database } from "sql.js";

import { applyAdditiveMigration, tableExists, tableHasColumn } from "./migrate-additive";

const migration = {
  id: "0008",
  sqlPath: "drizzle/migrations/0008_travel-routes.sql",
  isApplied: (db: Database) => tableHasColumn(db, "travel_checkpoints", "origin_city_id"),
  assertPrerequisites(db: Database) {
    if (!tableExists(db, "travel_checkpoints")) {
      throw new Error("travel_checkpoints is missing; apply migration 0007 first.");
    }
  },
  assertResult(db: Database) {
    if (!tableHasColumn(db, "travel_checkpoints", "origin_city_id")) {
      throw new Error("travel_checkpoints.origin_city_id is missing");
    }
    const originForeignKey = (db.exec("PRAGMA foreign_key_list(travel_checkpoints)")[0]?.values ?? [])
      .find((row) => String(row[3]) === "origin_city_id");
    if (!originForeignKey || String(originForeignKey[6]).toUpperCase() !== "SET NULL") {
      throw new Error("origin_city_id must use ON DELETE SET NULL");
    }
  },
};

export function migrateToTravelRoutes(options: { dbPath?: string; dryRun?: boolean } = {}) {
  return applyAdditiveMigration(migration, options);
}

async function main() {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf("--db");
  const result = await migrateToTravelRoutes({
    dbPath: dbIndex >= 0 ? args[dbIndex + 1] : undefined,
    dryRun: args.includes("--dry-run"),
  });
  console.log(result.alreadyMigrated ? "Migration 0008 is already applied." : "Migration 0008 verified.");
  console.log(`Database: ${result.dbPath}`);
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
  if (args.includes("--dry-run")) console.log("Dry run only; the database was not changed.");
}

if (/migrate-to-travel-routes\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("Migration 0008 failed; the database was left unchanged or restored.");
    console.error(error);
    process.exit(1);
  });
}
