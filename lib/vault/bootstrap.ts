import { createHash, timingSafeEqual } from "node:crypto";

const BOOTSTRAP_ENV = "LOCALFI_VAULT_BOOTSTRAP_TOKEN";
const MIN_BOOTSTRAP_LENGTH = 24;
const MAX_BOOTSTRAP_LENGTH = 512;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function verifyVaultBootstrapCredential(candidate: unknown): boolean {
  const expected = process.env[BOOTSTRAP_ENV];
  if (
    typeof candidate !== "string" ||
    candidate.length < MIN_BOOTSTRAP_LENGTH ||
    candidate.length > MAX_BOOTSTRAP_LENGTH ||
    typeof expected !== "string" ||
    expected.length < MIN_BOOTSTRAP_LENGTH ||
    expected.length > MAX_BOOTSTRAP_LENGTH
  ) {
    return false;
  }
  return timingSafeEqual(digest(candidate), digest(expected));
}

export function consumeVaultBootstrapCredential(): void {
  delete process.env[BOOTSTRAP_ENV];
}
