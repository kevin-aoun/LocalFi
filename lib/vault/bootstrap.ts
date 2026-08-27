import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

const BOOTSTRAP_ENV = "LOCALFI_VAULT_BOOTSTRAP_TOKEN";
const BOOTSTRAP_FILE_ENV = "LOCALFI_VAULT_BOOTSTRAP_TOKEN_FILE";
const BOOTSTRAP_FILE_NAME = ".localfi-bootstrap-token";
const MIN_BOOTSTRAP_LENGTH = 24;
const MAX_BOOTSTRAP_LENGTH = 512;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function validCredential(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= MIN_BOOTSTRAP_LENGTH &&
    value.length <= MAX_BOOTSTRAP_LENGTH;
}

function configuredCredentialFile(): string | null {
  const file = process.env[BOOTSTRAP_FILE_ENV]?.trim();
  return file && path.basename(file) === BOOTSTRAP_FILE_NAME ? file : null;
}

function credentialFromOwnerFile(): string | null {
  const file = configuredCredentialFile();
  if (!file) return null;

  let descriptor: number | null = null;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    const effectiveUid = process.geteuid?.();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (effectiveUid !== undefined && stat.uid !== effectiveUid) ||
      stat.size < MIN_BOOTSTRAP_LENGTH ||
      stat.size > MAX_BOOTSTRAP_LENGTH + 1
    ) {
      return null;
    }
    const credential = readFileSync(descriptor, "utf8").trim();
    return validCredential(credential) ? credential : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function verifyVaultBootstrapCredential(candidate: unknown): boolean {
  const environmentCredential = process.env[BOOTSTRAP_ENV];
  const expected = validCredential(environmentCredential)
    ? environmentCredential
    : credentialFromOwnerFile();
  if (!validCredential(candidate) || !expected) return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

export function consumeVaultBootstrapCredential(): void {
  delete process.env[BOOTSTRAP_ENV];
  const file = configuredCredentialFile();
  if (!file || !credentialFromOwnerFile()) return;
  try {
    unlinkSync(file);
  } catch {
    // Setup has already succeeded. A stale credential file is harmless and will
    // be removed by the next Compose preflight for an initialized vault.
  }
}
