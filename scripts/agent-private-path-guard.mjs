#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const PRIVATE_ROOTS = new Set([".agent", "backups", "data", "exports"]);
const POLICY_ROOTS = new Set([
  ".claude",
  ".clinerules",
  ".codex",
  ".cursor",
  ".gemini",
  ".opencode",
  ".pi",
  ".windsurf",
]);
const POLICY_FILES = new Set([
  "AGENTS.md",
  "scripts/agent-private-path-guard.mjs",
  "scripts/agent-private-path-guard.sh",
]);
const PRIVATE_SUFFIX = /\.(?:bak|backup|csv|db(?:-[^/\s"'`;,|&<>]+)?|ods|ofx|qfx|qif|sqlite|sqlite3|tsv|xls|xlsx)$/i;
const PATH_KEYS = /^(?:command|commandline|cwd|directory|file|filepath|glob|globpattern|path|pattern|query|target|targetfile)$/;

function normalizedKey(value) {
  return value.replaceAll("_", "").replaceAll("-", "").toLowerCase();
}

function normalizedPath(value) {
  return value.replaceAll("\\", "/").replace(/^file:\/\//i, "");
}

function credentialLike(name) {
  return /^credentials[^/]*\.json$/i.test(name) ||
    (name.startsWith(".env") && name !== ".env.example");
}

function pathReason(value, cwd, protectPolicy) {
  const candidate = normalizedPath(value.trim());
  if (!candidate) return null;
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  const relative = normalizedPath(path.relative(cwd, absolute));
  const insideWorkspace = relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
  const parts = relative.split("/").filter(Boolean);
  const root = insideWorkspace ? parts[0] ?? "" : "";
  const name = parts.at(-1) ?? path.posix.basename(candidate);

  if (PRIVATE_ROOTS.has(root)) return "owner financial storage";
  if (protectPolicy && (POLICY_ROOTS.has(root) || POLICY_FILES.has(relative))) {
    return "repository safety policy";
  }
  if (PRIVATE_SUFFIX.test(name)) return "database, backup, or financial export";
  if (credentialLike(name)) return "credential or environment file";
  return null;
}

function commandReason(command, cwd) {
  const value = normalizedPath(command);
  const escapedCwd = normalizedPath(cwd).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const privateRoot = "(?:data|backups|exports|\\.agent)";
  const policyRoot = "(?:\\.claude|\\.clinerules|\\.codex|\\.cursor|\\.gemini|\\.opencode|\\.pi|\\.windsurf)";
  const policyFile = "(?:AGENTS\\.md|scripts/agent-private-path-guard\\.(?:mjs|sh))";
  const boundary = "(?:^|[\\s\\\"'`=,;|&<>(])";

  if (new RegExp(`${boundary}(?:\\./|\\$PWD/|\\$\\{PWD\\}/)?${privateRoot}(?:/|$)`, "i").test(value) ||
      new RegExp(`${escapedCwd}/${privateRoot}(?:/|$)`, "i").test(value)) {
    return "owner financial storage";
  }
  if (new RegExp(`${boundary}(?:\\./|\\$PWD/|\\$\\{PWD\\}/)?${policyRoot}(?:/|$)`, "i").test(value) ||
      new RegExp(`${escapedCwd}/${policyRoot}(?:/|$)`, "i").test(value) ||
      new RegExp(`${boundary}(?:\\./|\\$PWD/|\\$\\{PWD\\}/)?${policyFile}(?=$|[\\s\"'=,;|&<>])`, "i").test(value) ||
      new RegExp(`${escapedCwd}/${policyFile}(?=$|[\\s\"'=,;|&<>])`, "i").test(value)) {
    return "repository safety policy";
  }
  if (/\.(?:bak|backup|csv|db(?:-[^/\s"'`;,|&<>]+)?|ods|ofx|qfx|qif|sqlite|sqlite3|tsv|xls|xlsx)(?=$|[\s"'`=,;|&<>])/i.test(value)) {
    return "database, backup, or financial export";
  }
  if (/(?:^|[\s;&|])(?:sudo\s+)?(?:\/[\w.-]+\/)*(?:docker|podman|sqlite3)(?=\s|$)/i.test(value)) {
    return "database-capable host command";
  }
  if (/(?:^|[\s"'`=,;|&<>])(?:\.env(?:\.[^\s/"'`;,|&<>]+)?|credentials[^\s/"'`;,|&<>]*\.json)(?=$|[\s"'`=,;|&<>])/i.test(value) &&
      !/(?:^|[\s"'`=,;|&<>])\.env\.example(?=$|[\s"'`=,;|&<>])/i.test(value)) {
    return "credential or environment file";
  }
  return null;
}

function descriptor(input) {
  return [
    input?.hook_event_name,
    input?.agent_action_name,
    input?.tool_name,
    input?.toolName,
    input?.tool,
    input?.preToolUse?.tool,
  ].filter((value) => typeof value === "string").join(" ");
}

function collectTargets(value, targets, scanAll = false, key = "") {
  if (typeof value === "string") {
    if (scanAll || PATH_KEYS.test(normalizedKey(key))) targets.push({ key, value });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTargets(item, targets, scanAll, key);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value)) {
    collectTargets(child, targets, scanAll, childKey);
  }
}

export function evaluateAgentToolInput(input, fallbackCwd = process.cwd()) {
  if (!input || typeof input !== "object") {
    return { allowed: false, reason: "invalid hook input" };
  }
  const cwd = typeof input.cwd === "string" ? input.cwd : fallbackCwd;
  const description = descriptor(input);
  const shellLike = /bash|command|shell|run_command/i.test(description);
  const writeLike = shellLike || /delete|edit|move|patch|remove|rename|write/i.test(description);
  const mcpLike = /mcp/i.test(description);
  const targets = [];
  collectTargets(input, targets, mcpLike);

  for (const target of targets) {
    const reason = /command/i.test(normalizedKey(target.key))
      ? commandReason(target.value, cwd)
      : pathReason(target.value, cwd, writeLike);
    if (reason) return { allowed: false, reason };
  }
  return { allowed: true };
}

function allow(mode) {
  if (mode === "cursor") process.stdout.write('{"permission":"allow"}\n');
  else if (mode === "cline") process.stdout.write('{"cancel":false}\n');
  else process.stdout.write("{}\n");
}

function deny(mode, reason) {
  const message = `Blocked by LocalFi: ${reason} is outside the agent source boundary.`;
  if (mode === "cursor") {
    process.stdout.write(`${JSON.stringify({ permission: "deny", user_message: message, agent_message: message })}\n`);
    return;
  }
  if (mode === "cline") {
    process.stdout.write(`${JSON.stringify({ cancel: true, errorMessage: message })}\n`);
    return;
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

async function main() {
  const mode = process.argv[2] ?? "generic";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try {
    const result = evaluateAgentToolInput(JSON.parse(input));
    if (result.allowed) allow(mode);
    else deny(mode, result.reason);
  } catch {
    deny(mode, "unparseable hook input");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
