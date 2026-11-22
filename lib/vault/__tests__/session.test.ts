import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  destroyDatabaseVaultAuthorization,
  closeDb,
  installDatabaseVaultAuthorizationProvider,
  readDb,
  unlockDatabaseVault,
  withDb,
} from "../../db/client";
import { buildInitialDatabaseImage } from "../../db/init";
import { withDatabaseVaultAuthorization } from "../access";
import { decryptVaultGeneration, destroyVaultKey, unlockVaultEnvelopeWithRecovery } from "../envelope";
import { VaultLockedError, VaultPermissionError } from "../errors";
import {
  copyEncryptedGenerationAtomically,
  managedVaultGenerationPaths,
  writeEncryptedGenerationAtomically,
} from "../paths";
import { VaultSessionManager } from "../session";

const PASSPHRASE = "cedar harbor lantern 47 violet";
let directory: string;
let dbPath: string;
let originalMode: string | undefined;
let originalDbPath: string | undefined;
let uninstallProvider: (() => void) | undefined;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "localfi-session-test-"));
  chmodSync(directory, 0o700);
  dbPath = path.join(directory, "budget.db");
  originalDbPath = process.env.BUDGET_DB_PATH;
  process.env.BUDGET_DB_PATH = dbPath;
  originalMode = process.env.LOCALFI_VAULT_TEST_MODE;
  delete process.env.LOCALFI_VAULT_TEST_MODE;
});

afterEach(async () => {
  await closeDb();
  uninstallProvider?.();
  uninstallProvider = undefined;
  if (originalMode === undefined) delete process.env.LOCALFI_VAULT_TEST_MODE;
  else process.env.LOCALFI_VAULT_TEST_MODE = originalMode;
  if (originalDbPath === undefined) delete process.env.BUDGET_DB_PATH;
  else process.env.BUDGET_DB_PATH = originalDbPath;
  rmSync(directory, { recursive: true, force: true });
});

