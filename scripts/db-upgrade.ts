import path from "node:path";

import { resolveDbPath } from "../lib/db/client";
import { upgradeDatabase } from "../lib/db/upgrade";
import { acquireWriterLease } from "../lib/db/writer-lease";

type CliOptions = { dbPath: string; dryRun: boolean };

function usage() {
  return [
    "Usage: bun run db:upgrade -- [--db <path>] [--dry-run]",
    "",
    "Acquires the same writer lease as the app, backs up an existing database",
    "when work is pending, applies and verifies the migration journal, and exits.",
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions {
  let dbPath: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--db") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--db requires a path");
      dbPath = path.resolve(process.cwd(), value);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exitCode = 0;
      return { dbPath: resolveDbPath(), dryRun: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { dbPath: dbPath ?? resolveDbPath(), dryRun };
}

export async function runDbUpgrade(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const options = parseArgs(args);
  const lease = await acquireWriterLease(options.dbPath);
  try {
    const result = await upgradeDatabase({
      ...options,
      lease,
      passphrase: process.env.LOCALFI_VAULT_PASSPHRASE,
    });
    lease.assertOwned();
    console.log(`${options.dryRun ? "Checked" : "Ready"}: ${result.dbPath}`);
    if (result.pending.length > 0) {
      console.log(`${options.dryRun ? "Pending" : "Applied"}: ${result.pending.join(", ")}`);
    } else {
      console.log("No migrations pending.");
    }
    if (result.adopted.length > 0) {
      console.log(`Journal adopted existing schema through ${result.adopted.at(-1)}.`);
    }
    if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
    if (options.dryRun) console.log("Dry run only; no database or backup was written.");
    return result;
  } finally {
    await lease.release();
  }
}

if (/db-upgrade\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  runDbUpgrade().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
