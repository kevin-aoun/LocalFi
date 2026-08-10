/**
 * SQLite (sql.js / WebAssembly) database access for the app.
 *
 * The whole database lives in memory and is flushed to a single file. Before
 * opening it, this module obtains a heartbeat-backed cross-process writer lease
 * and completes the backed-up migration journal. In-process writes are then
 * serialized and every persisted image is replaced atomically.
 *
 * ## How to use it
 *
 *     await withDb(async (db) => {           // serialized + flushed atomically
 *       await db.insert(transactions).values({ ...draft, pending: true });
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
import { upgradeDatabase } from "./upgrade";
import { acquireWriterLease, type WriterLease } from "./writer-lease";
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
import { createHash } from "node:crypto";
import { canonicalStringify } from "../ledger/canonical";
import { canonicalDecimal } from "../ledger/decimal";

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

type SqlRuntimeState = {
  SQL: SqlJsStatic | null;
  loading: Promise<SqlJsStatic> | null;
};

const runtimeGlobals = globalThis as typeof globalThis & {
  __localfiSqlRuntime?: SqlRuntimeState;
};
const sqlRuntime = (runtimeGlobals.__localfiSqlRuntime ??= {
  SQL: null,
  loading: null,
});

async function initSQL(): Promise<SqlJsStatic> {
  if (sqlRuntime.SQL) return sqlRuntime.SQL;
  sqlRuntime.loading ??= initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules/sql.js/dist", file),
  }).then((loaded) => {
    sqlRuntime.SQL = loaded;
    sqlRuntime.loading = null;
    return loaded;
  });
  return sqlRuntime.loading;
}

// ---------------------------------------------------------------------------
// Global mutation lock (FIFO, one task at a time)
// ---------------------------------------------------------------------------

/**
 * Run `task` after every previously queued task has settled. The queue never
 * rejects, so a throwing task can never wedge the lock.
 */
function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = dbRuntime.tail.then(task, task);
  dbRuntime.tail = result.then(
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
  lease: WriterLease;
  /** Stat of the file as we last read/wrote it, to spot out-of-process edits. */
  stamp: { mtimeMs: number; size: number } | null;
};

type DbRuntimeState = {
  tail: Promise<unknown>;
  loaded: LoadedDb | null;
  loading: { file: string; promise: Promise<LoadedDb> } | null;
  tmpCounter: number;
};

const dbRuntimeGlobals = globalThis as typeof globalThis & {
  __localfiDbRuntime?: DbRuntimeState;
};
const dbRuntime = (dbRuntimeGlobals.__localfiDbRuntime ??= {
  tail: Promise.resolve(),
  loaded: null,
  loading: null,
  tmpCounter: 0,
});

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
  const lease = await acquireWriterLease(file);
  let raw: Database | null = null;
  try {
    // Preserve the client's corruption-specific diagnostics before the upgrade
    // runner attempts to parse an existing image.
    readImage(file);
    lease.assertOwned();
    await upgradeDatabase({ dbPath: file, lease });
    lease.assertOwned();

    const SqlJs = await initSQL();
    const stamp = stampOf(file);
    const buffer = readImage(file);
    raw = new SqlJs.Database(buffer as Uint8Array | undefined);

    // A garbage/truncated body can still slip past the header check, and sql.js
    // only surfaces that on the first query. Fail loudly instead of pretending
    // the database is empty.
    applySessionPragmas(raw);
    const result = raw.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const tables = (result[0]?.values ?? []).map((row) => String(row[0]));
    debug("tables:", tables.join(", ") || "(none)");
    return { file, raw, orm: drizzle(raw, { schema }), lease, stamp };
  } catch (error) {
    try {
      raw?.close();
    } catch {
      // The readiness failure remains the useful diagnostic.
    }
    try {
      await lease.release();
    } catch (releaseError) {
      console.error("[DB] failed to release writer lease after load failure:", releaseError);
    }
    throw error;
  }
}

/**
 * Connection-scoped settings. These must be re-applied every time the sql.js
 * connection is (re)opened - and note that `Database.export()` internally
 * closes and re-opens the connection, which silently resets `foreign_keys`
 * back to OFF. So this runs after every load AND after every flush.
 */
