/**
 * SQLite (sql.js / WebAssembly) database access for the app.
 *
 * The whole database lives in memory and is flushed to a single file, so the
 * two things that matter are (1) never letting two concurrent callers each
 * load their own in-memory copy and overwrite each other's work, and (2) never
 * leaving a half-written file on disk.
 *
 * ## How to use it
 *
 *     await withDb(async (db) => {           // serialized + flushed atomically
 *       await db.insert(transactions).values(...);
 *     });
 *
 *     const rows = await readDb((db) => db.select().from(transactions)); // no flush
 *
 * `withDb` acquires a process-wide async lock, hands the callback the drizzle
 * handle (and, as a second argument, the raw sql.js handle), then writes the
 * database to disk atomically before releasing the lock. If the callback
 * throws, nothing is flushed and the in-memory image is discarded, so partial
 * work cannot leak into a later save.
 *
 * `getDb()` / `saveDb()` are deprecated shims kept for the existing callers in
 * app/actions/*.ts. They now share ONE cached in-memory database instead of
 * loading a fresh copy per call, which removes the lost-update race, but they
 * still cannot roll back or group a read-modify-write; new code should use
 * `withDb`.
 *
 * ## Environment variables
 *
 * - `BUDGET_DB_PATH` – override the database file location. Absolute, or
 *   relative to `process.cwd()`. Defaults to `<cwd>/data/budget.db`. Tests use
 *   this to work in a temp directory.
 * - `BUDGET_DB_DEBUG` – set to `1`/`true` to emit the verbose `[DB] ...`
 *   lifecycle logs. Errors and warnings are always logged.
 */
import { drizzle, type SQLJsDatabase } from "drizzle-orm/sql-js";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import * as schema from "./schema";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import path from "path";

export type BudgetDb = SQLJsDatabase<typeof schema>;
export type BudgetDbCallback<T> = (db: BudgetDb, raw: Database) => T | Promise<T>;

/** First 16 bytes of every valid SQLite file. */
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");
/** Smallest possible SQLite database (one page). */
const MIN_DB_BYTES = 512;

/** Raised when the file on disk exists but cannot be used as a database. */
export class DatabaseCorruptError extends Error {
  constructor(file: string, detail: string) {
    super(
      `Refusing to open ${file}: ${detail}. The file is NOT empty, so it is not being ` +
        `replaced with a fresh database. Inspect it, or restore the previous generation ` +
        `from ${file}.bak, then retry.`,
    );
    this.name = "DatabaseCorruptError";
  }
}

function debugEnabled() {
  const flag = process.env.BUDGET_DB_DEBUG;
  return flag === "1" || flag === "true";
}

function debug(...args: unknown[]) {
  if (debugEnabled()) console.log("[DB]", ...args);
}

/** Location of the database file. Read on every call so tests can retarget it. */
export function resolveDbPath(): string {
  const override = process.env.BUDGET_DB_PATH;
  if (override && override.trim() !== "") return path.resolve(process.cwd(), override);
  return path.resolve(process.cwd(), "data", "budget.db");
}

// ---------------------------------------------------------------------------
// sql.js runtime
// ---------------------------------------------------------------------------

let SQL: SqlJsStatic | null = null;
let sqlLoading: Promise<SqlJsStatic> | null = null;

async function initSQL(): Promise<SqlJsStatic> {
  if (SQL) return SQL;
  sqlLoading ??= initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules/sql.js/dist", file),
  }).then((loaded) => {
    SQL = loaded;
    sqlLoading = null;
    return loaded;
  });
  return sqlLoading;
}

// ---------------------------------------------------------------------------
// Global mutation lock (FIFO, one task at a time)
// ---------------------------------------------------------------------------

let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `task` after every previously queued task has settled. The queue never
 * rejects, so a throwing task can never wedge the lock.
 */
function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = tail.then(task, task);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Cached in-memory database
// ---------------------------------------------------------------------------

type LoadedDb = {
  file: string;
  raw: Database;
  orm: BudgetDb;
  /** Stat of the file as we last read/wrote it, to spot out-of-process edits. */
  stamp: { mtimeMs: number; size: number } | null;
};

let loaded: LoadedDb | null = null;
let loading: { file: string; promise: Promise<LoadedDb> } | null = null;

