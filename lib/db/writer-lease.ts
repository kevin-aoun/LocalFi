import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

const STALE_AFTER_MS = 30_000;
const UPDATE_EVERY_MS = 10_000;

type LockError = Error & { code?: string };

export type WriterLease = {
  readonly dbPath: string;
  readonly lockPath: string;
  assertOwned(): void;
  release(): Promise<void>;
};

export class WriterLeaseError extends Error {
  readonly dbPath: string;
  readonly lockPath: string;

  constructor(dbPath: string, lockPath: string, detail?: string) {
    super(
      `Refusing to open ${dbPath} for writing because another LocalFi process ` +
        `holds the writer lease at ${lockPath}. Stop the other LocalFi app or ` +
        `database command and retry. If no writer is running, wait at least ` +
        `${Math.ceil(STALE_AFTER_MS / 1_000)} seconds for stale-lease recovery, then retry; ` +
        `do not remove the lease while a writer may still be active.` +
        (detail ? ` (${detail})` : ""),
    );
    this.name = "WriterLeaseError";
    this.dbPath = dbPath;
    this.lockPath = lockPath;
  }
}


export function canonicalWriterTarget(dbPath: string): string {
  const absolute = path.resolve(dbPath);
  const parent = path.dirname(absolute);
  mkdirSync(parent, { recursive: true });
  if (existsSync(absolute)) return realpathSync(absolute);
  return path.join(realpathSync(parent), path.basename(absolute));
}

export function writerLeasePath(dbPath: string): string {
  return `${canonicalWriterTarget(dbPath)}.writer.lock`;
}

export async function acquireWriterLease(dbPath: string): Promise<WriterLease> {
  const requestedPath = path.resolve(dbPath);
  const target = canonicalWriterTarget(requestedPath);
  const lockPath = `${target}.writer.lock`;
  let compromised: Error | null = null;

  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await lockfile.lock(target, {
      lockfilePath: lockPath,
      realpath: false,
      retries: 0,
      stale: STALE_AFTER_MS,
      update: UPDATE_EVERY_MS,
      onCompromised: (error) => {
        compromised = error;
      },
    });
  } catch (error) {
    const lockError = error as LockError;
    if (lockError.code === "ELOCKED") {
      throw new WriterLeaseError(requestedPath, lockPath);
    }
    throw new WriterLeaseError(requestedPath, lockPath, lockError.message);
  }

  let released = false;
  return {
    dbPath: requestedPath,
    lockPath,
    assertOwned() {
      if (released) {
        throw new WriterLeaseError(requestedPath, lockPath, "this process already released it");
      }
      if (compromised) {
        throw new WriterLeaseError(
          requestedPath,
          lockPath,
          `the lease heartbeat was compromised: ${compromised.message}`,
        );
      }
    },
    async release() {
      if (released) return;
      released = true;

      if (compromised) return;
      await releaseLock();
    },
  };
}
