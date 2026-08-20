
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { sql } from "drizzle-orm";
import { closeDb, getDb, readDb, resolveDbPath, saveDb, withDb } from "../client";
import { SCHEMA_JOURNAL_TABLE } from "../upgrade";
import { writerLeasePath } from "../writer-lease";

const SQLITE_HEADER = "SQLite format 3\0";

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
async function sqlJs() {
  SQL ??= await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules/sql.js/dist", file),
  });
  return SQL;
}

let tmpDir: string;
let dbPath: string;

async function makeImage(setup: (db: Database) => void): Promise<Buffer> {
  const S = await sqlJs();
  const db = new S.Database();
  setup(db);
  const buf = Buffer.from(db.export());
  db.close();
  return buf;
}

async function readNames(file: string, table = "items"): Promise<string[]> {
  const S = await sqlJs();
  const db = new S.Database(readFileSync(file));
  try {
    const res = db.exec(`SELECT name FROM ${table} ORDER BY name`);
    return (res[0]?.values ?? []).map((row) => String(row[0]));
  } finally {
    db.close();
  }
}

/** Seed dbPath with a one-table schema, bypassing the client. */
async function seedItemsDb(names: string[] = []) {
  const image = await makeImage((db) => {
    db.run("CREATE TABLE items (id integer primary key autoincrement, name text not null)");
    for (const name of names) db.run("INSERT INTO items (name) VALUES (?)", [name]);
  });
  writeFileSync(dbPath, image);
}

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "budget-db-test-"));
  dbPath = path.join(tmpDir, "budget.db");
  process.env.BUDGET_DB_PATH = dbPath;
  await closeDb();
});

