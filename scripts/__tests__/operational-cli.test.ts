import { readFileSync } from "node:fs";
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
    for (const file of [
      "scripts/agent-cli.ts",
      "lib/db/seed.ts",
      "lib/db/sample-data.ts",
    ]) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(source).toContain("authorizeDatabaseVaultFromEnvironment");
      expect(source).toMatch(/finally\s*{[\s\S]*await releaseAuthorization\(\)/);
    }
  });

  it("keeps Compose permission preparation separate from the non-root app", () => {
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    expect(compose).toMatch(/data-permissions:[\s\S]*user: "0:0"/);
    expect(compose).toMatch(/requires_bootstrap[\s\S]*LOCALFI_VAULT_BOOTSTRAP_TOKEN/);
    expect(compose).toMatch(/token_length[\s\S]*-lt 24[\s\S]*-gt 512/);
    expect(compose).toMatch(/hardlink_marker[\s\S]*stat -c %h[\s\S]*links.*!= 1/);
    expect(compose.indexOf("hardlink_marker")).toBeLessThan(compose.indexOf("-exec chown"));
    expect(compose).toMatch(/find \/app\/data[\s\S]*chmod 0700/);
    expect(compose).toMatch(/find \/app\/data[\s\S]*chmod 0600/);
    expect(compose).toMatch(/app:[\s\S]*condition: service_completed_successfully/);
    expect(compose).toContain('user: "${DOCKER_UID:-1000}:${DOCKER_GID:-1000}"');
    expect(compose.match(/LOCALFI_VAULT_BOOTSTRAP_TOKEN=/g)).toHaveLength(2);
  });
});
