import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  closeDb,
  destroyDatabaseVaultAuthorization,
  readAuthorizedVaultInactivityTimeout,
  resolveDbPath,
  type DatabaseVaultAuthorization,
  unlockDatabaseVault,
} from "../db/client";
import { setupVaultDatabase } from "../db/init";
import { acquireWriterLease } from "../db/writer-lease";
import {
  decryptVaultGeneration,
  destroyVaultKey,
  encryptVaultGeneration,
  inspectVaultEnvelope,
  isLegacySqliteImage,
  isVaultEnvelope,
  recoverAndRewrapVaultEnvelope,
  type UnlockedVaultKey,
  unlockVaultEnvelopeWithRecovery,
} from "./envelope";
import { VaultLockedError, VaultPermissionError } from "./errors";
import {
  managedVaultGenerationPaths,
  readEncryptedGeneration,
  readSensitiveGeneration,
  writeEncryptedGenerationAtomically,
} from "./paths";
import { parseInactivityTimeout } from "./passphrase";

export { VAULT_SESSION_COOKIE } from "./constants";
export const DEFAULT_INACTIVITY_MINUTES = 15;

export type VaultStatus = "uninitialized" | "locked" | "unlocked";

type Timer = ReturnType<typeof setTimeout>;
type SessionClock = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): Timer;
  clearTimer(timer: Timer): void;
};

type SessionPersistence = {
  writeGeneration: typeof writeEncryptedGenerationAtomically;
};

const systemClock: SessionClock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer),
};

