import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { runDbRestore } from "../../../scripts/db-restore";
import {
  createVaultEnvelope,
  destroyVaultKey,
  isVaultEnvelope,
  unlockVaultEnvelope,
  unlockVaultEnvelopeWithRecovery,
} from "../../vault/envelope";
import { writeEncryptedGenerationAtomically } from "../../vault/paths";
import { DatabaseRestoreError, restoreDatabase } from "../restore";
import { acquireWriterLease, writerLeasePath } from "../writer-lease";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const temporaryDirectories: string[] = [];
let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(PROJECT_ROOT, "node_modules/sql.js/dist", file),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "localfi-restore-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeDatabase(file: string, marker: string): Buffer {
  const db = new SQL.Database();
  db.run("CREATE TABLE marker (value TEXT NOT NULL)");
  db.run("INSERT INTO marker (value) VALUES (?)", [marker]);
  const bytes = Buffer.from(db.export());
  db.close();
  writeFileSync(file, bytes);
  return bytes;
}

function readMarker(file: string): string {
  const db = new SQL.Database(readFileSync(file));
  try {
    return String(db.exec("SELECT value FROM marker")[0].values[0][0]);
  } finally {
    db.close();
  }
}

async function restore(
  sourcePath: string,
  dbPath: string,
  apply = false,
  passphrase?: string,
) {
  const lease = await acquireWriterLease(dbPath);
  try {
    return await restoreDatabase({ sourcePath, dbPath, apply, lease, passphrase });
  } finally {
    await lease.release();
  }
}

