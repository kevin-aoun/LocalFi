
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
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import path from "path";
import os from "node:os";
import { createHash } from "node:crypto";
import { canonicalStringify } from "../ledger/canonical";
import { canonicalDecimal } from "../ledger/decimal";
import {
  decryptVaultGeneration,
  destroyVaultKey,
  encryptVaultGeneration,
  isVaultEnvelope,
  type UnlockedVaultKey,
  unlockVaultEnvelope,
} from "../vault/envelope";
import { VaultLockedError, VaultUninitializedError } from "../vault/errors";
import {
  copyEncryptedGenerationAtomically,
  readEncryptedGeneration,
  writeEncryptedGenerationAtomically,
} from "../vault/paths";

export type BudgetDb = SQLJsDatabase<typeof schema>;
export type BudgetDbCallback<T> = (db: BudgetDb, raw: Database) => T | Promise<T>;

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");

const MIN_DB_BYTES = 512;

const DEFAULT_DB_PATH = path.resolve(process.cwd(), "data", "budget.db");

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
  return DEFAULT_DB_PATH;
}

export class DatabaseVaultAuthorization {
  private constructor() {}

  static create(): DatabaseVaultAuthorization {
    return new DatabaseVaultAuthorization();
  }
}

type VaultAuthorizationState = { key: UnlockedVaultKey; file: string };
const vaultAuthorizationStates = new WeakMap<DatabaseVaultAuthorization, VaultAuthorizationState>();

type VaultAuthorizationProvider = () =>
  | DatabaseVaultAuthorization
  | null
  | Promise<DatabaseVaultAuthorization | null>;
type VaultRuntimeState = {
  provider: VaultAuthorizationProvider;
};

const vaultRuntimeGlobals = globalThis as typeof globalThis & {
  __localfiVaultRuntime?: VaultRuntimeState;
};
const requestVaultAuthorization: VaultAuthorizationProvider = async () => {
  const access = await import("../vault/access");
  return access.databaseVaultAuthorizationForRequest();
};
const vaultRuntime = (vaultRuntimeGlobals.__localfiVaultRuntime ??= {
  provider: requestVaultAuthorization,
});

