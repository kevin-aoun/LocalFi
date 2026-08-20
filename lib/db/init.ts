
import initSqlJs from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

import { resolveDbPath } from "./client";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle", "migrations");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta", "_journal.json");

type JournalEntry = { idx: number; tag: string };

export function resolveInitDbPath(): string {
  return resolveDbPath();
}

async function init() {
  const force = process.argv.includes("--force");
  const dbPath = resolveInitDbPath();

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


  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new SQL.Database();


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


  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(dbPath, buffer);

  console.log(`Database saved to ${dbPath} (${buffer.length} bytes)`);

  db.close();
}



if (/\binit\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  init().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
