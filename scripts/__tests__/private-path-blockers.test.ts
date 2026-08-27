import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const GUARD_COMMAND = "sh scripts/agent-private-path-guard.sh";

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(`${ROOT}/${relativePath}`, "utf8")) as T;
}

describe("private financial path blockers", () => {
  it("keeps private financial artifacts out of the tracked tree", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    const forbidden = tracked.filter((file) =>
      /^(?:data|backups|exports|\.agent)\//.test(file) ||
      /\.(?:bak|backup|csv|db(?:-[^/]*)?|ods|ofx|qfx|qif|sqlite|sqlite3|tsv|xls|xlsx)$/.test(file) ||
      /(^|\/)credentials[^/]*\.json$/.test(file) ||
      (/(^|\/)\.env(?:\..+)?$/.test(file) && !file.endsWith(".env.example"))
    );

    expect(forbidden).toEqual([]);
  });

  it("denies Cursor CLI reads and writes to private paths", () => {
    const config = readJson<{
      permissions: { deny: string[] };
    }>(".cursor/cli.json");

    expect(config.permissions.deny).toEqual(expect.arrayContaining([
      "Read(data/**)",
      "Read(**/*.db)",
      "Read(**/*.xlsx)",
      "Write(data/**)",
      "Write(**/*.db)",
      "Write(**/*.xlsx)",
      "Shell(docker)",
      "Shell(/usr/bin/docker)",
      "Shell(sqlite3)",
    ]));

    const hooks = readJson<{
      hooks: Record<string, Array<{ command: string; failClosed?: boolean }>>;
    }>(".cursor/hooks.json");
    expect(Object.keys(hooks.hooks)).toEqual(expect.arrayContaining([
      "preToolUse",
      "beforeReadFile",
      "beforeShellExecution",
      "beforeMCPExecution",
      "beforeTabFileRead",
    ]));
    for (const entries of Object.values(hooks.hooks)) {
      expect(entries[0]?.command).toContain(GUARD_COMMAND);
      expect(entries[0]?.failClosed).toBe(true);
    }
  });

  it("enables Claude's filesystem sandbox and private path denials", () => {
    const config = readJson<{
      permissions: { deny: string[]; disableBypassPermissionsMode: string };
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
      sandbox: {
        enabled: boolean;
        failIfUnavailable: boolean;
        filesystem: { denyRead: string[]; denyWrite: string[] };
      };
    }>(".claude/settings.json");

    expect(config.permissions.disableBypassPermissionsMode).toBe("disable");
    expect(config.permissions.deny).toEqual(expect.arrayContaining([
      "Read(/data/**)",
      "Read(**/*.db)",
      "Edit(/data/**)",
      "Edit(**/*.db)",
      "Bash(docker)",
      "Bash(docker *)",
      "Bash(/usr/bin/docker *)",
      "Bash(sqlite3)",
      "Bash(sqlite3 *)",
    ]));
    expect(config.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true });
    expect(config.sandbox.filesystem.denyRead).toContain("./data");
    expect(config.sandbox.filesystem.denyWrite).toContain("./data");
    expect(config.hooks.PreToolUse[0]?.hooks[0]?.command).toContain(GUARD_COMMAND);
  });

  it("denies Codex access outside source and to private workspace paths", () => {
    const config = readFileSync(`${ROOT}/.codex/config.toml`, "utf8");

    expect(config).toContain('default_permissions = "localfi-source"');
    expect(config).toContain('[permissions.localfi-source.filesystem]');
    expect(config).toContain('":root" = "deny"');
    expect(config).toContain('[permissions.localfi-source.filesystem.":workspace_roots"]');
    expect(config).toContain('"data" = "deny"');
    expect(config).toContain('"**/*.db" = "deny"');
    expect(config).toContain('"**/*.xlsx" = "deny"');
    expect(config).toContain('[permissions.localfi-source.network]');
    expect(config).toContain("enabled = false");
    expect(config).toContain("[mcp_servers.shadcn]");
  });

  it("denies OpenCode private paths and external directories", () => {
    const config = readJson<{
      permissions: Array<{ action: string; resource: string; effect: string }>;
    }>(".opencode/opencode.json");

    expect(config.permissions).toEqual(expect.arrayContaining([
      { action: "external_directory", resource: "*", effect: "deny" },
      { action: "read", resource: "data/*", effect: "deny" },
      { action: "read", resource: "*.db", effect: "deny" },
      { action: "edit", resource: "data/*", effect: "deny" },
      { action: "edit", resource: "*.db", effect: "deny" },
      { action: "shell", resource: "docker *", effect: "deny" },
      { action: "shell", resource: "sqlite3 *", effect: "deny" },
    ]));
    expect(config.permissions.at(-1)).toEqual({ action: "shell", resource: "*", effect: "deny" });
  });

  it("installs the shared hook for Gemini and Windsurf", () => {
    const gemini = readJson<{
      hooks: { BeforeTool: Array<{ hooks: Array<{ command: string }> }> };
    }>(".gemini/settings.json");
    expect(gemini.hooks.BeforeTool[0]?.hooks[0]?.command).toContain(GUARD_COMMAND);

    const windsurf = readJson<{
      hooks: Record<string, Array<{ command: string }>>;
    }>(".windsurf/hooks.json");
    expect(Object.keys(windsurf.hooks)).toEqual(expect.arrayContaining([
      "pre_read_code",
      "pre_write_code",
      "pre_run_command",
      "pre_mcp_tool_use",
    ]));
    for (const entries of Object.values(windsurf.hooks)) {
      expect(entries[0]?.command).toContain(GUARD_COMMAND);
    }
  });

  it("installs executable Cline hooks and a Pi tool interceptor", () => {
    const clineHook = `${ROOT}/.clinerules/hooks/PreToolUse`;
    expect(statSync(clineHook).mode & 0o111).not.toBe(0);
    expect(readFileSync(clineHook, "utf8")).toContain("scripts/agent-private-path-guard.sh");
    expect(readFileSync(`${clineHook}.ps1`, "utf8")).toContain("scripts/agent-private-path-guard.mjs");

    const pi = readFileSync(`${ROOT}/.pi/extensions/private-finance-guard.ts`, "utf8");
    expect(pi).toContain('pi.on("tool_call"');
    expect(pi).toContain("evaluateAgentToolInput");
    expect(pi).toContain("block: true");
  });

  it("keeps the shared guard executable and protects every policy root from edits", () => {
    expect(statSync(`${ROOT}/scripts/agent-private-path-guard.sh`).mode & 0o111).not.toBe(0);
    const cursor = readJson<{ permissions: { deny: string[] } }>(".cursor/cli.json");
    const claude = readJson<{ permissions: { deny: string[] } }>(".claude/settings.json");
    const opencode = readJson<{
      permissions: Array<{ action: string; resource: string; effect: string }>;
    }>(".opencode/opencode.json");
    for (const root of [
      ".claude",
      ".clinerules",
      ".codex",
      ".cursor",
      ".gemini",
      ".opencode",
      ".pi",
      ".windsurf",
    ]) {
      expect(cursor.permissions.deny).toContain(`Write(${root}/**)`);
      expect(claude.permissions.deny).toContain(`Edit(${root}/**)`);
      expect(claude.permissions.deny).toContain(`Write(${root}/**)`);
      expect(opencode.permissions).toContainEqual({
        action: "edit",
        resource: `${root}/*`,
        effect: "deny",
      });
    }
    for (const file of [
      "AGENTS.md",
      "scripts/agent-private-path-guard.mjs",
      "scripts/agent-private-path-guard.sh",
    ]) {
      expect(cursor.permissions.deny).toContain(`Write(${file})`);
      expect(claude.permissions.deny).toContain(`Edit(${file})`);
      expect(claude.permissions.deny).toContain(`Write(${file})`);
      expect(opencode.permissions).toContainEqual({ action: "edit", resource: file, effect: "deny" });
    }
  });
});
