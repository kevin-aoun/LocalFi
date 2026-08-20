
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

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");

const MIN_DB_BYTES = 512;

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


export function resolveDbPath(): string {
  const override = process.env.BUDGET_DB_PATH;
  if (override && override.trim() !== "") return path.resolve(process.cwd(), override);
  return path.resolve(process.cwd(), "data", "budget.db");
}





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






function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = dbRuntime.tail.then(task, task);
  dbRuntime.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}





type LoadedDb = {
  file: string;
  raw: Database;
  orm: BudgetDb;
  lease: WriterLease;

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


    readImage(file);
    lease.assertOwned();
    await upgradeDatabase({ dbPath: file, lease });
    lease.assertOwned();

    const SqlJs = await initSQL();
    const stamp = stampOf(file);
    const buffer = readImage(file);
    raw = new SqlJs.Database(buffer as Uint8Array | undefined);




    applySessionPragmas(raw);
    const result = raw.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const tables = (result[0]?.values ?? []).map((row) => String(row[0]));
    debug("tables:", tables.join(", ") || "(none)");
    return { file, raw, orm: drizzle(raw, { schema }), lease, stamp };
  } catch (error) {
    try {
      raw?.close();
    } catch {

    }
    try {
      await lease.release();
    } catch (releaseError) {
      console.error("[DB] failed to release writer lease after load failure:", releaseError);
    }
    throw error;
  }
}


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






function flush(entry: LoadedDb) {
  entry.lease.assertOwned();
  const file = entry.file;
  const image = Buffer.from(entry.raw.export());

  applySessionPragmas(entry.raw);


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
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }


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
    renameSync(tmp, file);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {

    }
    console.error("[DB] failed to save database:", error);
    throw error;
  }


  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {

  }

  entry.stamp = stampOf(file);
  debug(`saved ${image.length} bytes to ${file}`);
}






export function withDb<T>(fn: BudgetDbCallback<T>): Promise<T> {
  return runExclusive(async () => {
    const entry = await ensureLoaded();
    let transactionOpen = false;
    try {


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


        }
      }


      if (dbRuntime.loaded === entry) await disposeLoaded(entry);
      throw error;
    }
  });
}


export function readDb<T>(fn: BudgetDbCallback<T>): Promise<T> {
  return runExclusive(async () => {
    const entry = await ensureLoaded();
    entry.lease.assertOwned();
    const result = await fn(entry.orm, entry.raw);
    entry.lease.assertOwned();
    return result;
  });
}


export async function getDb(): Promise<BudgetDb> {
  const entry = await ensureLoaded();
  return entry.orm;
}


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
