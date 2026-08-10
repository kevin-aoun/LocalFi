import { createHash } from "node:crypto";
import {
  closeSync,
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
} from "node:fs";
import path from "node:path";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { canonicalWriterTarget, type WriterLease } from "./writer-lease";

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");
const MIN_DB_BYTES = 512;

let SQL: SqlJsStatic | null = null;

export class DatabaseRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseRestoreError";
  }
}

export type RestoreDatabaseOptions = {
  sourcePath: string;
  dbPath: string;
  /** Preview by default. Only `apply: true` is allowed to replace the target. */
  apply?: boolean;
  /** DECISION: DEC-005 -- the caller must hold the target writer lease. */
  lease: WriterLease;
};

export type RestoreDatabaseResult = {
  sourcePath: string;
  dbPath: string;
  dryRun: boolean;
  applied: boolean;
  byteLength: number;
  sha256: string;
  targetExisted: boolean;
  preRestoreBackupPath: string | null;
};

async function sqlRuntime(): Promise<SqlJsStatic> {
  SQL ??= await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules/sql.js/dist", file),
  });
  return SQL;
}

function readRegularFile(file: string, label: string): Buffer {
  if (!existsSync(file)) throw new DatabaseRestoreError(`${label} does not exist: ${file}`);
  const stat = statSync(file);
  if (!stat.isFile()) throw new DatabaseRestoreError(`${label} is not a regular file: ${file}`);
  return readFileSync(file);
}

function assertDifferentFiles(sourcePath: string, dbPath: string): void {
  if (sourcePath === dbPath) {
    throw new DatabaseRestoreError("The restore source and target database must be different files.");
  }
  if (!existsSync(dbPath)) return;
  const source = statSync(sourcePath);
  const target = statSync(dbPath);
  if (source.dev === target.dev && source.ino === target.ino) {
    throw new DatabaseRestoreError("The restore source and target resolve to the same file.");
  }
}

/** Fully parse an image and make SQLite inspect every page before it is trusted. */
export async function validateRestoreImage(bytes: Uint8Array, label: string): Promise<void> {
  if (bytes.byteLength < MIN_DB_BYTES) {
    throw new DatabaseRestoreError(`${label} is too small to be a SQLite database.`);
  }
  if (!Buffer.from(bytes.subarray(0, SQLITE_MAGIC.length)).equals(SQLITE_MAGIC)) {
    throw new DatabaseRestoreError(`${label} is not a SQLite database (bad header).`);
  }

  const SqlJs = await sqlRuntime();
  let db: InstanceType<SqlJsStatic["Database"]> | null = null;
  try {
    db = new SqlJs.Database(bytes);
    const integrity = db.exec("PRAGMA integrity_check")[0]?.values ?? [];
    if (integrity.length !== 1 || integrity[0]?.[0] !== "ok") {
      throw new DatabaseRestoreError(
        `${label} failed SQLite integrity_check: ${JSON.stringify(integrity)}`,
      );
    }
  } catch (error) {
    if (error instanceof DatabaseRestoreError) throw error;
    throw new DatabaseRestoreError(
      `${label} could not be opened as SQLite: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    db?.close();
  }
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some filesystems do not support directory fsync. The file is still fsynced.
  }
}

function writeDurably(file: string, bytes: Uint8Array, exclusive = false): void {
  const fd = openSync(file, exclusive ? "wx" : "w", 0o600);
  try {
    writeSync(fd, bytes, 0, bytes.byteLength, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

function writePreRestoreBackup(dbPath: string, bytes: Uint8Array): string {
  const backupDirectory = path.join(path.dirname(dbPath), "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const base = path.basename(dbPath, path.extname(dbPath)) || "database";
  const stem = `${base}.${timestamp()}.pre-restore`;
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const file = path.join(
      backupDirectory,
      `${stem}${suffix === 0 ? "" : `-${suffix}`}.db`,
    );
    try {
      writeDurably(file, bytes, true);
      fsyncDirectory(backupDirectory);
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new DatabaseRestoreError("Could not allocate a unique pre-restore backup path.");
}

/**
 * Validate and optionally restore one database image.
 *
 * Dry-run is the default. Apply mode retains the current target byte-for-byte,
 * fsyncs both generations, then atomically renames the validated image over the
 * target. The source is never modified or removed.
 */
export async function restoreDatabase(
  options: RestoreDatabaseOptions,
): Promise<RestoreDatabaseResult> {
  const requestedSourcePath = path.resolve(options.sourcePath);
  const candidate = readRegularFile(requestedSourcePath, "Restore source");
  const sourcePath = realpathSync(requestedSourcePath);
  const requestedDbPath = path.resolve(options.dbPath);
  if (path.resolve(options.lease.dbPath) !== requestedDbPath) {
    throw new DatabaseRestoreError(`Writer lease does not cover restore target: ${requestedDbPath}`);
  }
  const dbPath = canonicalWriterTarget(requestedDbPath);
  options.lease.assertOwned();
  assertDifferentFiles(sourcePath, dbPath);

  await validateRestoreImage(candidate, `Restore source ${sourcePath}`);
  options.lease.assertOwned();

  const targetExisted = existsSync(dbPath);
  if (!options.apply) {
    return {
      sourcePath,
      dbPath,
      dryRun: true,
      applied: false,
      byteLength: candidate.byteLength,
      sha256: createHash("sha256").update(candidate).digest("hex"),
      targetExisted,
      preRestoreBackupPath: null,
    };
  }

  let current: Buffer | null = null;
  if (targetExisted) current = readRegularFile(dbPath, "Current database");
  const directory = path.dirname(dbPath);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(dbPath)}.restore-${process.pid}-${Date.now()}`,
  );
  let preRestoreBackupPath: string | null = null;

  try {
    writeDurably(temporary, candidate, true);
    if (current) preRestoreBackupPath = writePreRestoreBackup(dbPath, current);
    options.lease.assertOwned();
    renameSync(temporary, dbPath);
    fsyncDirectory(directory);
    await validateRestoreImage(readFileSync(dbPath), `Restored database ${dbPath}`);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }

  return {
    sourcePath,
    dbPath,
    dryRun: false,
    applied: true,
    byteLength: candidate.byteLength,
    sha256: createHash("sha256").update(candidate).digest("hex"),
    targetExisted,
    preRestoreBackupPath,
  };
}
