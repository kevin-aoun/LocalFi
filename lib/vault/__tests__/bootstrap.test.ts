import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  consumeVaultBootstrapCredential,
  verifyVaultBootstrapCredential,
} from "../bootstrap";

const CREDENTIAL = "compose-generated-bootstrap-credential-47";
let directory: string;
let credentialFile: string;
let originalCredential: string | undefined;
let originalCredentialFile: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "localfi-bootstrap-"));
  chmodSync(directory, 0o700);
  credentialFile = path.join(directory, ".localfi-bootstrap-token");
  originalCredential = process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN;
  originalCredentialFile = process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN_FILE;
  delete process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN;
  process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN_FILE = credentialFile;
});

afterEach(() => {
  if (originalCredential === undefined) delete process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN;
  else process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN = originalCredential;
  if (originalCredentialFile === undefined) delete process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN_FILE;
  else process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN_FILE = originalCredentialFile;
  rmSync(directory, { recursive: true, force: true });
});

describe("vault bootstrap credential", () => {
  it("verifies and consumes an owner-only Compose credential file", () => {
    writeFileSync(credentialFile, `${CREDENTIAL}\n`, { mode: 0o600 });

    expect(verifyVaultBootstrapCredential(CREDENTIAL)).toBe(true);
    expect(verifyVaultBootstrapCredential(`${CREDENTIAL}-wrong`)).toBe(false);
    consumeVaultBootstrapCredential();
    expect(() => readFileSync(credentialFile)).toThrow();
    expect(verifyVaultBootstrapCredential(CREDENTIAL)).toBe(false);
  });

  it("rejects permissive files and symlink aliases", () => {
    writeFileSync(credentialFile, CREDENTIAL, { mode: 0o644 });
    expect(verifyVaultBootstrapCredential(CREDENTIAL)).toBe(false);

    rmSync(credentialFile);
    const target = path.join(directory, "credential-target");
    writeFileSync(target, CREDENTIAL, { mode: 0o600 });
    symlinkSync(target, credentialFile);
    expect(verifyVaultBootstrapCredential(CREDENTIAL)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(CREDENTIAL);
  });

  it("keeps the explicit process credential for local development", () => {
    process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN = CREDENTIAL;
    expect(verifyVaultBootstrapCredential(CREDENTIAL)).toBe(true);
    consumeVaultBootstrapCredential();
    expect(process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN).toBeUndefined();
  });
});
