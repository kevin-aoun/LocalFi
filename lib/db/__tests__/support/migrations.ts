import { readFileSync } from "node:fs";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "drizzle", "migrations");

let runtime: ReturnType<typeof initSqlJs> | undefined;

function journalTags(): Array<{ idx: number; tag: string }> {
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  return [...journal.entries].sort((a, b) => a.idx - b.idx);
}

/** Applies one generated migration's SQL exactly as Drizzle wrote it. */
export function runMigration(db: Database, idx: number): void {
  const entry = journalTags().find((candidate) => candidate.idx === idx);
  if (!entry) throw new Error(`No migration ${idx} in the journal`);
  const source = readFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

/** A fresh in-memory database with every migration before `idx` applied. */
export async function databaseBefore(idx: number): Promise<Database> {
  runtime ??= initSqlJs({ locateFile: (file) => path.join(ROOT, "node_modules/sql.js/dist", file) });
  const db = new (await runtime).Database();
  for (const entry of journalTags()) {
    if (entry.idx >= idx) break;
    runMigration(db, entry.idx);
  }
  return db;
}
