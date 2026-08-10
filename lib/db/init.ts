/**
 * Create a fresh database by replaying every migration in journal order.
 *
 *   bun run db:init                  # -> data/budget.db
 *   BUDGET_DB_PATH=/tmp/x.db bun run db:init
 *   bun run db:init -- --force       # discard an existing file
 *
 * The target is resolved through BUDGET_DB_PATH — the same variable
 * lib/db/client.ts reads — so scripts and tests can point this at a temp file.
 * It used to hard-code `<cwd>/data/budget.db`, which meant a test that wanted a
 * throwaway schema either duplicated the replay loop or risked initialising over
 * the user's real financial history.
 */
import initSqlJs from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

import { resolveDbPath } from "./client";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle", "migrations");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta", "_journal.json");

type JournalEntry = { idx: number; tag: string };

/**
 * Where `db:init` will write. Absolute BUDGET_DB_PATH is used as given, a
 * relative one is resolved against the current working directory, and an empty
 * or unset value falls back to `<cwd>/data/budget.db`.
 *
 * Delegates to lib/db/client.ts so the app and this script can never disagree
 * about which file is "the database".
 */
export function resolveInitDbPath(): string {
  return resolveDbPath();
}

async function init() {
  const force = process.argv.includes("--force");
  const dbPath = resolveInitDbPath();

  // Creating the schema means starting from an empty file, so never clobber a
  // database that already holds data unless asked to explicitly.
  if (existsSync(dbPath) && !force) {
    const size = readFileSync(dbPath).length;
    if (size > 0) {
      console.error(`Refusing to overwrite existing database (${size} bytes) at ${dbPath}`);
      console.error("Re-run with --force to discard it, or delete the file yourself.");
      process.exit(1);
    }
  }

  console.log(`Initializing database at ${dbPath} ...`);

  const SQL = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules/sql.js/dist", file),
  });

  // Ensure the target directory exists (BUDGET_DB_PATH may point somewhere new).
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new SQL.Database();

  // Apply every migration in journal order, not just the baseline.
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
    entries: JournalEntry[];
  };
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  for (const entry of entries) {
    const migration = readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf-8");

    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.exec(statement);
    }

    console.log(`Applied ${entry.tag}`);
  }

  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  console.log("Tables:", tables[0]?.values.map((row) => row[0]).join(", "));

  // Save database
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(dbPath, buffer);

  console.log(`Database saved to ${dbPath} (${buffer.length} bytes)`);

  db.close();
}

// Only run when invoked directly (`tsx lib/db/init.ts`), never on import — the
// resolver above is imported by tests.
if (/\binit\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  init().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
