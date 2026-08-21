import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import initSqlJs from "sql.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createVaultEnvelope, destroyVaultKey } from "../envelope";
import { VaultPathError, VaultPermissionError } from "../errors";
import {
  copyEncryptedGenerationAtomically,
  hardenLegacyVaultPathForSetup,
  readEncryptedGeneration,
  writeEncryptedGenerationAtomically,
} from "../paths";

const directories: string[] = [];
let sqliteImage: Uint8Array;

beforeAll(async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules/sql.js/dist", file),
  });
  const db = new SQL.Database();
  db.run("CREATE TABLE marker (value TEXT NOT NULL)");
  sqliteImage = Uint8Array.from(db.export());
  db.close();
});

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function directory(): string {
  const result = mkdtempSync(path.join(os.tmpdir(), "localfi-vault-paths-"));
  directories.push(result);
  return result;
}

describe.sequential("owner-only encrypted generation paths", () => {
  it("hardens same-owner legacy modes but rejects aliases and wrong ownership", () => {
    const root = directory();
    const legacy = path.join(root, "legacy.db");
    writeFileSync(legacy, sqliteImage, { mode: 0o644 });
    chmodSync(root, 0o755);

    hardenLegacyVaultPathForSetup(legacy);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(legacy).mode & 0o777).toBe(0o600);

    const symlink = path.join(root, "legacy-symlink.db");
    symlinkSync(legacy, symlink);
    expect(() => hardenLegacyVaultPathForSetup(symlink)).toThrow(VaultPathError);

    const hardlink = path.join(root, "legacy-hardlink.db");
    linkSync(legacy, hardlink);
    expect(() => hardenLegacyVaultPathForSetup(legacy)).toThrow(VaultPathError);

    const ownerCheck = path.join(root, "owner-check.db");
    writeFileSync(ownerCheck, sqliteImage, { mode: 0o600 });
    if (typeof process.getuid === "function") {
      const uid = process.getuid();
      const getuid = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
      try {
        expect(() => hardenLegacyVaultPathForSetup(ownerCheck)).toThrow(VaultPermissionError);
      } finally {
        getuid.mockRestore();
      }
    }
  });

  it("writes live and backup generations atomically with owner-only modes", async () => {
    const root = directory();
    const vaultDirectory = path.join(root, "vault");
    const live = path.join(vaultDirectory, "budget.db");
    const backup = `${live}.bak`;
    const created = await createVaultEnvelope(sqliteImage, "owner only generation passphrase");

    await writeEncryptedGenerationAtomically(live, created.envelope, { replace: false });
    await copyEncryptedGenerationAtomically(live, backup);

    expect(statSync(vaultDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(live).mode & 0o777).toBe(0o600);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(await readEncryptedGeneration(live)).toEqual(Buffer.from(created.envelope));
    expect(readdirSync(vaultDirectory).sort()).toEqual(["budget.db", "budget.db.bak"]);
    destroyVaultKey(created.key);
  });

  it("rejects symlink and hard-link aliases without changing the protected bytes", async () => {
    const root = directory();
    const live = path.join(root, "budget.db");
    const created = await createVaultEnvelope(sqliteImage, "alias rejection passphrase");
    await writeEncryptedGenerationAtomically(live, created.envelope, { replace: false });
    const original = readFileSync(live);

    const symlink = path.join(root, "symlink.db");
    symlinkSync(live, symlink);
    await expect(readEncryptedGeneration(symlink)).rejects.toBeInstanceOf(VaultPathError);

    const hardlink = path.join(root, "hardlink.db");
    linkSync(live, hardlink);
    await expect(readEncryptedGeneration(live)).rejects.toBeInstanceOf(VaultPathError);
    expect(existsSync(live)).toBe(true);
    expect(readFileSync(live)).toEqual(original);
    destroyVaultKey(created.key);
  });

  it("refuses a shared parent directory without silently changing its permissions", async () => {
    const root = directory();
    chmodSync(root, 0o755);
    const target = path.join(root, "budget.db");
    const created = await createVaultEnvelope(sqliteImage, "unsafe directory passphrase");

    await expect(writeEncryptedGenerationAtomically(target, created.envelope))
      .rejects.toBeInstanceOf(VaultPermissionError);
    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(existsSync(target)).toBe(false);
    destroyVaultKey(created.key);
  });
});
