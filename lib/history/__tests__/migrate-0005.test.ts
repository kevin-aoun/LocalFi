
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";

import { detect0005State, format0005Report, migrateDatabaseTo0005 } from "../migrate-0005";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "drizzle", "migrations");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
const TAG = "0005_reconstructed_net_worth";

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
let journal: { entries: Array<{ idx: number; tag: string }> };

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(PROJECT_ROOT, "node_modules/sql.js/dist", file),
  });
  journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8"));
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function execScript(db: Database, sql: string) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

function replay(throughIdx = Infinity): Database {
  const db = new SQL.Database();
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    if (entry.idx > throughIdx) break;
    execScript(db, readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf-8"));
  }
  return db;
}

/** A pre-0005 database on disk, holding two MEASURED snapshots. */
function preMigrationFile(): { file: string; backupDir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "budget-0005-"));
  dirs.push(dir);
  const db = replay(4);
  db.run(
    `INSERT INTO net_worth_snapshots (id, date, total_assets_cents, total_liabilities_cents, net_worth_cents)
     VALUES (1, '2026-08-05', 970000, 0, 970000), (2, '2026-08-06', 975709, 0, 975709)`,
  );
  const file = path.join(dir, "budget.db");
  writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return { file, backupDir: path.join(dir, "backups") };
}

function query(file: string, sql: string): unknown[][] {
  const db = new SQL.Database(readFileSync(file));
  try {
    return db.exec(sql)[0]?.values ?? [];
  } finally {
    db.close();
  }
}

describe("journal", () => {
  it("keeps 0005 at index 5, with a snapshot chained to 0004", () => {
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    expect(entries.find((entry) => entry.idx === 5)).toMatchObject({ idx: 5, tag: TAG });
    const previous = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, "meta", "0004_snapshot.json"), "utf-8"));
    const current = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, "meta", "0005_snapshot.json"), "utf-8"));
    expect(current.prevId).toBe(previous.id);
    expect(current.tables.net_worth_snapshots.columns.source).toMatchObject({
      notNull: true,
      default: "'recorded'",
    });
  });
});

describe("replayed from empty", () => {
  it("adds source (NOT NULL, defaulting to 'recorded') and a nullable source_note", () => {
    const db = replay();
    try {
      const columns = db.exec("PRAGMA table_info(net_worth_snapshots)")[0].values;
      const source = columns.find((row) => String(row[1]) === "source")!;
      const note = columns.find((row) => String(row[1]) === "source_note")!;
      expect(String(source[2]).toLowerCase()).toBe("text");
      expect(Number(source[3])).toBe(1); // NOT NULL
      expect(String(source[4])).toContain("recorded");
      expect(Number(note[3])).toBe(0); // nullable

      db.run(
        "INSERT INTO net_worth_snapshots (date, total_assets_cents, total_liabilities_cents, net_worth_cents) VALUES ('2026-01-01', 5, 0, 5)",
      );
      expect(db.exec("SELECT source, source_note FROM net_worth_snapshots")[0].values).toEqual([
        ["recorded", null],
      ]);
    } finally {
      db.close();
    }
  });

  it("accepts a reconstructed row with its note", () => {
    const db = replay();
    try {
      db.run(
        `INSERT INTO net_worth_snapshots (date, total_assets_cents, total_liabilities_cents, net_worth_cents, source, source_note)
         VALUES ('2026-01-02', 5, 0, 5, 'reconstructed', 'XAU via pax-gold proxy')`,
      );
      expect(db.exec("SELECT source, source_note FROM net_worth_snapshots")[0].values).toEqual([
        ["reconstructed", "XAU via pax-gold proxy"],
      ]);
    } finally {
      db.close();
    }
  });
});

describe("applied to an existing database", () => {
  it("labels every pre-existing snapshot 'recorded' and changes not one figure", async () => {
    const { file, backupDir } = preMigrationFile();
    const before = query(file, "SELECT id, date, net_worth_cents FROM net_worth_snapshots ORDER BY id");

    const result = await migrateDatabaseTo0005({ dbPath: file, backupDir });
    expect(result.alreadyMigrated).toBe(false);
    expect(result.labelledRecorded).toBe(2);
    expect(result.countsBefore).toEqual(result.countsAfter);

    expect(query(file, "SELECT id, date, net_worth_cents FROM net_worth_snapshots ORDER BY id")).toEqual(before);
    expect(query(file, "SELECT source, source_note FROM net_worth_snapshots ORDER BY id")).toEqual([
      ["recorded", null],
      ["recorded", null],
    ]);
    expect(format0005Report(result)).toMatch(/all labelled 'recorded'/);
  });

  it("writes a byte-for-byte backup before touching anything", async () => {
    const { file, backupDir } = preMigrationFile();
    const original = readFileSync(file);

    const result = await migrateDatabaseTo0005({ dbPath: file, backupDir });
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(readFileSync(result.backupPath!).equals(original)).toBe(true);
    expect(readdirSync(backupDir).some((name) => name.includes("pre-0005"))).toBe(true);
  });

  it("restores the backup and throws when verification fails", async () => {
    const { file, backupDir } = preMigrationFile();
    const original = readFileSync(file);

    await expect(
      migrateDatabaseTo0005({
        dbPath: file,
        backupDir,
        // Exactly the disaster this verification exists for: a measured row
        // silently relabelled as an estimate.
        corruptForTest: (db) => db.run("UPDATE net_worth_snapshots SET source = 'reconstructed' WHERE id = 1"),
      }),
    ).rejects.toThrow(/labelled 'recorded'/);

    expect(readFileSync(file).equals(original)).toBe(true);
  });

  it("writes nothing in dry-run mode", async () => {
    const { file, backupDir } = preMigrationFile();
    const original = readFileSync(file);
    const result = await migrateDatabaseTo0005({ dbPath: file, backupDir, dryRun: true });
    expect(result.labelledRecorded).toBe(2);
    expect(result.backupPath).toBeNull();
    expect(readFileSync(file).equals(original)).toBe(true);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("is a reported no-op the second time", async () => {
    const { file, backupDir } = preMigrationFile();
    await migrateDatabaseTo0005({ dbPath: file, backupDir });
    const after = readFileSync(file);

    const again = await migrateDatabaseTo0005({ dbPath: file, backupDir });
    expect(again.alreadyMigrated).toBe(true);
    expect(again.backupPath).toBeNull();
    expect(readFileSync(file).equals(after)).toBe(true);
    expect(format0005Report(again)).toMatch(/Already migrated/);
  });

  it("refuses a half-migrated table", () => {
    const db = replay(4);
    try {
      db.run("ALTER TABLE net_worth_snapshots ADD COLUMN source text DEFAULT 'recorded' NOT NULL");
      expect(() => detect0005State(db)).toThrow(/half-migrated/);
    } finally {
      db.close();
    }
  });
});