function controlledManager() {
  let now = 1_000;
  return {
    manager: new VaultSessionManager({
      now: () => now,
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    }),
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

describe.sequential("single-owner vault sessions", () => {
  it("routes an existing legacy SQLite generation to setup", async () => {
    writeFileSync(dbPath, await buildInitialDatabaseImage(), { mode: 0o600 });
    const { manager } = controlledManager();
    expect(await manager.status(dbPath)).toBe("uninitialized");
    chmodSync(dbPath, 0o644);
    expect(await manager.status(dbPath)).toBe("uninitialized");
  });

  it("surfaces loose permissions on an encrypted vault instead of offering setup over it", async () => {
    const { manager } = controlledManager();
    const setup = await manager.setup(PASSPHRASE, dbPath);
    await manager.lock(setup.token);
    chmodSync(dbPath, 0o644);
    const before = readFileSync(dbPath);

    await expect(manager.status(dbPath)).rejects.toBeInstanceOf(VaultPermissionError);
    expect(readFileSync(dbPath)).toEqual(before);
    chmodSync(dbPath, 0o600);
    expect(await manager.status(dbPath)).toBe("locked");
  });

  it("issues opaque sessions, rejects forged tokens, locks explicitly, and restarts locked", async () => {
    const { manager } = controlledManager();
    const setup = await manager.setup(PASSPHRASE, dbPath);

    expect(setup.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(setup.token).not.toContain(PASSPHRASE);
    expect(setup.recoverySecret).not.toBe(setup.token);
    expect(await manager.authorizationForToken("forged")).toBeNull();
    expect(await manager.authorizationForToken(setup.token)).not.toBeNull();
    expect(await manager.status(dbPath)).toBe("unlocked");
    await expect(Promise.resolve().then(() =>
      withDatabaseVaultAuthorization(null, () => readDb(() => null))
    ))
      .rejects.toBeInstanceOf(VaultLockedError);
    const authorization = await manager.authorizationForToken(setup.token);
    expect(await withDatabaseVaultAuthorization(authorization, () =>
      readDb((_db, raw) => Number(raw.exec("SELECT COUNT(*) FROM categories")[0].values[0][0]))
    )).toBe(18);

    const restarted = new VaultSessionManager();
    expect(await restarted.authorizationForToken(setup.token)).toBeNull();
    expect(await restarted.status(dbPath)).toBe("locked");

    expect(await manager.lock("forged")).toBe(false);
    expect(await manager.lock(setup.token)).toBe(true);
    expect(await manager.authorizationForToken(setup.token)).toBeNull();
    await expect(manager.setup(PASSPHRASE, dbPath)).rejects.toThrow(/already been initialized/i);
  });

  it("extends on activity and applies a shorter 1–120 minute timeout immediately", async () => {
    const { manager, advance } = controlledManager();
    const setup = await manager.setup(PASSPHRASE, dbPath);
    expect(manager.timeoutMinutes).toBe(15);

    advance(14 * 60_000);
    expect(await manager.authorizationForToken(setup.token, true)).not.toBeNull();
    advance(14 * 60_000);
    expect(await manager.authorizationForToken(setup.token, true)).not.toBeNull();

    advance(2 * 60_000);
    await manager.setInactivityTimeout(1);
    expect(await manager.authorizationForToken(setup.token)).toBeNull();
    expect(await manager.status(dbPath)).toBe("locked");
  });

  it("does not extend inactivity for unauthenticated health checks", async () => {
    const { manager, advance } = controlledManager();
    const setup = await manager.setup(PASSPHRASE, dbPath);
    advance(14 * 60_000);
    expect(await manager.authorizationForActiveVault(false)).not.toBeNull();
    advance(60_001);
    expect(await manager.authorizationForToken(setup.token)).toBeNull();
  });

  it("expires despite background database reads, without deadlocking the first expired read", async () => {
    const { manager, advance } = controlledManager();
    const setup = await manager.setup(PASSPHRASE, dbPath);
    await manager.setInactivityTimeout(1);
    uninstallProvider = installDatabaseVaultAuthorizationProvider(() =>
      manager.authorizationForToken(setup.token));

    advance(30_000);
    await expect(readDb(() => "background")).resolves.toBe("background");
    advance(30_001);
    await expect(readDb(() => "expired")).rejects.toBeInstanceOf(VaultLockedError);
    expect(await manager.authorizationForActiveVault()).toBeNull();
  });

  it("serializes explicit locking with a simultaneous read and rejects subsequent access", async () => {
    const { manager } = controlledManager();
    const setup = await manager.setup(PASSPHRASE, dbPath);
    uninstallProvider = installDatabaseVaultAuthorizationProvider(() =>
      manager.authorizationForToken(setup.token));
    await readDb(() => null);

    const [read, locked] = await Promise.all([
      readDb(() => "read").then(() => "read", (error: unknown) => error),
      manager.lock(setup.token),
    ]);
    expect(read === "read" || read instanceof VaultLockedError).toBe(true);
    expect(locked).toBe(true);
    await expect(readDb(() => null)).rejects.toBeInstanceOf(VaultLockedError);
  });

  it("finishes an in-flight encrypted write before locking and destroying its key", async () => {
    const { manager } = controlledManager();
    const setup = await manager.setup(PASSPHRASE, dbPath);
    uninstallProvider = installDatabaseVaultAuthorizationProvider(() => manager.authorizationForToken(setup.token));
    let entered!: () => void;
    let finish!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const release = new Promise<void>((resolve) => { finish = resolve; });
    const write = withDb(async (_db, raw) => {
      raw.run("INSERT INTO settings (id, user_name) VALUES (7, 'Synthetic writer')");
      entered();
      await release;
    });
    await writing;
    const lock = manager.lock(setup.token);
    finish();
    await expect(write).resolves.toBeUndefined();
    await expect(lock).resolves.toBe(true);
    const token = await manager.unlock(PASSPHRASE, dbPath);
    uninstallProvider();
    uninstallProvider = installDatabaseVaultAuthorizationProvider(() => manager.authorizationForToken(token));
    expect(await readDb((_db, raw) => raw.exec("SELECT user_name FROM settings WHERE id = 7")[0].values[0][0])).toBe("Synthetic writer");
    await manager.lock(token);
  });

  it("loads the persisted timeout after a process-style restart and expires on it", async () => {
    const first = controlledManager();
    const setup = await first.manager.setup(PASSPHRASE, dbPath);
    const authorization = await first.manager.authorizationForToken(setup.token, false);
    await withDatabaseVaultAuthorization(authorization, async () => {
      await withDb((_db, raw) => {
        raw.run("INSERT INTO settings (id, idle_timeout_minutes) VALUES (7, 1)");
      });
    });
    await first.manager.lock(setup.token);

    const restarted = controlledManager();
    const token = await restarted.manager.unlock(PASSPHRASE, dbPath);
    expect(restarted.manager.timeoutMinutes).toBe(1);
    restarted.advance(60_001);
    expect(await restarted.manager.authorizationForToken(token)).toBeNull();
  });

  it("uses recovery once to rotate every managed generation and issue a new session", async () => {
    const { manager } = controlledManager();
    const setup = await manager.setup(PASSPHRASE, dbPath);
    await manager.lock(setup.token);

    const recovered = await manager.recover(
      setup.recoverySecret,
      "moonlit olive harbor 83 cedar",
      dbPath,
    );
    expect(recovered.recoverySecret).not.toBe(setup.recoverySecret);
    expect(await manager.authorizationForToken(recovered.token)).not.toBeNull();

    await expect(unlockDatabaseVault(PASSPHRASE, dbPath)).rejects.toThrow();
    const authorization = await unlockDatabaseVault("moonlit olive harbor 83 cedar", dbPath);
    destroyDatabaseVaultAuthorization(authorization);
    await manager.lock(recovered.token);
  });

  it("rotates the data key, so an old export and its secret cannot decrypt anything written after recovery", async () => {
    const { manager } = controlledManager();
    const setup = await manager.setup(PASSPHRASE, dbPath);
    await manager.lock(setup.token);
    const oldExport = readFileSync(dbPath);

    const recovered = await manager.recover(setup.recoverySecret, "moonlit olive harbor 83 cedar", dbPath);
    await manager.lock(recovered.token);

    const old = await unlockVaultEnvelopeWithRecovery(oldExport, setup.recoverySecret);
    old.plaintext.fill(0);
    await expect(decryptVaultGeneration(readFileSync(dbPath), old.key)).rejects.toThrow();
    destroyVaultKey(old.key);
  });

  it("keeps live recovery usable when backup repair is interrupted and never overwrites the unrepaired backup", async () => {
    let writes = 0;
    const clock = {
      now: () => 1_000,
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    };
    const manager = new VaultSessionManager(clock, {
      async writeGeneration(...args) {
        writes += 1;
        if (writes === 2) throw new Error("injected recovery publication failure");
        return writeEncryptedGenerationAtomically(...args);
      },
    });
    const setup = await manager.setup(PASSPHRASE, dbPath);
    await copyEncryptedGenerationAtomically(dbPath, `${dbPath}.bak`);
    await manager.lock(setup.token);
    const firstRecovery = await manager.recover(
      setup.recoverySecret,
      "moonlit olive harbor 83 cedar",
      dbPath,
    );
    expect(await manager.authorizationForToken(firstRecovery.token)).not.toBeNull();
    await manager.lock(firstRecovery.token);
    const backupPath = `${dbPath}.bak`;
    const staleBackup = readFileSync(backupPath);

    const secondRecovery = await manager.recover(
      firstRecovery.recoverySecret,
      "replacement harbor lantern 94",
      dbPath,
    );

    // The new secret opens the live generation; the stale backup keeps its own contents and older secret.
    const live = await unlockVaultEnvelopeWithRecovery(readFileSync(dbPath), secondRecovery.recoverySecret);
    live.plaintext.fill(0);
    destroyVaultKey(live.key);
    expect(managedVaultGenerationPaths(dbPath)).toContain(backupPath);
    expect(readFileSync(backupPath).equals(staleBackup)).toBe(true);
    const older = await unlockVaultEnvelopeWithRecovery(staleBackup, setup.recoverySecret);
    older.plaintext.fill(0);
    destroyVaultKey(older.key);
    await manager.lock(secondRecovery.token);
  }, 15_000);

  it("restores the old live generation when publication reports failure after rename", async () => {
    let injected = false;
    const manager = new VaultSessionManager(undefined, {
      async writeGeneration(...args) {
        await writeEncryptedGenerationAtomically(...args);
        if (!injected && args[2]?.purpose === "recovery-reset") {
          injected = true;
          throw new Error("injected post-rename fsync failure");
        }
      },
    });
    const setup = await manager.setup(PASSPHRASE, dbPath);
    await manager.lock(setup.token);
    const original = readFileSync(dbPath);

    await expect(manager.recover(
      setup.recoverySecret,
      "moonlit olive harbor 83 cedar",
      dbPath,
    )).rejects.toThrow(/post-rename fsync failure/);

    expect(readFileSync(dbPath)).toEqual(original);
    const recovered = await unlockVaultEnvelopeWithRecovery(
      readFileSync(dbPath),
      setup.recoverySecret,
    );
    recovered.plaintext.fill(0);
    destroyVaultKey(recovered.key);
  }, 15_000);
});
