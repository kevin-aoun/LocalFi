import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertPlaintextFixturePath,
  closeDb,
  destroyDatabaseVaultAuthorization,
  installDatabaseVaultAuthorizationProvider,
  readDb,
  snapshotEncryptedDatabaseGeneration,
  unlockDatabaseVault,
  withDb,
} from "../client";
import { buildInitialDatabaseImage, setupVaultDatabase } from "../init";
import { destroyVaultKey, isLegacySqliteImage, isVaultEnvelope } from "../../vault/envelope";
import {
  VaultAuthenticationError,
  VaultLockedError,
} from "../../vault/errors";
import { managedVaultGenerationPaths } from "../../vault/paths";

const PASSPHRASE = "a strong disposable vault integration passphrase";
let directory: string;
let dbPath: string;
let originalTestMode: string | undefined;
let uninstallAuthorization: (() => void) | null = null;
let authorization: Awaited<ReturnType<typeof unlockDatabaseVault>> | null = null;

async function authorize(passphrase = PASSPHRASE): Promise<void> {
  authorization = await unlockDatabaseVault(passphrase, dbPath);
  uninstallAuthorization = installDatabaseVaultAuthorizationProvider(() => authorization);
}

beforeEach(async () => {
  await closeDb();
  directory = mkdtempSync(path.join(os.tmpdir(), "localfi-vault-client-"));
  chmodSync(directory, 0o700);
  dbPath = path.join(directory, "budget.db");
  process.env.BUDGET_DB_PATH = dbPath;
  originalTestMode = process.env.LOCALFI_VAULT_TEST_MODE;
  delete process.env.LOCALFI_VAULT_TEST_MODE;
});

afterEach(async () => {
  await closeDb();
  uninstallAuthorization?.();
  uninstallAuthorization = null;
  if (authorization) destroyDatabaseVaultAuthorization(authorization);
  authorization = null;
  delete process.env.BUDGET_DB_PATH;
  if (originalTestMode === undefined) delete process.env.LOCALFI_VAULT_TEST_MODE;
  else process.env.LOCALFI_VAULT_TEST_MODE = originalTestMode;
  rmSync(directory, { recursive: true, force: true });
});

describe.sequential("encrypted sql.js client boundary", () => {
  it("requires an explicit non-owner path for plaintext fixture mode", () => {
    delete process.env.BUDGET_DB_PATH;
    expect(() => assertPlaintextFixturePath(dbPath)).toThrow(/explicit non-default path/i);

    const defaultPath = path.resolve(process.cwd(), "data", "budget.db");
    process.env.BUDGET_DB_PATH = defaultPath;
    expect(() => assertPlaintextFixturePath(defaultPath)).toThrow(/explicit non-default path/i);
    process.env.BUDGET_DB_PATH = dbPath;
  });

  it("sets up a usable encrypted first generation with default categories", async () => {
    const setup = await setupVaultDatabase({ dbPath, passphrase: PASSPHRASE });
    destroyVaultKey(setup.key);

    const stored = readFileSync(dbPath);
    expect(setup).toMatchObject({ created: true, convertedLegacy: false });
    expect(setup.recoverySecret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(isVaultEnvelope(stored)).toBe(true);
    expect(isLegacySqliteImage(stored)).toBe(false);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);

    await authorize();
    expect(await readDb((_db, raw) =>
      Number(raw.exec("SELECT COUNT(*) FROM categories")[0].values[0][0])
    )).toBe(15);
  });

  it("fails locked without opening or changing an encrypted generation", async () => {
    const setup = await setupVaultDatabase({ dbPath, passphrase: PASSPHRASE });
    destroyVaultKey(setup.key);
    const before = readFileSync(dbPath);

    await expect(readDb(() => null)).rejects.toBeInstanceOf(VaultLockedError);
    expect(readFileSync(dbPath)).toEqual(before);
  });

  it("encrypts live, automatic backup, and temporary persistence generations", async () => {
    const setup = await setupVaultDatabase({ dbPath, passphrase: PASSPHRASE });
    destroyVaultKey(setup.key);
    await authorize();

    await withDb(async (db) => {
      await db.run(sql`UPDATE settings SET user_name = 'First generation' WHERE id = 1`);
    });
    const first = readFileSync(dbPath);
    await withDb(async (db) => {
      await db.run(sql`UPDATE settings SET user_name = 'Second generation' WHERE id = 1`);
    });
    const second = readFileSync(dbPath);
    const backup = readFileSync(`${dbPath}.bak`);

    expect(first).not.toEqual(second);
    expect(backup).toEqual(first);
    expect(isVaultEnvelope(second)).toBe(true);
    expect(isVaultEnvelope(backup)).toBe(true);
    expect(statSync(`${dbPath}.bak`).mode & 0o777).toBe(0o600);
  });

  it("returns only the active encrypted generation through the export snapshot seam", async () => {
    const setup = await setupVaultDatabase({ dbPath, passphrase: PASSPHRASE });
    destroyVaultKey(setup.key);
    await authorize();
    await readDb(() => null);

    const snapshot = await snapshotEncryptedDatabaseGeneration();
    expect(Buffer.from(snapshot.bytes)).toEqual(readFileSync(dbPath));
    expect(snapshot.fileName).toBe("budget.localfi-vault");
    expect(isLegacySqliteImage(snapshot.bytes)).toBe(false);
  });

  it("converts legacy SQLite only through setup and preserves an encrypted recovery generation", async () => {
    writeFileSync(dbPath, await buildInitialDatabaseImage(), { mode: 0o600 });
    const legacy = readFileSync(dbPath);

    const setup = await setupVaultDatabase({ dbPath, passphrase: PASSPHRASE });
    destroyVaultKey(setup.key);

    expect(setup).toMatchObject({ created: false, convertedLegacy: true });
    const generations = managedVaultGenerationPaths(dbPath);
    expect(generations.length).toBeGreaterThanOrEqual(2);
    for (const generation of generations) {
      const bytes = readFileSync(generation);
      expect(isVaultEnvelope(bytes)).toBe(true);
      expect(Buffer.from(bytes).includes(legacy.subarray(0, 32))).toBe(false);
      expect(statSync(generation).mode & 0o777).toBe(0o600);
    }
  });

  it("hardens ordinary legacy directory and file permissions during setup", async () => {
    writeFileSync(dbPath, await buildInitialDatabaseImage(), { mode: 0o644 });
    chmodSync(directory, 0o755);
    chmodSync(dbPath, 0o644);

    const setup = await setupVaultDatabase({ dbPath, passphrase: PASSPHRASE });
    destroyVaultKey(setup.key);

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(isVaultEnvelope(readFileSync(dbPath))).toBe(true);
  });

  it("rejects wrong passphrases and ciphertext tampering before sql.js opens", async () => {
    const setup = await setupVaultDatabase({ dbPath, passphrase: PASSPHRASE });
    destroyVaultKey(setup.key);
    await expect(unlockDatabaseVault("incorrect passphrase", dbPath))
      .rejects.toBeInstanceOf(VaultAuthenticationError);

    const tampered = readFileSync(dbPath);
    tampered[tampered.length - 1] ^= 0x01;
    writeFileSync(dbPath, tampered, { mode: 0o600 });
    await expect(unlockDatabaseVault(PASSPHRASE, dbPath))
      .rejects.toBeInstanceOf(VaultAuthenticationError);
  });
});