function stampOf(file: string) {
  if (!existsSync(file)) return null;
  const st = statSync(file);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

/**
 * True when the file changed underneath us (a script, a restored backup, a
 * `drizzle-kit push`). A deleted file does NOT count: keeping the in-memory
 * image and rewriting it is strictly safer than bootstrapping an empty one.
 */
function changedOnDisk(entry: LoadedDb) {
  const current = stampOf(entry.file);
  if (!current || !entry.stamp) return false;
  return current.size !== entry.stamp.size || current.mtimeMs !== entry.stamp.mtimeMs;
}

function assertSqliteImage(buffer: Uint8Array, file: string) {
  if (buffer.length < MIN_DB_BYTES) {
    throw new DatabaseCorruptError(file, `file is only ${buffer.length} bytes`);
  }
  const header = Buffer.from(buffer.subarray(0, SQLITE_MAGIC.length));
  if (!header.equals(SQLITE_MAGIC)) {
    throw new DatabaseCorruptError(file, "it is not a valid SQLite database (bad header)");
  }
}

/** Read the file, or `undefined` when it is genuinely absent / zero-byte. */
function readImage(file: string): Uint8Array | undefined {
  if (!existsSync(file)) {
    debug("no database file at", file, "- bootstrapping a new one");
    return undefined;
  }
  const st = statSync(file);
  if (!st.isFile()) {
    throw new DatabaseCorruptError(file, "path exists but is not a regular file");
  }
  if (st.size === 0) {
    debug("database file is zero bytes - bootstrapping a new one");
    return undefined;
  }
  const buffer = readFileSync(file);
  assertSqliteImage(buffer, file);
  debug(`read ${buffer.length} bytes from ${file}`);
  return buffer;
}

async function loadDatabase(file: string): Promise<LoadedDb> {
  const SqlJs = await initSQL();
  const stamp = stampOf(file);
  const buffer = readImage(file);

  const raw = new SqlJs.Database(buffer as Uint8Array | undefined);

  // A garbage/truncated body can still slip past the header check, and sql.js
  // only surfaces that on the first query. Fail loudly instead of pretending
  // the database is empty.
  let tables: string[];
  try {
    applySessionPragmas(raw);
    const result = raw.exec("SELECT name FROM sqlite_master WHERE type='table'");
    tables = (result[0]?.values ?? []).map((row) => String(row[0]));
  } catch (error) {
    raw.close();
    if (buffer) {
      throw new DatabaseCorruptError(
        file,
        `it is not a valid SQLite database (${(error as Error).message})`,
      );
    }
    throw error;
  }

  applyAutoMigrations(raw, tables);

  debug("tables:", tables.join(", ") || "(none)");
  return { file, raw, orm: drizzle(raw, { schema }), stamp };
}

/**
 * Connection-scoped settings. These must be re-applied every time the sql.js
 * connection is (re)opened - and note that `Database.export()` internally
 * closes and re-opens the connection, which silently resets `foreign_keys`
 * back to OFF. So this runs after every load AND after every flush.
 */
function applySessionPragmas(raw: Database) {
  raw.run("PRAGMA foreign_keys = ON");
}

/**
 * Legacy in-place migrations that used to live in getDb(). They run once per
 * load, in memory; the next flush persists them.
 */
function applyAutoMigrations(raw: Database, tables: string[]) {
  try {
    if (tables.includes("transactions")) {
      const cols = raw.exec("PRAGMA table_info(transactions)");
      const colNames = (cols[0]?.values ?? []).map((row) => String(row[1]));
      if (!colNames.includes("pending")) {
        raw.exec("ALTER TABLE transactions ADD COLUMN pending integer NOT NULL DEFAULT 0");
        debug("migrated: added transactions.pending");
      }
    }

    if (!tables.includes("visited_countries")) {
      raw.exec(`
        CREATE TABLE visited_countries (
          id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
          country_code text NOT NULL,
          country_name text NOT NULL,
          visited_at text DEFAULT (current_timestamp)
        );
        CREATE UNIQUE INDEX visited_countries_country_code_unique ON visited_countries (country_code);
      `);
      debug("migrated: created visited_countries");
    }
  } catch (error) {
    console.error("[DB] auto-migration failed:", error);
    throw error;
  }
}

/** Return the shared database, loading (or reloading) it when necessary. */
async function ensureLoaded(): Promise<LoadedDb> {
  for (;;) {
    const file = resolveDbPath();

    if (loaded) {
      if (loaded.file !== file) {
        debug("database path changed, reloading");
        invalidate();
      } else if (changedOnDisk(loaded)) {
        console.warn(`[DB] ${file} changed on disk outside this process - reloading it`);
        invalidate();
      } else {
        return loaded;
      }
    }

    if (loading) {
      if (loading.file === file) return loading.promise;
      await loading.promise.catch(() => undefined);
      continue;
    }

    const promise = loadDatabase(file).then(
      (entry) => {
        loaded = entry;
        loading = null;
        return entry;
      },
      (error) => {
        loading = null;
        throw error;
      },
    );
    loading = { file, promise };
    return promise;
  }
}

/**
 * Drop the cached handle without closing it: a deprecated getDb() caller may
 * still be holding a reference, and closing it under them would turn a
 * recoverable error into a crash.
 */
function invalidate() {
  loaded = null;
}

// ---------------------------------------------------------------------------
// Atomic, durable flush
// ---------------------------------------------------------------------------

let tmpCounter = 0;

/**
 * Write the in-memory image to disk atomically:
 * temp file in the same directory -> fsync -> keep previous file as `.bak` ->
 * rename over the target. A crash at any point leaves either the old file or
 * the new one, never a truncated one.
 */
function flush(entry: LoadedDb) {
  const file = entry.file;
  const image = Buffer.from(entry.raw.export());
  // export() re-opened the connection behind our back; restore the pragmas.
  applySessionPragmas(entry.raw);

  // Never let an obviously broken image overwrite real data.
  assertSqliteImage(image, file);

  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });

  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${++tmpCounter}`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, image, 0, image.length, 0);
      fsyncSync(fd); // durability: bytes hit the platter before the rename
    } finally {
      closeSync(fd);
    }

    // Keep one previous generation so a bad write is recoverable.
    if (existsSync(file)) {
      try {
        copyFileSync(file, `${file}.bak`);
      } catch (error) {
        console.error("[DB] could not refresh backup:", error);
      }
    }

    renameSync(tmp, file); // atomic within the same filesystem
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    console.error("[DB] failed to save database:", error);
    throw error;
  }

  // Durability of the rename itself (best effort; not supported everywhere).
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    /* ignore */
  }

  entry.stamp = stampOf(file);
  debug(`saved ${image.length} bytes to ${file}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a mutation with exclusive access to the database and flush it atomically.
 *
 * The callback receives the drizzle handle and the underlying sql.js handle.
 * On success the database is written to disk; if the callback throws, nothing
 * is written, the in-memory image is discarded (so partial changes cannot be
 * flushed later), and the lock is released.
 */
