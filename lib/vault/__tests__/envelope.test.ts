import path from "node:path";

import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createVaultEnvelope,
  decryptVaultGeneration,
  destroyVaultKey,
  encryptVaultGeneration,
  inspectVaultEnvelope,
  isLegacySqliteImage,
  isVaultEnvelope,
  recoverAndRewrapVaultEnvelope,
  unlockVaultEnvelope,
  unlockVaultEnvelopeWithRecovery,
} from "../envelope";
import { VaultAuthenticationError, VaultEnvelopeError } from "../errors";

let sqliteImage: Uint8Array;

beforeAll(async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules/sql.js/dist", file),
  });
  const db = new SQL.Database();
  db.run("CREATE TABLE secrets (value TEXT NOT NULL)");
  db.run("INSERT INTO secrets (value) VALUES ('known-vault-plaintext-marker')");
  sqliteImage = Uint8Array.from(db.export());
  db.close();
});

describe.sequential("versioned vault envelope", () => {
  it("round-trips SQLite through passphrase and independent recovery wraps", async () => {
    const created = await createVaultEnvelope(sqliteImage, "correct horse battery staple");
    expect(isVaultEnvelope(created.envelope)).toBe(true);
    expect(isLegacySqliteImage(created.envelope)).toBe(false);
    expect(Buffer.from(created.envelope).includes(Buffer.from("SQLite format 3\0"))).toBe(false);
    expect(Buffer.from(created.envelope).includes(Buffer.from("known-vault-plaintext-marker")))
      .toBe(false);
    expect(await inspectVaultEnvelope(created.envelope)).toMatchObject({
      encrypted: true,
      version: 1,
      kdfAlgorithm: "argon2id13",
      plaintextBytes: sqliteImage.byteLength,
      recoveryWrapped: true,
    });

    const unlocked = await unlockVaultEnvelope(
      created.envelope,
      "correct horse battery staple",
    );
    expect(unlocked.plaintext).toEqual(sqliteImage);
    const recovered = await unlockVaultEnvelopeWithRecovery(
      created.envelope,
      created.recoverySecret,
    );
    expect(recovered.plaintext).toEqual(sqliteImage);

    unlocked.plaintext.fill(0);
    recovered.plaintext.fill(0);
    destroyVaultKey(unlocked.key);
    destroyVaultKey(recovered.key);
    destroyVaultKey(created.key);
  });

  it("uses a fresh random payload nonce for every persisted generation", async () => {
    const created = await createVaultEnvelope(sqliteImage, "another strong local passphrase");
    const first = await encryptVaultGeneration(sqliteImage, created.key);
    const second = await encryptVaultGeneration(sqliteImage, created.key);

    expect(first).not.toEqual(second);
    expect(await decryptVaultGeneration(first, created.key)).toEqual(sqliteImage);
    expect(await decryptVaultGeneration(second, created.key)).toEqual(sqliteImage);
    destroyVaultKey(created.key);
  });

  it("fails closed on a wrong passphrase and header, ciphertext, or tag tampering", async () => {
    const created = await createVaultEnvelope(sqliteImage, "do not reveal this passphrase");
    await expect(unlockVaultEnvelope(created.envelope, "wrong passphrase"))
      .rejects.toBeInstanceOf(VaultAuthenticationError);

    for (const offset of [20, created.envelope.length - 20, created.envelope.length - 1]) {
      const tampered = Uint8Array.from(created.envelope);
      tampered[offset] ^= 0x01;
      await expect(unlockVaultEnvelope(tampered, "do not reveal this passphrase")).rejects.toThrow();
    }
    destroyVaultKey(created.key);
  });

  it("rejects attacker-selected Argon2 parameters before attempting authentication", async () => {
    const created = await createVaultEnvelope(sqliteImage, "bounded argon parameters only");
    const bytes = Buffer.from(created.envelope);
    const marker = Buffer.from('"opsLimit":2');
    const offset = bytes.indexOf(marker);
    expect(offset).toBeGreaterThan(0);
    bytes[offset + marker.length - 1] = "9".charCodeAt(0);

    await expect(unlockVaultEnvelope(bytes, "bounded argon parameters only"))
      .rejects.toBeInstanceOf(VaultEnvelopeError);
    destroyVaultKey(created.key);
  });

  it("uses recovery to rotate both the passphrase and one-time recovery material", async () => {
    const created = await createVaultEnvelope(sqliteImage, "forgotten vault passphrase");
    const reset = await recoverAndRewrapVaultEnvelope(
      created.envelope,
      created.recoverySecret,
      "replacement vault passphrase",
    );

    await expect(unlockVaultEnvelope(reset.envelope, "forgotten vault passphrase"))
      .rejects.toBeInstanceOf(VaultAuthenticationError);
    await expect(unlockVaultEnvelopeWithRecovery(reset.envelope, created.recoverySecret))
      .rejects.toBeInstanceOf(VaultAuthenticationError);
    const unlocked = await unlockVaultEnvelope(reset.envelope, "replacement vault passphrase");
    expect(unlocked.plaintext).toEqual(sqliteImage);

    unlocked.plaintext.fill(0);
    destroyVaultKey(unlocked.key);
    destroyVaultKey(created.key);
    destroyVaultKey(reset.key);
  });

  it("shares key state and destruction across server module instances", async () => {
    const created = await createVaultEnvelope(sqliteImage, "cross chunk key state passphrase");

    vi.resetModules();
    const secondEnvelope = await import("../envelope");
    secondEnvelope.destroyVaultKey(created.key);

    expect(created.key.destroyed).toBe(true);
    await expect(encryptVaultGeneration(sqliteImage, created.key))
      .rejects.toBeInstanceOf(VaultAuthenticationError);
  });
});
