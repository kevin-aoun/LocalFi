import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateAgentToolInput } from "../agent-private-path-guard.mjs";

const ROOT = process.cwd();

describe("agent private-path guard", () => {
  it.each([
    { tool_name: "Read", tool_input: { file_path: "data/budget.db" }, cwd: ROOT },
    { tool_name: "read_file", tool_input: { path: `${ROOT}/backups/budget.db.bak` }, cwd: ROOT },
    { tool_name: "Shell", tool_input: { command: "cat data/budget.db" }, cwd: ROOT },
    { tool_name: "Bash", tool_input: { command: "sqlite3 anything" }, cwd: ROOT },
    { agent_action_name: "pre_run_command", tool_info: { command_line: "docker compose exec app sh" }, cwd: ROOT },
    { hook_event_name: "preToolUse", tool_name: "Write", tool_input: { path: ".cursor/hooks.json" }, cwd: ROOT },
    { toolName: "write_file", tool_input: { path: "scripts/agent-private-path-guard.mjs" }, cwd: ROOT },
    { tool_name: "Shell", tool_input: { command: "./setup.sh" }, cwd: ROOT },
    { tool_name: "mcp_filesystem_read", tool_input: { arbitrary: "exports/owner.csv" }, cwd: ROOT },
  ])("blocks a private target %#", (input) => {
    expect(evaluateAgentToolInput(input, ROOT).allowed).toBe(false);
  });

  it.each([
    { tool_name: "Read", tool_input: { file_path: "lib/db/client.ts" }, cwd: ROOT },
    { tool_name: "Read", tool_input: { file_path: "components/exports/export-disclosure.tsx" }, cwd: ROOT },
    { tool_name: "Shell", tool_input: { command: "bun test components/vault" }, cwd: ROOT },
    { tool_name: "Read", tool_input: { file_path: ".env.example" }, cwd: ROOT },
    { tool_name: "Read", tool_input: { file_path: ".claude/settings.json" }, cwd: ROOT },
  ])("allows a source-only target %#", (input) => {
    expect(evaluateAgentToolInput(input, ROOT)).toEqual({ allowed: true });
  });

  it("uses each harness's documented blocking protocol", () => {
    const script = path.join(ROOT, "scripts/agent-private-path-guard.mjs");
    const input = JSON.stringify({ tool_name: "Read", tool_input: { path: "data/budget.db" }, cwd: ROOT });

    for (const mode of ["claude", "gemini", "windsurf"]) {
      const result = spawnSync(process.execPath, [script, mode], { input, encoding: "utf8" });
      expect(result.status, mode).toBe(2);
      expect(result.stderr, mode).toMatch(/Blocked by LocalFi/);
    }
    const cursor = spawnSync(process.execPath, [script, "cursor"], { input, encoding: "utf8" });
    expect(JSON.parse(cursor.stdout)).toMatchObject({ permission: "deny" });
    const cline = spawnSync(process.execPath, [script, "cline"], { input, encoding: "utf8" });
    expect(JSON.parse(cline.stdout)).toMatchObject({ cancel: true });
  });

  it("finds the guard from outside the repository and fails closed on invalid input", () => {
    const wrapper = path.join(ROOT, "scripts/agent-private-path-guard.sh");
    const blocked = spawnSync("sh", [wrapper, "generic"], {
      cwd: os.tmpdir(),
      input: JSON.stringify({ toolName: "read_file", tool_input: { path: "data/owner.db" } }),
      encoding: "utf8",
    });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/Blocked by LocalFi/);

    const invalid = spawnSync("sh", [wrapper, "generic"], {
      cwd: os.tmpdir(),
      input: "not-json",
      encoding: "utf8",
    });
    expect(invalid.status).toBe(2);
  });
});