function canonicalPotentialPath(file: string): string {
  const resolved = path.resolve(file);
  if (existsSync(resolved)) return realpathSync(resolved);
  const missing: string[] = [];
  let cursor = resolved;
  while (!existsSync(cursor)) {
    missing.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return path.join(realpathSync(cursor), ...missing);
}

export function assertPlaintextFixturePath(file: string): void {
  const resolved = path.resolve(file);
  const configured = process.env.BUDGET_DB_PATH?.trim();
  if (
    !configured ||
    resolved === DEFAULT_DB_PATH ||
    canonicalPotentialPath(resolved) === canonicalPotentialPath(DEFAULT_DB_PATH)
  ) {
    throw new VaultLockedError("Plaintext fixture mode requires an explicit non-default path.");
  }
  if (existsSync(resolved) && realpathSync(resolved) !== resolved) {
    throw new VaultLockedError("Plaintext fixture mode refuses symbolic-link targets.");
  }
  if (
    process.env.NODE_ENV === "test" &&
    !canonicalPotentialPath(resolved).startsWith(`${canonicalPotentialPath(os.tmpdir())}${path.sep}`)
  ) {
    throw new VaultLockedError("Plaintext test fixtures must use an isolated temporary path.");
  }
}

function plaintextFixtureMode(file: string): boolean {
  if (process.env.LOCALFI_VAULT_TEST_MODE !== "plaintext") return false;
  assertPlaintextFixturePath(file);
  if (process.env.NODE_ENV !== "test" && process.env.LOCALFI_DEMO_GENERATOR !== "1") {
    throw new VaultLockedError("Plaintext fixture mode is restricted to tests and demo generation.");
  }
  return true;
}

export function plaintextFixtureAccessAllowed(file = resolveDbPath()): boolean {
  return plaintextFixtureMode(file);
}

async function authorizedKey(file: string): Promise<UnlockedVaultKey> {
  const authorization = await vaultRuntime.provider();
  const state = authorization ? vaultAuthorizationStates.get(authorization) : undefined;
  if (!state || state.key.destroyed || path.resolve(state.file) !== path.resolve(file)) {
    throw new VaultLockedError();
  }
  return state.key;
}

export function installDatabaseVaultAuthorizationProvider(
  provider: VaultAuthorizationProvider,
): () => void {
  const previous = vaultRuntime.provider;
  vaultRuntime.provider = provider;
  return () => {
    if (vaultRuntime.provider === provider) vaultRuntime.provider = previous;
  };
}

export async function unlockDatabaseVault(
  passphrase: string,
  dbPath = resolveDbPath(),
): Promise<DatabaseVaultAuthorization> {
  const file = path.resolve(dbPath);
  if (!existsSync(file)) throw new VaultUninitializedError();
  return runExclusive(async () => {
    const existing = dbRuntime.loaded?.file === file ? dbRuntime.loaded : null;
    const lease = existing?.lease ?? await acquireWriterLease(file);
    try {
      lease.assertOwned();
      const stored = await readEncryptedGeneration(file);
      lease.assertOwned();
      const unlocked = await unlockVaultEnvelope(stored, passphrase);
      unlocked.plaintext.fill(0);
      const authorization = DatabaseVaultAuthorization.create();
      vaultAuthorizationStates.set(authorization, { key: unlocked.key, file });
      return authorization;
    } finally {
      if (!existing) await lease.release();
    }
  });
}

function inactivityTimeoutFromRaw(raw: Database): number {
  const columns = raw.exec("PRAGMA table_info(settings)")[0]?.values ?? [];
  if (!columns.some((column) => String(column[1]) === "idle_timeout_minutes")) return 15;
  const value = raw.exec("SELECT idle_timeout_minutes FROM settings ORDER BY id LIMIT 1")[0]
    ?.values[0]?.[0];
  const timeout = Number(value);
  return Number.isInteger(timeout) && timeout >= 1 && timeout <= 120 ? timeout : 15;
}

export function readAuthorizedVaultInactivityTimeout(
  authorization: DatabaseVaultAuthorization,
): Promise<number> {
  return runExclusive(async () => {
    const state = vaultAuthorizationStates.get(authorization);
    if (!state || state.key.destroyed) throw new VaultLockedError();
    const loaded = dbRuntime.loaded?.file === state.file ? dbRuntime.loaded : null;
    if (loaded) {
      loaded.lease.assertOwned();
      return inactivityTimeoutFromRaw(loaded.raw);
    }
    const lease = await acquireWriterLease(state.file);
    let plaintext: Uint8Array | null = null;
    let raw: Database | null = null;
    try {
      const stored = await readEncryptedGeneration(state.file);
      lease.assertOwned();
      plaintext = await decryptVaultGeneration(stored, state.key);
      const SqlJs = await initSQL();
      raw = new SqlJs.Database(plaintext);
      return inactivityTimeoutFromRaw(raw);
    } finally {
      raw?.close();
      plaintext?.fill(0);
      await lease.release();
    }
  });
}

export function destroyDatabaseVaultAuthorization(
  authorization: DatabaseVaultAuthorization,
): void {
  const state = vaultAuthorizationStates.get(authorization);
  if (!state) return;
  destroyVaultKey(state.key);
  vaultAuthorizationStates.delete(authorization);
}

export async function authorizeDatabaseVaultFromEnvironment(): Promise<() => Promise<void>> {
  if (plaintextFixtureMode(resolveDbPath())) return async () => {};
  const passphrase = process.env.LOCALFI_VAULT_PASSPHRASE;
  if (!passphrase) {
    throw new VaultLockedError(
      "Headless database access requires LOCALFI_VAULT_PASSPHRASE.",
    );
  }
  const authorization = await unlockDatabaseVault(passphrase);
  const uninstall = installDatabaseVaultAuthorizationProvider(() => authorization);
  return async () => {
    await closeDb();
    uninstall();
    destroyDatabaseVaultAuthorization(authorization);
  };
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
  vaultKey: UnlockedVaultKey | null;
  plaintextFixture: boolean;
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


function readPlaintextFixtureImage(file: string): Uint8Array | undefined {
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

async function loadDatabase(
  file: string,
  plaintextFixture: boolean,
  accessKey: UnlockedVaultKey | null,
): Promise<LoadedDb> {
  if (!plaintextFixture && !existsSync(file)) throw new VaultUninitializedError();
  const lease = await acquireWriterLease(file);
  let raw: Database | null = null;
  try {
    let vaultKey: UnlockedVaultKey | null = null;
    if (plaintextFixture) {
      readPlaintextFixtureImage(file);
      lease.assertOwned();
      await upgradeDatabase({ dbPath: file, lease, allowLegacyPlaintext: true });
      lease.assertOwned();
    } else {
      vaultKey = accessKey;
      const stored = await readEncryptedGeneration(file);
      if (!isVaultEnvelope(stored)) {
        throw new VaultLockedError(
          "Legacy plaintext must be converted through the explicit vault setup API.",
        );
      }
      await upgradeDatabase({ dbPath: file, lease, vaultKey: vaultKey! });
      lease.assertOwned();
    }
    const SqlJs = await initSQL();
    const stamp = stampOf(file);
    const buffer = plaintextFixture
      ? readPlaintextFixtureImage(file)
      : await decryptVaultGeneration(await readEncryptedGeneration(file), vaultKey!);
    raw = new SqlJs.Database(buffer as Uint8Array | undefined);
    if (!plaintextFixture) buffer?.fill(0);
    applySessionPragmas(raw);
    const result = raw.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const tables = (result[0]?.values ?? []).map((row) => String(row[0]));
    debug("tables:", tables.join(", ") || "(none)");
    return {
      file,
      raw,
      orm: drizzle(raw, { schema }),
      lease,
      vaultKey,
      plaintextFixture,
      stamp,
    };
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
    const plaintextFixture = plaintextFixtureMode(file);
    const accessKey = plaintextFixture ? null : await authorizedKey(file);

    if (dbRuntime.loaded) {
      if (dbRuntime.loaded.file !== file) {
        debug("database path changed, reloading");
        await disposeLoaded(dbRuntime.loaded);
      } else if (changedOnDisk(dbRuntime.loaded)) {
        console.warn(`[DB] ${file} changed on disk outside this process - reloading it`);
        await disposeLoaded(dbRuntime.loaded);
      } else {
        if (!plaintextFixture && dbRuntime.loaded.vaultKey !== accessKey) {
          throw new VaultLockedError();
        }
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
      if (dbRuntime.loading.file === file) {
        const entry = await dbRuntime.loading.promise;
        if (!plaintextFixture && entry.vaultKey !== accessKey) throw new VaultLockedError();
        return entry;
      }
      await dbRuntime.loading.promise.catch(() => undefined);
      continue;
    }

    const promise = loadDatabase(file, plaintextFixture, accessKey).then(
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






async function flush(entry: LoadedDb) {
  entry.lease.assertOwned();
  const file = entry.file;
  const image = Buffer.from(entry.raw.export());

  applySessionPragmas(entry.raw);


  assertSqliteImage(image, file);

  if (!entry.plaintextFixture) {
    try {
      const envelope = await encryptVaultGeneration(image, entry.vaultKey!);
      if (existsSync(file)) {
        try {
          await copyEncryptedGenerationAtomically(file, `${file}.bak`);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Could not refresh recoverable encrypted database backup at ${file}.bak; ` +
              `the live database was not replaced. (${detail})`,
            { cause: error },
          );
        }
      }
      entry.lease.assertOwned();
      await writeEncryptedGenerationAtomically(file, envelope, {
        replace: true,
        purpose: "persist",
      });
      entry.stamp = stampOf(file);
      debug(`saved ${envelope.length} encrypted bytes to ${file}`);
      return;
    } finally {
      image.fill(0);
    }
  }

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
  image.fill(0);
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
      await flush(entry);
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
      await flush(entry);
    } catch (error) {
      if (dbRuntime.loaded === entry) await disposeLoaded(entry);
      throw error;
    }
  });
}

export type EncryptedDatabaseGeneration = {
  bytes: Uint8Array;
  fileName: string;
};

export function snapshotEncryptedDatabaseGeneration(): Promise<EncryptedDatabaseGeneration> {
  return runExclusive(async () => {
    const entry = await ensureLoaded();
    if (entry.plaintextFixture) {
      throw new VaultLockedError("Plaintext fixtures cannot be exported as vault generations.");
    }
    entry.lease.assertOwned();
    const bytes = await readEncryptedGeneration(entry.file);
    entry.lease.assertOwned();
    if (changedOnDisk(entry)) {
      throw new Error("Encrypted database generation changed while it was being snapshotted.");
    }
    return {
      bytes: Uint8Array.from(bytes),
      fileName: `${path.basename(entry.file, path.extname(entry.file))}.localfi-vault`,
    };
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
