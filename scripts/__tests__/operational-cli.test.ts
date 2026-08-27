import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("operational CLI boundaries", () => {
  it("refuses advertised headless owner-vault setup with a nonzero exit", () => {
    const packageJson = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["db:init"]).toContain("refuse-headless-vault-setup.ts");
    expect(packageJson.scripts["db:setup"]).toContain("refuse-headless-vault-setup.ts");
    expect(packageJson.scripts["db:push"]).toBeUndefined();
    expect(packageJson.scripts["db:studio"]).toBeUndefined();

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", path.join(ROOT, "scripts/refuse-headless-vault-setup.ts")],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/browser UI/i);
    expect(result.stderr).toMatch(/recovery secret/i);
  });

  it("wraps every advertised direct database caller in headless authorization cleanup", () => {
    for (const file of ["lib/db/seed.ts", "lib/db/sample-data.ts"]) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(source).toContain("authorizeDatabaseVaultFromEnvironment");
      expect(source).toMatch(/finally\s*{[\s\S]*await releaseAuthorization\(\)/);
    }
  });

  it("keeps Compose permission preparation separate from the non-root app", () => {
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    expect(compose).toMatch(/data-permissions:[\s\S]*user: "0:0"/);
    expect(compose).toMatch(/requires_bootstrap[\s\S]*token_length[\s\S]*-lt 24[\s\S]*-gt 512/);
    expect(compose).toMatch(/budget\.db must not be a symbolic link[\s\S]*stat -c %h/);
    expect(compose).toContain("http://localhost:1313/vault#setup=$$LOCALFI_VAULT_BOOTSTRAP_TOKEN");
    expect(compose).toMatch(/hardlink_marker[\s\S]*stat -c %h[\s\S]*links.*!= 1/);
    expect(compose.indexOf("hardlink_marker")).toBeLessThan(compose.indexOf("-exec chown"));
    expect(compose).toMatch(/find \/app\/data[\s\S]*chmod 0700/);
    expect(compose).toMatch(/find \/app\/data[\s\S]*chmod 0600/);
    expect(compose).toMatch(/app:[\s\S]*condition: service_completed_successfully/);
    expect(compose).toContain('user: "${DOCKER_UID:-1000}:${DOCKER_GID:-1000}"');
    expect(compose.match(/LOCALFI_VAULT_BOOTSTRAP_TOKEN=/g)).toHaveLength(2);
    expect(compose).not.toContain("LOCALFI_VAULT_BOOTSTRAP_TOKEN_FILE");
    expect(compose).not.toMatch(/\bneedle:/);
  });

  it("creates an owner-only Docker environment and prints the next steps", () => {
    expect(lstatSync(path.join(ROOT, "setup.sh")).mode & 0o111).not.toBe(0);
    const directory = mkdtempSync(path.join(os.tmpdir(), "localfi-setup-script-"));
    try {
      const script = path.join(directory, "setup.sh");
      const envFile = path.join(directory, ".env");
      writeFileSync(script, readFileSync(path.join(ROOT, "setup.sh")), { mode: 0o755 });

      const result = spawnSync("sh", [script], { cwd: directory, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("docker compose up --build");
      expect(result.stdout).toContain("docker compose logs data-permissions");

      const contents = readFileSync(envFile, "utf8");
      const matches = contents.match(/^LOCALFI_VAULT_BOOTSTRAP_TOKEN=([0-9a-f]{64})$/gm);
      expect(matches).toHaveLength(1);
      expect(lstatSync(envFile).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("updates only the bootstrap token in an existing environment", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "localfi-setup-existing-"));
    try {
      const script = path.join(directory, "setup.sh");
      const envFile = path.join(directory, ".env");
      writeFileSync(script, readFileSync(path.join(ROOT, "setup.sh")), { mode: 0o755 });
      writeFileSync(envFile, "SNAPSHOT_API_TOKEN=keep-me\nLOCALFI_VAULT_BOOTSTRAP_TOKEN=old\n", {
        mode: 0o600,
      });

      expect(spawnSync("sh", [script], { cwd: directory }).status).toBe(0);
      const contents = readFileSync(envFile, "utf8");
      expect(contents).toContain("SNAPSHOT_API_TOKEN=keep-me");
      expect(contents.match(/^LOCALFI_VAULT_BOOTSTRAP_TOKEN=([0-9a-f]{64})$/gm)).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to replace an environment-file symlink", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "localfi-setup-symlink-"));
    try {
      const script = path.join(directory, "setup.sh");
      const target = path.join(directory, "target");
      writeFileSync(script, readFileSync(path.join(ROOT, "setup.sh")), { mode: 0o755 });
      writeFileSync(target, "unchanged\n", { mode: 0o600 });
      symlinkSync(target, path.join(directory, ".env"));

      const result = spawnSync("sh", [script], { cwd: directory, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/must be a regular file/i);
      expect(readFileSync(target, "utf8")).toBe("unchanged\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
