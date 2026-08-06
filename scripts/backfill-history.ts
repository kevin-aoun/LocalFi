/**
 * Reconstruct historical net worth and (only if asked) write it.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/backfill-history.ts --db /tmp/copy.db
 *   ... --db /tmp/copy.db --all-days
 *   ... --db /tmp/copy.db --migrate            # apply migration 0005 (backed up + verified)
 *   ... --db /tmp/copy.db --apply              # WRITE the reconstructed rows
 *
 * DRY RUN IS THE DEFAULT. With no flags this prints the whole series and writes
 * nothing at all, so the figures can be eyeballed before they become rows.
 * Writing needs `--apply`; writing to the app's own data/budget.db needs
 * `--apply --live` on top, because that file is the owner's real financial
 * history and lib/db/client.ts is a SINGLE WRITER — the Docker stack points at
 * ./data and flushes the database wholesale, so it must be stopped first.
 *
 * Flags:
 *   --db <path>        database to read (sets BUDGET_DB_PATH). Default: data/budget.db
 *   --from <YYYY-MM-DD> first day. Default: the earliest transaction
 *   --to <YYYY-MM-DD>   last day. Default: today (a future day is clamped to today)
 *   --today <YYYY-MM-DD> override "today" (tests and reproducible runs)
 *   --days <n>         price window to request, capped at 365 (the keyless ceiling)
 *   --carry-unpriced   for a holding whose price cannot be known, carry its stored
 *                      value and say so on every affected day (off by default)
 *   --all-days         print every day instead of the head/tail/month-end digest
 *   --migrate          apply migration 0005 to the target first (backup + verify)
 *   --dry-run          the default; stated explicitly it overrides --apply
 *   --apply            write the rows
 *   --live             required alongside --apply/--migrate for data/budget.db
 *   --json             emit the plan as JSON instead of a table
 */
import path from "node:path";

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function value(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const next = argv[at + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`--${name} needs a value`);
  }
  return next;
}

async function main() {
  const argv = process.argv.slice(2);
  const dbPath = path.resolve(value(argv, "db") ?? process.env.BUDGET_DB_PATH ?? path.join("data", "budget.db"));
  const isLiveFile = dbPath === path.resolve(path.join("data", "budget.db"));
  // Dry run is the default, and an explicit --dry-run BEATS --apply: if both are
  // present the safe reading of the intent is the one that writes nothing.
  const apply = flag(argv, "apply") && !flag(argv, "dry-run");
  const dryRun = !apply;

  // Every database access below — the migration included — goes through this.
  process.env.BUDGET_DB_PATH = dbPath;

  console.log("Historical net-worth reconstruction");
  console.log(`  database:  ${dbPath}`);
  console.log(`  mode:      ${dryRun ? "DRY RUN (nothing will be written)" : "APPLY (rows will be written)"}`);
  console.log("");

  if (apply && isLiveFile && !flag(argv, "live")) {
    throw new Error(
      `Refusing to write to ${dbPath} without --live.\n` +
        "That file is the real financial history, and lib/db/client.ts is a single writer that\n" +
        "flushes the whole database: stop the Docker stack (docker compose down) before writing,\n" +
        "then re-run with --apply --live. To try this out safely, copy the file and use --db.",
    );
  }

  // Imported lazily and in this order so BUDGET_DB_PATH is set before any module
  // resolves a database path.
  const { migrateDatabaseTo0005, format0005Report } = await import("@/lib/history/migrate-0005");
  const { runNetWorthReconstruction } = await import("@/lib/history/run");
  const { renderPlan, renderWriteReport } = await import("@/lib/history/format");

  if (flag(argv, "migrate")) {
    // `--migrate` IS the explicit flag for the schema change, so it applies for
    // real (backed up, verified, restored on any failure, idempotent) even during
    // a dry run of the reconstruction itself — there is nothing to preview about
    // two ADD COLUMNs, and the rows cannot be planned without them.
    if (isLiveFile && !flag(argv, "live")) {
      throw new Error(
        `Refusing to migrate ${dbPath} without --live. Stop the Docker stack first ` +
          "(lib/db/client.ts is a single writer), then re-run with --migrate --live.",
      );
    }
    const result = await migrateDatabaseTo0005({
      dbPath,
      backupDir: path.resolve(path.dirname(dbPath), "backups"),
      log: (message) => console.log(`  ${message}`),
    });
    console.log(format0005Report(result));
    console.log("");
  }

  const daysFlag = value(argv, "days");
  const run = await runNetWorthReconstruction({
    fromKey: value(argv, "from"),
    toKey: value(argv, "to"),
    today: value(argv, "today"),
    days: daysFlag === undefined ? undefined : Number(daysFlag),
    carryUnpriced: flag(argv, "carry-unpriced"),
    onPriceRateLimitRetry: (symbol, delayMs) =>
      console.log(
        `  CoinGecko rate-limited ${symbol}; waiting ${Math.ceil(delayMs / 1000)}s, then retrying once...`,
      ),
    apply,
  });

  if (!run.ok) {
    console.error("");
    console.error(`FAILED (${run.error.code}): ${run.error.message}`);
    console.error("Nothing was written.");
    process.exit(1);
    return;
  }

  if (flag(argv, "json")) {
    console.log(JSON.stringify({ plan: run.plan, write: run.write }, null, 2));
  } else {
    console.log(renderPlan(run.plan, { allDays: flag(argv, "all-days") }));
    console.log("");
    if (run.write) {
      console.log(renderWriteReport(run.write));
    } else {
      console.log("DRY RUN: nothing was written. Re-run with --apply to persist these rows");
      console.log("         (they will be marked source = 'reconstructed', and any day that already");
      console.log("          has a recorded snapshot will be skipped, not replaced).");
    }
  }
}

// Only run when invoked directly, never on import.
if (/backfill-history\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