describe("validated database restore", () => {
  it("restores encrypted generations and preserves an encrypted pre-restore backup", async () => {
    const passphrase = "disposable encrypted restore passphrase";
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "source.db");
    const dbPath = path.join(directory, "budget.db");
    const sourcePlaintext = writeDatabase(sourcePath, "candidate");
    const targetPlaintext = writeDatabase(dbPath, "current");
    const sourceVault = await createVaultEnvelope(sourcePlaintext, passphrase);
    const targetVault = await createVaultEnvelope(targetPlaintext, passphrase);
    const sourceRecoverySecret = sourceVault.recoverySecret;
    const targetRecoverySecret = targetVault.recoverySecret;
    writeFileSync(sourcePath, sourceVault.envelope, { mode: 0o600 });
    writeFileSync(dbPath, targetVault.envelope, { mode: 0o600 });
    chmodSync(sourcePath, 0o600);
    chmodSync(dbPath, 0o600);
    destroyVaultKey(sourceVault.key);
    destroyVaultKey(targetVault.key);

    const result = await restore(sourcePath, dbPath, true, passphrase);

    expect(result.applied).toBe(true);
    expect(isVaultEnvelope(readFileSync(dbPath))).toBe(true);
    expect(result.preRestoreBackupPath && isVaultEnvelope(readFileSync(result.preRestoreBackupPath)))
      .toBe(true);
    const unlocked = await unlockVaultEnvelope(readFileSync(dbPath), passphrase);
    try {
      const db = new SQL.Database(unlocked.plaintext);
      expect(db.exec("SELECT value FROM marker")[0].values[0][0]).toBe("candidate");
      db.close();
    } finally {
      unlocked.plaintext.fill(0);
      destroyVaultKey(unlocked.key);
    }
    await expect(unlockVaultEnvelopeWithRecovery(readFileSync(dbPath), sourceRecoverySecret))
      .rejects.toThrow();
    for (const generation of [dbPath, result.preRestoreBackupPath!]) {
      const recovered = await unlockVaultEnvelopeWithRecovery(
        readFileSync(generation),
        targetRecoverySecret,
      );
      recovered.plaintext.fill(0);
      destroyVaultKey(recovered.key);
    }
  });

  it("rejects a target symlink instead of overwriting its referent", async () => {
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "source.db");
    const realTarget = path.join(directory, "real.db");
    const aliasTarget = path.join(directory, "alias.db");
    writeDatabase(sourcePath, "candidate");
    writeDatabase(realTarget, "current");
    symlinkSync(realTarget, aliasTarget);

    await expect(restore(sourcePath, aliasTarget, true)).rejects.toThrow(/symbolic-link alias/i);
    expect(readMarker(realTarget)).toBe("current");
  });

  it("rolls an encrypted target back when a writer reports failure after publication", async () => {
    const passphrase = "disposable encrypted rollback passphrase";
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "source.db");
    const dbPath = path.join(directory, "budget.db");
    const sourceVault = await createVaultEnvelope(writeDatabase(sourcePath, "candidate"), passphrase);
    const targetVault = await createVaultEnvelope(writeDatabase(dbPath, "current"), passphrase);
    writeFileSync(sourcePath, sourceVault.envelope, { mode: 0o600 });
    writeFileSync(dbPath, targetVault.envelope, { mode: 0o600 });
    const original = Buffer.from(targetVault.envelope);
    destroyVaultKey(sourceVault.key);
    destroyVaultKey(targetVault.key);

    const lease = await acquireWriterLease(dbPath);
    try {
      await expect(restoreDatabase({
        sourcePath,
        dbPath,
        apply: true,
        lease,
        passphrase,
        persistence: {
          async writeGeneration(file, bytes, options) {
            await writeEncryptedGenerationAtomically(file, bytes, options);
            if (options?.purpose === "restore") {
              throw new Error("injected post-rename fsync failure");
            }
          },
        },
      })).rejects.toThrow();
    } finally {
      await lease.release();
    }
    expect(readFileSync(dbPath)).toEqual(original);
  });

  it("dry-runs a valid backup without changing the target or writing a backup", async () => {
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "source.db");
    const dbPath = path.join(directory, "budget.db");
    writeDatabase(sourcePath, "candidate");
    const original = writeDatabase(dbPath, "current");

    const result = await restore(sourcePath, dbPath);

    expect(result).toMatchObject({ dryRun: true, applied: false, targetExisted: true });
    expect(result.preRestoreBackupPath).toBeNull();
    expect(readFileSync(dbPath).equals(original)).toBe(true);
    expect(existsSync(path.join(directory, "backups"))).toBe(false);
  });

  it("rejects an invalid backup before any target or backup write", async () => {
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "invalid.db");
    const dbPath = path.join(directory, "budget.db");
    const corrupt = Buffer.alloc(512);
    corrupt.write("SQLite format 3\0", 0, "binary");
    writeFileSync(sourcePath, corrupt);
    const original = writeDatabase(dbPath, "current");

    await expect(restore(sourcePath, dbPath, true)).rejects.toBeInstanceOf(DatabaseRestoreError);
    expect(readFileSync(dbPath).equals(original)).toBe(true);
    expect(existsSync(path.join(directory, "backups"))).toBe(false);
  });

  it("atomically restores and preserves the current generation first", async () => {
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "source.db");
    const dbPath = path.join(directory, "budget.db");
    const candidate = writeDatabase(sourcePath, "candidate");
    const original = writeDatabase(dbPath, "current");

    const result = await restore(sourcePath, dbPath, true);

    expect(result).toMatchObject({ dryRun: false, applied: true, targetExisted: true });
    expect(result.preRestoreBackupPath).toMatch(/pre-restore\.db$/);
    expect(readFileSync(result.preRestoreBackupPath!).equals(original)).toBe(true);
    expect(readFileSync(dbPath).equals(candidate)).toBe(true);
    expect(readMarker(dbPath)).toBe("candidate");
  });

  it("can restore a missing target without inventing a pre-restore generation", async () => {
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "source.db");
    const dbPath = path.join(directory, "new", "budget.db");
    writeDatabase(sourcePath, "candidate");

    const result = await restore(sourcePath, dbPath, true);

    expect(result).toMatchObject({ applied: true, targetExisted: false });
    expect(result.preRestoreBackupPath).toBeNull();
    expect(readMarker(dbPath)).toBe("candidate");
  });

  it("refuses to restore a database over itself", async () => {
    const directory = tempDirectory();
    const dbPath = path.join(directory, "budget.db");
    writeDatabase(dbPath, "current");

    await expect(restore(dbPath, dbPath, true)).rejects.toThrow(/must be different/i);
    expect(readMarker(dbPath)).toBe("current");
  });
});

describe("dry-run-first restore CLI", () => {
  it("defaults to dry-run, requires --apply, and releases the lease", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "source.db");
    const dbPath = path.join(directory, "budget.db");
    writeDatabase(sourcePath, "candidate");
    writeDatabase(dbPath, "current");

    const preview = await runDbRestore(["--from", sourcePath, "--db", dbPath]);
    expect(preview).toMatchObject({ dryRun: true, applied: false });
    expect(readMarker(dbPath)).toBe("current");
    expect(existsSync(writerLeasePath(dbPath))).toBe(false);

    const applied = await runDbRestore(["--from", sourcePath, "--db", dbPath, "--apply"]);
    expect(applied).toMatchObject({ dryRun: false, applied: true });
    expect(readMarker(dbPath)).toBe("candidate");
    expect(readdirSync(path.join(directory, "backups"))).toHaveLength(1);
    expect(existsSync(writerLeasePath(dbPath))).toBe(false);
  });

  it("refuses while another LocalFi writer owns the target", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "source.db");
    const dbPath = path.join(directory, "budget.db");
    writeDatabase(sourcePath, "candidate");
    writeDatabase(dbPath, "current");
    const lease = await acquireWriterLease(dbPath);
    try {
      await expect(
        runDbRestore(["--from", sourcePath, "--db", dbPath]),
      ).rejects.toThrow(/another LocalFi process/i);
    } finally {
      await lease.release();
    }
  });
});
