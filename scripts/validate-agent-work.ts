import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { assertAgentGuidance } from "./validate-agent-guidance";
import {
  normalizeRepoPath,
  planValidation,
  type ValidationCommand,
} from "./validate-agent-work-logic";

type CliOptions = {
  files: string[];
  full: boolean;
  dryRun: boolean;
  staged: boolean;
  since?: string;
  help: boolean;
};

const HELP = `Validate an agent's change with path-aware checks.

Usage:
  bun run validate:agent -- <changed-file> [...changed-file]
  bun run validate:agent -- --staged
  bun run validate:agent -- --since <git-ref>
  bun run validate:agent -- --full

Options:
  --dry-run       print the selected checks without running them
  --staged        validate staged paths only
  --since <ref>   validate paths changed from ref through the working tree
  --full          run release-level checks regardless of changed paths
  -h, --help      show this help

Pass explicit paths in a dirty worktree so unrelated changes are not included.`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    files: [],
    full: false,
    dryRun: false,
    staged: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--full") options.full = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--staged") options.staged = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--since") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--since requires a git ref");
      options.since = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      options.files.push(arg);
    }
  }

  const selectors = Number(options.files.length > 0) + Number(options.staged) + Number(Boolean(options.since));
  if (selectors > 1) throw new Error("choose explicit files, --staged, or --since; do not combine them");
  return options;
}

function gitPaths(args: string[]): string[] {
  const output = execFileSync("git", args, { encoding: "buffer" });
  return output.toString("utf8").split("\0").filter(Boolean);
}

function defaultChangedPaths(): string[] {
  return [
    ...gitPaths(["diff", "--name-only", "--diff-filter=ACMRDTUXB", "-z"]),
    ...gitPaths(["diff", "--cached", "--name-only", "--diff-filter=ACMRDTUXB", "-z"]),
    ...gitPaths(["ls-files", "--others", "--exclude-standard", "-z"]),
  ];
}

function resolveFiles(options: CliOptions, repoRoot: string): string[] {
  let selected: string[];
  if (options.files.length > 0) selected = options.files;
  else if (options.staged) {
    selected = gitPaths(["diff", "--cached", "--name-only", "--diff-filter=ACMRDTUXB", "-z"]);
  } else if (options.since) {
    selected = [
      ...gitPaths(["diff", options.since, "--name-only", "--diff-filter=ACMRDTUXB", "-z"]),
      ...gitPaths(["ls-files", "--others", "--exclude-standard", "-z"]),
    ];
  } else if (options.full) selected = [];
  else selected = defaultChangedPaths();

  return [...new Set(selected.map((file) => {
    const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(repoRoot, file);
    const relative = path.relative(repoRoot, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`path is outside the repository: ${file}`);
    }
    return normalizeRepoPath(relative);
  }).filter(Boolean))].sort();
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

function displayCommand(item: ValidationCommand): string {
  const executable = item.executable === "node" ? process.execPath : item.executable;
  return [executable, ...item.args].map(quote).join(" ");
}

function runCommand(item: ValidationCommand): void {
  const executable = item.executable === "node" ? process.execPath : item.executable;
  console.log(`\n[${item.id}] ${item.reason}`);
  console.log(`$ ${displayCommand(item)}`);
  const result = spawnSync(executable, item.args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${item.id} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function main(): void {
  const repoRoot = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  const files = resolveFiles(options, repoRoot);
  if (!options.full && files.length === 0) {
    console.log("No changed paths selected; nothing to validate.");
    return;
  }

  const plan = planValidation(files, {
    full: options.full,
    exists: (file) => fs.existsSync(path.join(repoRoot, file)),
  });

  console.log("Agent validation plan");
  if (plan.files.length > 0) {
    for (const file of plan.files) console.log(`  - ${file}`);
  } else {
    console.log("  - full repository");
  }

  if (plan.validateGuidance) {
    console.log("\n[guidance] AGENTS/Claude/Cursor rule structure and scope parity");
    if (!options.dryRun) assertAgentGuidance(repoRoot);
  }
  for (const note of plan.notes) console.log(`\nNote: ${note}`);
  for (const item of plan.commands) {
    if (options.dryRun) console.log(`\n[${item.id}] ${displayCommand(item)} (${item.reason})`);
    else runCommand(item);
  }

  console.log(options.dryRun ? "\nDry run complete." : "\nAgent validation passed.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