afterEach(async () => {
  await closeDb();
  delete process.env.BUDGET_DB_PATH;
  try {
    chmodSync(tmpDir, 0o700);
  } catch {
    /* dir may already be gone */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("path override", () => {
  it("honours BUDGET_DB_PATH and falls back to data/budget.db", () => {
    expect(resolveDbPath()).toBe(dbPath);
    delete process.env.BUDGET_DB_PATH;
    expect(resolveDbPath()).toBe(path.resolve(process.cwd(), "data", "budget.db"));
    process.env.BUDGET_DB_PATH = dbPath;
  });
});

describe("concurrent mutations (lost-update regression)", () => {
  it("keeps both rows when two withDb mutations run concurrently", async () => {
    await seedItemsDb();

    const insert = (name: string) =>
      withDb(async (_db, raw) => {
        raw.run("INSERT INTO items (name) VALUES (?)", [name]);
        // Any await point inside a Server Action: this is where the old
        // implementation let a second getDb() clobber the global handle.
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

    const a = insert("X"); // started, deliberately not awaited
    const b = insert("Y");
    await Promise.all([a, b]);

    expect(await readNames(dbPath)).toEqual(["X", "Y"]);
  });

  it("keeps both rows for the legacy getDb/saveDb shape too", async () => {
    await seedItemsDb();

    async function legacyInsert(name: string) {
      const db = await getDb();
      await db.run(sql.raw(`INSERT INTO items (name) VALUES ('${name}')`));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await saveDb();
    }

    const a = legacyInsert("X");
    const b = legacyInsert("Y");
    await Promise.all([a, b]);

    expect(await readNames(dbPath)).toEqual(["X", "Y"]);
  });

  it("serialises many concurrent mutations without dropping any", async () => {
    await seedItemsDb();
    const names = Array.from({ length: 12 }, (_, i) => `row-${String(i).padStart(2, "0")}`);
    await Promise.all(
      names.map((name) =>
        withDb((_db, raw) => {
          raw.run("INSERT INTO items (name) VALUES (?)", [name]);
        }),
      ),
    );
    expect(await readNames(dbPath)).toEqual(names);
  });
});

describe("atomic, durable writes", () => {
  it("leaves no temp file behind and replaces the target by rename", async () => {
    await seedItemsDb(["seed"]);
    const before = statSync(dbPath).ino;

    await withDb((_db, raw) => {
      raw.run("INSERT INTO items (name) VALUES ('written')");
    });

    const entries = readdirSync(tmpDir);
    expect(entries.filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(entries).toContain("budget.db");
    // A rename swapped a brand-new inode into place instead of rewriting the
    // live file in place, which is what makes the write atomic.
    expect(statSync(dbPath).ino).not.toBe(before);
    expect(readFileSync(dbPath).subarray(0, 16).toString("binary")).toBe(SQLITE_HEADER);
    expect(await readNames(dbPath)).toEqual(["seed", "written"]);
  });

  it("keeps the previous generation in budget.db.bak", async () => {
    await seedItemsDb();
    await withDb((_db, raw) => raw.run("INSERT INTO items (name) VALUES ('X')"));
    await withDb((_db, raw) => raw.run("INSERT INTO items (name) VALUES ('Y')"));

    const bak = `${dbPath}.bak`;
    expect(existsSync(bak)).toBe(true);
    expect(await readNames(bak)).toEqual(["X"]);
    expect(await readNames(dbPath)).toEqual(["X", "Y"]);
  });

  it("fails closed when the backup generation is obstructed, then retries cleanly", async () => {
    await seedItemsDb();
    await withDb((_db, raw) => raw.run("INSERT INTO items (name) VALUES ('X')"));

    const original = readFileSync(dbPath);
    const backup = `${dbPath}.bak`;
    rmSync(backup, { force: true });
    mkdirSync(backup);

    await expect(
      withDb((_db, raw) => raw.run("INSERT INTO items (name) VALUES ('doomed')")),
    ).rejects.toThrow(/Could not refresh recoverable database backup.*Remove the obstruction/i);

    expect(readFileSync(dbPath).equals(original)).toBe(true);
    expect(await readNames(dbPath)).toEqual(["X"]);
    expect(readdirSync(tmpDir).filter((file) => file.includes(".tmp"))).toEqual([]);

    rmSync(backup, { recursive: true, force: true });
    await withDb((_db, raw) => raw.run("INSERT INTO items (name) VALUES ('recovered')"));

    expect(await readNames(backup)).toEqual(["X"]);
    expect(await readNames(dbPath)).toEqual(["X", "recovered"]);
  });

  it("leaves the existing database intact when the write cannot complete", async () => {
    await seedItemsDb(["safe"]);
    const original = readFileSync(dbPath);

    chmodSync(tmpDir, 0o500); // read-only directory: temp file creation fails
    await expect(
      withDb((_db, raw) => raw.run("INSERT INTO items (name) VALUES ('doomed')")),
    ).rejects.toThrow();
    chmodSync(tmpDir, 0o700);

    expect(readFileSync(dbPath).equals(original)).toBe(true);
    expect(await readNames(dbPath)).toEqual(["safe"]);

    // The failed write is not smuggled into the next successful one.
    await withDb((_db, raw) => raw.run("INSERT INTO items (name) VALUES ('later')"));
    expect(await readNames(dbPath)).toEqual(["later", "safe"]);
  });
});

describe("corruption refusal", () => {
  it("throws instead of silently starting empty on a garbage file", async () => {
    const garbage = Buffer.from("not a database, just bytes".repeat(40));
    writeFileSync(dbPath, garbage);

    await expect(withDb(() => "unreachable")).rejects.toThrow(/not a valid SQLite database/i);
    // The bad file must survive so it can be inspected/recovered.
    expect(readFileSync(dbPath).equals(garbage)).toBe(true);
  });

  it("throws on a truncated SQLite image", async () => {
    const image = await makeImage((db) => {
      db.run("CREATE TABLE items (id integer primary key, name text)");
      db.run("INSERT INTO items VALUES (1, 'X')");
    });
    const truncated = image.subarray(0, 200);
    writeFileSync(dbPath, truncated);

    await expect(withDb(() => "unreachable")).rejects.toThrow();
    expect(readFileSync(dbPath).length).toBe(truncated.length);
  });

  it("throws on getDb() too, rather than handing back an empty database", async () => {
    writeFileSync(dbPath, Buffer.alloc(4096, 0x41));
    await expect(getDb()).rejects.toThrow(/not a valid SQLite database/i);
  });
});

describe("bootstrap", () => {
  it("creates a fresh database when the file is absent", async () => {
    expect(existsSync(dbPath)).toBe(false);
    const tables = await withDb((_db, raw) => {
      raw.run("CREATE TABLE items (id integer primary key, name text)");
      raw.run("INSERT INTO items VALUES (1, 'fresh')");
      return raw.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.length ?? 0;
    });
    expect(tables).toBeGreaterThan(0);
    expect(existsSync(dbPath)).toBe(true);
    expect(await readNames(dbPath)).toEqual(["fresh"]);
  });

  it("creates a fresh database from a zero-byte file", async () => {
    writeFileSync(dbPath, Buffer.alloc(0));
    await withDb((_db, raw) => {
      raw.run("CREATE TABLE items (id integer primary key, name text)");
      raw.run("INSERT INTO items VALUES (1, 'fresh')");
    });
    expect(statSync(dbPath).size).toBeGreaterThan(0);
    expect(await readNames(dbPath)).toEqual(["fresh"]);
  });

  it("creates the parent directory if it does not exist", async () => {
    dbPath = path.join(tmpDir, "nested", "deeper", "budget.db");
    process.env.BUDGET_DB_PATH = dbPath;
    await closeDb();
    await withDb((_db, raw) => raw.run("CREATE TABLE items (id integer, name text)"));
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe("foreign keys", () => {
  it("rejects a child row with a dangling foreign key", async () => {
    await withDb((_db, raw) => {
      raw.run("CREATE TABLE parents (id integer primary key)");
      raw.run(
        "CREATE TABLE children (id integer primary key, parent_id integer NOT NULL REFERENCES parents(id))",
      );
      raw.run("INSERT INTO parents (id) VALUES (1)");
      raw.run("INSERT INTO children (id, parent_id) VALUES (1, 1)");
    });

    await expect(
      withDb((_db, raw) => raw.run("INSERT INTO children (id, parent_id) VALUES (2, 999)")),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);

    // Pragma survives a reload from disk, not just the first bootstrap.
    await closeDb();
    await expect(
      withDb((_db, raw) => raw.run("INSERT INTO children (id, parent_id) VALUES (3, 999)")),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });
});

describe("lock lifecycle", () => {
  it("releases the lock when the callback throws", async () => {
    await seedItemsDb(["seed"]);

    await expect(
      withDb(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // No deadlock: the next mutation still runs and still persists.
    await withDb((_db, raw) => raw.run("INSERT INTO items (name) VALUES ('after')"));
    expect(await readNames(dbPath)).toEqual(["after", "seed"]);
  });

  it("does not persist the mutations of a callback that threw", async () => {
    await seedItemsDb(["seed"]);

    await expect(
      withDb((_db, raw) => {
        raw.run("INSERT INTO items (name) VALUES ('rolled-back')");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await readNames(dbPath)).toEqual(["seed"]);
    await withDb((_db, raw) => raw.run("INSERT INTO items (name) VALUES ('kept')"));
    expect(await readNames(dbPath)).toEqual(["kept", "seed"]);
  });
});

describe("readDb", () => {
  it("does not rewrite an already-ready database", async () => {
    await seedItemsDb(["only"]);
    await readDb(() => undefined); // first access performs the readiness upgrade
    const before = statSync(dbPath);

    const names = await readDb((_db, raw) =>
      (raw.exec("SELECT name FROM items")[0]?.values ?? []).map((r) => String(r[0])),
    );

    expect(names).toEqual(["only"]);
    const after = statSync(dbPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
  });

  it("initializes and journals a missing database before the first read", async () => {
    const tables = await readDb((_db, raw) =>
      (raw.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? []).map(
        (row) => String(row[0]),
      ),
    );
    expect(tables).toContain(SCHEMA_JOURNAL_TABLE);
    expect(tables).toContain("transactions");
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe("writer lease lifecycle", () => {
  it("holds the cross-process lease until closeDb", async () => {
    await readDb(() => undefined);
    const lockPath = writerLeasePath(dbPath);
    expect(existsSync(lockPath)).toBe(true);

    await closeDb();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("drizzle surface", () => {
  it("exposes a working drizzle handle to withDb callbacks", async () => {
    await seedItemsDb();
    const rows = await withDb(async (db, raw) => {
      raw.run("INSERT INTO items (name) VALUES ('via-raw')");
      await db.run(sql`INSERT INTO items (name) VALUES ('via-drizzle')`);
      return db.all<{ name: string }>(sql`SELECT name FROM items ORDER BY name`);
    });
    expect(rows.map((r) => r.name)).toEqual(["via-drizzle", "via-raw"]);
    expect(await readNames(dbPath)).toEqual(["via-drizzle", "via-raw"]);
  });
});
