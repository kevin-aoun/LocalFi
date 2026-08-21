import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDb, withDb } from "@/lib/db/client";
import { withVaultSessionToken } from "@/lib/vault/access";
import { VaultLockedError } from "@/lib/vault/errors";
import { VAULT_SESSION_COOKIE, vaultSessionManager } from "@/lib/vault/session";
import { POST as setup } from "../setup/route";
import { GET as status, POST as touchStatus } from "../status/route";

const PASSPHRASE = "cedar harbor lantern 47 violet";
const BOOTSTRAP = "disposable-bootstrap-credential-47";
let directory: string;
let dbPath: string;
let activeToken: string | null;
let originalPort: string | undefined;
let originalMode: string | undefined;
let originalBootstrap: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "localfi-vault-route-"));
  chmodSync(directory, 0o700);
  dbPath = path.join(directory, "budget.db");
  process.env.BUDGET_DB_PATH = dbPath;
  originalPort = process.env.PORT;
  originalMode = process.env.LOCALFI_VAULT_TEST_MODE;
  originalBootstrap = process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN;
  process.env.PORT = "1313";
  delete process.env.LOCALFI_VAULT_TEST_MODE;
  process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN = BOOTSTRAP;
  activeToken = null;
});

afterEach(async () => {
  if (activeToken) await vaultSessionManager.lock(activeToken);
  delete process.env.BUDGET_DB_PATH;
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
  if (originalMode === undefined) delete process.env.LOCALFI_VAULT_TEST_MODE;
  else process.env.LOCALFI_VAULT_TEST_MODE = originalMode;
  if (originalBootstrap === undefined) delete process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN;
  else process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN = originalBootstrap;
  rmSync(directory, { recursive: true, force: true });
});

function setupRequest(body: Record<string, unknown>, url = "http://127.0.0.1:1313") {
  return new Request(`${url}/api/vault/setup`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tokenFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  const token = new RegExp(`${VAULT_SESSION_COOKIE}=([^;]+)`).exec(cookie)?.[1];
  if (!token) throw new Error("session cookie missing");
  return token;
}

describe.sequential("vault setup route", () => {
  it("rejects weak acknowledgement bypasses and DNS-rebound origins before setup", async () => {
    const weak = await setup(setupRequest({
      bootstrapCredential: BOOTSTRAP,
      passphrase: "passwordpassword",
      confirmPassphrase: "passwordpassword",
      acknowledgeWeak: false,
    }));
    expect(weak.status).toBe(400);

    const rebound = await setup(setupRequest({
      bootstrapCredential: BOOTSTRAP,
      passphrase: PASSPHRASE,
      confirmPassphrase: PASSPHRASE,
      acknowledgeWeak: false,
    }, "http://evil.example:3000"));
    expect(rebound.status).toBe(403);
  });

  it("rejects a forged same-origin setup request without the owner bootstrap credential", async () => {
    const response = await setup(setupRequest({
      bootstrapCredential: "attacker-controlled-bootstrap-value",
      passphrase: PASSPHRASE,
      confirmPassphrase: PASSPHRASE,
      acknowledgeWeak: false,
    }));

    expect(response.status).toBe(401);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("returns recovery material once and only an opaque protected cookie", async () => {
    const response = await setup(setupRequest({
      bootstrapCredential: BOOTSTRAP,
      passphrase: PASSPHRASE,
      confirmPassphrase: PASSPHRASE,
      acknowledgeWeak: false,
    }));
    const body = await response.json() as { status: string; recoverySecret: string };
    activeToken = tokenFrom(response);

    expect(response.status).toBe(200);
    expect(body.status).toBe("unlocked");
    expect(body.recoverySecret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(body)).not.toContain(PASSPHRASE);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(process.env.LOCALFI_VAULT_BOOTSTRAP_TOKEN).toBeUndefined();

    const stored = readFileSync(dbPath);
    await expect(readDb(() => null)).rejects.toBeInstanceOf(VaultLockedError);
    expect(readFileSync(dbPath)).toEqual(stored);
    await expect(withVaultSessionToken("forged", () => readDb(() => null)))
      .rejects.toBeInstanceOf(VaultLockedError);
    await withVaultSessionToken(activeToken, () => withDb((_db, raw) => {
      raw.run("INSERT INTO settings (id, user_name) VALUES (9, 'Authorized owner')");
    }));
    expect(await withVaultSessionToken(activeToken, () =>
      readDb((_db, raw) => String(raw.exec("SELECT user_name FROM settings WHERE id = 9")[0].values[0][0]))
    )).toBe("Authorized owner");
    const statusRequest = new Request("http://127.0.0.1:1313/api/vault/status");
    expect(await (await status(statusRequest)).json()).toEqual({ status: "locked" });
  });

  it("requires the same-origin mutation guard before touching activity", async () => {
    const response = await touchStatus(new Request("http://127.0.0.1:1313/api/vault/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(403);
  });
});