function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export class VaultSessionManager {
  private authorization: DatabaseVaultAuthorization | null = null;
  private readonly sessions = new Set<string>();
  private inactivityMinutes = DEFAULT_INACTIVITY_MINUTES;
  private lastActivity = 0;
  private expiryTimer: Timer | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly clock: SessionClock = systemClock,
    private readonly persistence: SessionPersistence = {
      writeGeneration: writeEncryptedGenerationAtomically,
    },
  ) {}

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private deadline(): number {
    return this.lastActivity + this.inactivityMinutes * 60_000;
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) this.clock.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    if (!this.authorization) return;
    const delay = Math.max(0, this.deadline() - this.clock.now());
    this.expiryTimer = this.clock.setTimer(() => {
      void this.expireIfDue();
    }, delay);
  }

  private async clearUnlockedState(): Promise<void> {
    if (this.expiryTimer) this.clock.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    const authorization = this.authorization;
    this.authorization = null;
    this.sessions.clear();
    this.lastActivity = 0;
    await closeDb();
    if (authorization) destroyDatabaseVaultAuthorization(authorization);
  }

  private async expireIfDue(): Promise<void> {
    await this.exclusive(async () => {
      if (!this.authorization) return;
      if (this.clock.now() < this.deadline()) {
        this.scheduleExpiry();
        return;
      }
      await this.clearUnlockedState();
    });
  }

  private async replaceAuthorization(next: DatabaseVaultAuthorization): Promise<string> {
    await this.clearUnlockedState();
    this.authorization = next;
    const token = newToken();
    this.sessions.add(digestToken(token));
    this.lastActivity = this.clock.now();
    this.scheduleExpiry();
    return token;
  }

  private async unlockWithPersistedTimeout(
    passphrase: string,
    dbPath: string,
  ): Promise<DatabaseVaultAuthorization> {
    const authorization = await unlockDatabaseVault(passphrase, dbPath);
    try {
      this.inactivityMinutes = await readAuthorizedVaultInactivityTimeout(authorization);
      return authorization;
    } catch (error) {
      destroyDatabaseVaultAuthorization(authorization);
      throw error;
    }
  }

  async setup(passphrase: string, dbPath = resolveDbPath()): Promise<{
    token: string;
    recoverySecret: string;
  }> {
    return this.exclusive(async () => {
      if (this.authorization) {
        throw new VaultLockedError("The LocalFi vault has already been initialized.");
      }
      const setup = await setupVaultDatabase({ passphrase, dbPath });
      destroyVaultKey(setup.key);
      const authorization = await this.unlockWithPersistedTimeout(passphrase, dbPath);
      return {
        token: await this.replaceAuthorization(authorization),
        recoverySecret: setup.recoverySecret,
      };
    });
  }

  async unlock(passphrase: string, dbPath = resolveDbPath()): Promise<string> {
    return this.exclusive(async () => {
      const authorization = await this.unlockWithPersistedTimeout(passphrase, dbPath);
      return this.replaceAuthorization(authorization);
    });
  }

  async recover(
    recoverySecret: string,
    nextPassphrase: string,
    dbPath = resolveDbPath(),
  ): Promise<{ token: string; recoverySecret: string }> {
    return this.exclusive(async () => {
      const file = path.resolve(dbPath);
      const lease = await acquireWriterLease(file);
      let reset: Awaited<ReturnType<typeof recoverAndRewrapVaultEnvelope>> | null = null;
      let recoveredPlaintext: Uint8Array | null = null;
      try {
        if (!existsSync(file)) throw new VaultLockedError();
        const originalLive = await readEncryptedGeneration(file);
        reset = await recoverAndRewrapVaultEnvelope(
          originalLive,
          recoverySecret,
          nextPassphrase,
        );
        recoveredPlaintext = await decryptVaultGeneration(reset.envelope, reset.key);
        let livePublicationAttempted = false;
        try {
          lease.assertOwned();
          livePublicationAttempted = true;
          await this.persistence.writeGeneration(file, reset.envelope, {
            replace: true,
            purpose: "recovery-reset",
          });
          const verified = await decryptVaultGeneration(await readEncryptedGeneration(file), reset.key);
          verified.fill(0);
        } catch (publicationError) {
          if (livePublicationAttempted) {
            try {
              lease.assertOwned();
              await this.persistence.writeGeneration(file, originalLive, {
                replace: true,
                purpose: "recovery-rollback",
              });
            } catch {
              throw new VaultLockedError(
                "Recovery publication failed and the encrypted live generation could not be rolled back.",
              );
            }
          }
          throw publicationError;
        }

        let backupPaths: string[] = [];
        try {
          backupPaths = managedVaultGenerationPaths(file).filter((candidate) => candidate !== file);
        } catch (error) {
          console.warn("[vault] recovered the live vault but could not enumerate managed backups:", error);
        }
        for (const backupPath of backupPaths) {
          let backupPlaintext: Uint8Array | null = null;
          let backupKey: UnlockedVaultKey | null = null;
          try {
            try {
              const unlocked = await unlockVaultEnvelopeWithRecovery(
                await readEncryptedGeneration(backupPath),
                recoverySecret,
              );
              backupPlaintext = unlocked.plaintext;
              backupKey = unlocked.key;
            } catch {
              backupPlaintext = recoveredPlaintext;
            }
            const replacement = await encryptVaultGeneration(backupPlaintext, reset.key);
            lease.assertOwned();
            await this.persistence.writeGeneration(backupPath, replacement, {
              replace: true,
              purpose: "recovery-repair",
            });
          } catch (error) {
            console.warn(`[vault] recovered the live vault but could not repair ${backupPath}:`, error);
          } finally {
            if (backupPlaintext && backupPlaintext !== recoveredPlaintext) backupPlaintext.fill(0);
            if (backupKey) destroyVaultKey(backupKey);
          }
        }
      } catch (error) {
        if (reset) destroyVaultKey(reset.key);
        throw error;
      } finally {
        recoveredPlaintext?.fill(0);
        await lease.release();
      }

      try {
        const authorization = await this.unlockWithPersistedTimeout(nextPassphrase, file);
        return {
          token: await this.replaceAuthorization(authorization),
          recoverySecret: reset!.recoverySecret,
        };
      } finally {
        if (reset) destroyVaultKey(reset.key);
      }
    });
  }

  async authorizationForToken(
    token: string | null | undefined,
    touch = true,
  ): Promise<DatabaseVaultAuthorization | null> {
    return this.exclusive(async () => {
      if (!this.authorization) return null;
      if (this.clock.now() >= this.deadline()) {
        await this.clearUnlockedState();
        return null;
      }
      if (!token || !this.sessions.has(digestToken(token))) return null;
      if (touch) {
        this.lastActivity = this.clock.now();
        this.scheduleExpiry();
      }
      return this.authorization;
    });
  }

  async authorizationForActiveVault(touch = true): Promise<DatabaseVaultAuthorization | null> {
    return this.exclusive(async () => {
      if (!this.authorization) return null;
      if (this.clock.now() >= this.deadline()) {
        await this.clearUnlockedState();
        return null;
      }
      if (touch) {
        this.lastActivity = this.clock.now();
        this.scheduleExpiry();
      }
      return this.authorization;
    });
  }

  async status(dbPath = resolveDbPath()): Promise<VaultStatus> {
    const active = await this.authorizationForActiveVault(false);
    if (active) return "unlocked";
    const file = path.resolve(dbPath);
    if (!existsSync(file)) return "uninitialized";
    let generation: Buffer;
    try {
      generation = readSensitiveGeneration(file);
    } catch (error) {
      if (error instanceof VaultPermissionError) return "uninitialized";
      throw error;
    }
    if (isLegacySqliteImage(generation)) return "uninitialized";
    if (isVaultEnvelope(generation)) {
      await inspectVaultEnvelope(generation);
      return "locked";
    }
    throw new VaultLockedError(
      "The LocalFi database has an unknown or corrupt format; restore a valid generation before setup.",
    );
  }

  async lock(token: string | null | undefined): Promise<boolean> {
    return this.exclusive(async () => {
      if (!token || !this.sessions.has(digestToken(token))) return false;
      await this.clearUnlockedState();
      return true;
    });
  }

  async setInactivityTimeout(value: unknown): Promise<number> {
    const minutes = parseInactivityTimeout(value);
    return this.exclusive(async () => {
      this.inactivityMinutes = minutes;
      if (this.authorization) {
        if (this.clock.now() >= this.deadline()) await this.clearUnlockedState();
        else this.scheduleExpiry();
      }
      return minutes;
    });
  }

  get timeoutMinutes(): number {
    return this.inactivityMinutes;
  }
}

const sessionGlobals = globalThis as typeof globalThis & {
  __localfiVaultSessionManager?: VaultSessionManager;
};

export const vaultSessionManager =
  (sessionGlobals.__localfiVaultSessionManager ??= new VaultSessionManager());