export function withDb<T>(fn: BudgetDbCallback<T>): Promise<T> {
  return runExclusive(async () => {
    const entry = await ensureLoaded();
    try {
      const result = await fn(entry.orm, entry.raw);
      flush(entry);
      return result;
    } catch (error) {
      // All-or-nothing: discard the possibly half-mutated in-memory image so a
      // later save cannot persist it. The next call reloads from disk.
      if (loaded === entry) invalidate();
      throw error;
    }
  });
}

/**
 * Run a read-only callback. Queued behind pending mutations so it never sees a
 * half-applied write, but nothing is flushed afterwards.
 */
export function readDb<T>(fn: BudgetDbCallback<T>): Promise<T> {
  return runExclusive(async () => {
    const entry = await ensureLoaded();
    return fn(entry.orm, entry.raw);
  });
}

/**
 * @deprecated Use `withDb(fn)` for mutations or `readDb(fn)` for queries.
 *
 * Returns the shared drizzle handle. Unlike the old implementation this does
 * NOT create a private in-memory copy per call, so a concurrent caller can no
 * longer clobber your pending changes — but the getDb/mutate/saveDb shape
 * still cannot roll back a failed mutation. Migrate to `withDb`.
 */
export async function getDb(): Promise<BudgetDb> {
  const entry = await ensureLoaded();
  return entry.orm;
}

/**
 * @deprecated Use `withDb(fn)`, which flushes for you.
 *
 * Flushes the shared database atomically, serialized against other writers.
 */
export async function saveDb(): Promise<void> {
  await runExclusive(async () => {
    const entry = await ensureLoaded();
    try {
      flush(entry);
    } catch (error) {
      if (loaded === entry) invalidate();
      throw error;
    }
  });
}

/**
 * Close and forget the cached database (flush first if you care about pending
 * in-memory changes). Mainly for tests and one-shot scripts.
 */
export async function closeDb(): Promise<void> {
  await runExclusive(async () => {
    if (loading) await loading.promise.catch(() => undefined);
    const entry = loaded;
    loaded = null;
    if (entry) {
      try {
        entry.raw.close();
      } catch (error) {
        console.error("[DB] error closing database:", error);
      }
    }
  });
}
