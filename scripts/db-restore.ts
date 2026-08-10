import path from "node:path";

import { resolveDbPath } from "../lib/db/client";
import { restoreDatabase } from "../lib/db/restore";
import { acquireWriterLease } from "../lib/db/writer-lease";

export type RestoreCliOptions = {
  sourcePath: string;
  dbPath: string;
  apply: boolean;
};

export function restoreUsage(): string {
  return [
    "Usage: bun run db:restore -- --from <backup.db> [--db <target.db>] [--apply]",
    "",
    "Default: validate and preview only. No database or backup is written.",
    "After reviewing the paths, run the same command with --apply.",
    "Apply mode creates a byte-for-byte pre-restore backup before replacement.",
  ].join("\n");
}

export function parseRestoreArgs(args: string[]): RestoreCliOptions | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  let sourcePath: string | undefined;
  let dbPath: string | undefined;
  let apply = false;
  let sawApply = false;
  let sawDryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      sawApply = true;
      apply = true;
    } else if (arg === "--dry-run") {
      sawDryRun = true;
      apply = false;
    } else if (arg === "--from" || arg === "--backup") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      sourcePath = path.resolve(process.cwd(), value);
      index += 1;
    } else if (arg === "--db") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--db requires a path");
      dbPath = path.resolve(process.cwd(), value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (sawApply && sawDryRun) throw new Error("Choose either --apply or --dry-run, not both");
  if (!sourcePath) throw new Error("--from requires the backup database path");
  return { sourcePath, dbPath: dbPath ?? resolveDbPath(), apply };
}

export async function runDbRestore(args = process.argv.slice(2)) {
  const options = parseRestoreArgs(args);
  if (!options) {
    console.log(restoreUsage());
    return null;
  }

  // DECISION: DEC-005 -- even a restore preview must refuse a live writer.
  const lease = await acquireWriterLease(options.dbPath);
  try {
    const result = await restoreDatabase({ ...options, lease });
    lease.assertOwned();
    console.log(`Validated restore source: ${result.sourcePath}`);
    console.log(`Target database: ${result.dbPath}`);
    console.log(`Image: ${result.byteLength} bytes, sha256 ${result.sha256}`);
    if (result.dryRun) {
      console.log("Dry run only; no database or backup was written.");
      console.log("Review these paths, then repeat with --apply to restore.");
    } else {
      console.log("Restore applied atomically.");
      if (result.preRestoreBackupPath) {
        console.log(`Pre-restore backup: ${result.preRestoreBackupPath}`);
      } else {
        console.log("The target did not exist, so no pre-restore generation was needed.");
      }
    }
    return result;
  } finally {
    await lease.release();
  }
}

if (/db-restore\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  runDbRestore().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