function applySessionPragmas(raw: Database) {
  raw.run("PRAGMA foreign_keys = ON");
  raw.create_function("ledger_sha256", (value: unknown) => {
    if (typeof value !== "string") throw new Error("ledger_sha256 requires text");
    return createHash("sha256").update(value).digest("hex");
  });
  raw.create_function("ledger_canonical_json", (value: unknown) => {
    if (typeof value !== "string") throw new Error("ledger_canonical_json requires text");
    return canonicalStringify(JSON.parse(value));
  });
  raw.create_function("ledger_canonical_decimal", (value: unknown) => {
    if (typeof value !== "string") throw new Error("ledger_canonical_decimal requires text");
    return canonicalDecimal(value);
  });
}

/** Return the shared database, loading (or reloading) it when necessary. */
async function ensureLoaded(): Promise<LoadedDb> {
  for (;;) {
    const file = resolveDbPath();

    if (dbRuntime.loaded) {
      if (dbRuntime.loaded.file !== file) {
        debug("database path changed, reloading");
        await disposeLoaded(dbRuntime.loaded);
      } else if (changedOnDisk(dbRuntime.loaded)) {
        console.warn(`[DB] ${file} changed on disk outside this process - reloading it`);
        await disposeLoaded(dbRuntime.loaded);
      } else {
        try {
          dbRuntime.loaded.lease.assertOwned();
        } catch (error) {
          await disposeLoaded(dbRuntime.loaded);
          throw error;
        }
        return dbRuntime.loaded;
      }
    }

    if (dbRuntime.loading) {
      if (dbRuntime.loading.file === file) return dbRuntime.loading.promise;
      await dbRuntime.loading.promise.catch(() => undefined);
      continue;
    }

    const promise = loadDatabase(file).then(
      (entry) => {
        dbRuntime.loaded = entry;
        dbRuntime.loading = null;
        return entry;
      },
      (error) => {
        dbRuntime.loading = null;
        throw error;
      },
    );
    dbRuntime.loading = { file, promise };
    return promise;
  }
}

async function disposeLoaded(entry: LoadedDb) {
  if (dbRuntime.loaded === entry) dbRuntime.loaded = null;
  try {
    entry.raw.close();
  } catch (error) {
    console.error("[DB] error closing database:", error);
  }
  await entry.lease.release();
}

// ---------------------------------------------------------------------------
// Atomic, durable flush
// ---------------------------------------------------------------------------

/**
 * Write the in-memory image to disk atomically:
 * temp file in the same directory -> fsync -> keep previous file as `.bak` ->
 * rename over the target. A crash at any point leaves either the old file or
 * the new one, never a truncated one.
 */
function flush(entry: LoadedDb) {
  entry.lease.assertOwned();
  const file = entry.file;
  const image = Buffer.from(entry.raw.export());
  // export() re-opened the connection behind our back; restore the pragmas.
  applySessionPragmas(entry.raw);

  // Never let an obviously broken image overwrite real data.
  assertSqliteImage(image, file);

  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });

  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${++dbRuntime.tmpCounter}`,
  );
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
      const backup = `${file}.bak`;
      try {
        copyFileSync(file, backup);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not refresh recoverable database backup at ${backup}; ` +
            `the live database was not replaced. Remove the obstruction and retry. (${detail})`,
          { cause: error },
        );
      }
    }

    entry.lease.assertOwned();
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
    let transactionOpen = false;
    try {
      // DECISION: DEC-010 — atomic image replacement supplements, but does not
      // replace, an actual rollback-capable SQLite transaction.
      entry.raw.run("BEGIN IMMEDIATE");
      transactionOpen = true;
      const result = await fn(entry.orm, entry.raw);
      entry.raw.run("COMMIT");
      transactionOpen = false;
      flush(entry);
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          entry.raw.run("ROLLBACK");
        } catch {
          // The callback may have invalidated the transaction; reloading below
          // still guarantees no partial in-memory image can later be flushed.
        }
      }
      // All-or-nothing: discard the possibly half-mutated in-memory image so a
      // later save cannot persist it. The next call reloads from disk.
      if (dbRuntime.loaded === entry) await disposeLoaded(entry);
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
    entry.lease.assertOwned();
    const result = await fn(entry.orm, entry.raw);
    entry.lease.assertOwned();
    return result;
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
      if (dbRuntime.loaded === entry) await disposeLoaded(entry);
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
    if (dbRuntime.loading) await dbRuntime.loading.promise.catch(() => undefined);
    const entry = dbRuntime.loaded;
    dbRuntime.loaded = null;
    if (entry) {
      await disposeLoaded(entry);
    }
  });
}
