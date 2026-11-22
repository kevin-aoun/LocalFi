import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { VaultLockedError } from "../vault/errors";

// Database path policy shared by the client, upgrades and restores, which must not import each other.
export const DEFAULT_DB_PATH = path.resolve(process.cwd(), "data", "budget.db");

export function resolveDbPath(): string {
  const override = process.env.BUDGET_DB_PATH;
  if (override && override.trim() !== "") return path.resolve(process.cwd(), override);
  return DEFAULT_DB_PATH;
}

function canonicalPotentialPath(file: string): string {
  const resolved = path.resolve(file);
  if (existsSync(resolved)) return realpathSync(resolved);
  const missing: string[] = [];
  let cursor = resolved;
  while (!existsSync(cursor)) {
    missing.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return path.join(realpathSync(cursor), ...missing);
}

// A plaintext fixture may never be the owner's database, a link to one, or, in tests, outside the temp dir.
function assertDisposablePath(file: string): void {
  const resolved = path.resolve(file);
  if (resolved === DEFAULT_DB_PATH || canonicalPotentialPath(resolved) === canonicalPotentialPath(DEFAULT_DB_PATH)) {
    throw new VaultLockedError("Plaintext fixture mode requires an explicit non-default path.");
  }
  if (existsSync(resolved) && realpathSync(resolved) !== resolved) {
    throw new VaultLockedError("Plaintext fixture mode refuses symbolic-link targets.");
  }
  if (
    process.env.NODE_ENV === "test" &&
    !canonicalPotentialPath(resolved).startsWith(`${canonicalPotentialPath(os.tmpdir())}${path.sep}`)
  ) {
    throw new VaultLockedError("Plaintext test fixtures must use an isolated temporary path.");
  }
}

/** The client resolves its own path, so it must also be pointed away from the default explicitly. */
export function assertPlaintextFixturePath(file: string): void {
  if (!process.env.BUDGET_DB_PATH?.trim()) {
    throw new VaultLockedError("Plaintext fixture mode requires an explicit non-default path.");
  }
  assertDisposablePath(file);
}

function assertPlaintextTestMode(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new VaultLockedError("Plaintext fixture mode is restricted to automated tests.");
  }
}

/** True only for an automated test's disposable path; throws when the bypass is requested anywhere else. */
export function plaintextFixtureMode(file: string): boolean {
  if (process.env.LOCALFI_VAULT_TEST_MODE !== "plaintext") return false;
  assertPlaintextFixturePath(file);
  assertPlaintextTestMode();
  return true;
}

/**
 * For upgrades and restores, which receive an explicit target: the bypass applies only
 * to an automated test's disposable path. Non-throwing, so callers refuse plaintext with their own error.
 */
export function plaintextFixtureAllowed(file: string): boolean {
  if (process.env.LOCALFI_VAULT_TEST_MODE !== "plaintext") return false;
  try {
    assertDisposablePath(file);
    assertPlaintextTestMode();
    return true;
  } catch {
    return false;
  }
}
