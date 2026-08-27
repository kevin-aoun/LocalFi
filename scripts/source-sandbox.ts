/** Launch a Docker Sandbox from committed source without mounting the owner checkout. */
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  assertSandboxName,
  assertSandboxTemplate,
  privateTrackedPaths,
  sandboxRunArgs,
} from "./source-sandbox-logic";

function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? result.stderr.trim() : "";
    throw new Error(`${command} failed with exit ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return capture ? result.stdout.trim() : "";
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

type Options = { check: boolean; name: string; template: string };

function parseOptions(argv: readonly string[]): Options {
  let check = false;
  let name = `localfi-${Date.now()}`;
  let template = "codex";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
    } else if (argument === "--name") {
      const value = argv[index + 1];
      if (!value) throw new Error("--name requires a value");
      name = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      template = argument;
    }
  }

  return {
    check,
    name: assertSandboxName(name),
    template: assertSandboxTemplate(template),
  };
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const repoRoot = realpathSync(run("git", ["rev-parse", "--show-toplevel"], true));
  const status = run("git", ["status", "--porcelain", "--untracked-files=all"], true);
  if (status !== "") {
    throw new Error("Commit or stash source changes before creating a source-only sandbox.");
  }

  const tracked = run("git", ["ls-tree", "-r", "--name-only", "HEAD"], true)
    .split("\n")
    .filter(Boolean);
  const privateFiles = privateTrackedPaths(tracked);
  if (privateFiles.length > 0) {
    throw new Error(`Refusing tracked private files:\n${privateFiles.join("\n")}`);
  }
  if (!commandExists("sbx")) {
    throw new Error("Docker Sandboxes is not installed. See https://docs.docker.com/ai/sandboxes/install/");
  }

  if (options.check) {
    console.log("Source-only sandbox prerequisites passed.");
    return;
  }

  const stateBase = process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state");
  const sourcesRoot = path.resolve(stateBase, "localfi", "sandbox-sources");
  mkdirSync(sourcesRoot, { recursive: true, mode: 0o700 });
  chmodSync(sourcesRoot, 0o700);

  const sourcePath = path.join(sourcesRoot, options.name);
  if (existsSync(sourcePath)) {
    throw new Error(`Sandbox source already exists: ${sourcePath}`);
  }

  run("git", [
    "clone",
    "--no-local",
    "--no-hardlinks",
    "--depth",
    "1",
    "--single-branch",
    repoRoot,
    sourcePath,
  ]);
  chmodSync(sourcePath, 0o700);
  run("git", ["-C", sourcePath, "remote", "remove", "origin"]);

  console.log(`Starting ${options.name} from tracked source only: ${sourcePath}`);
  console.log("No owner database, export, backup, environment file, or host Docker socket is mounted.");
  run("sbx", sandboxRunArgs(options.template, options.name, sourcePath));
}

try {
  main();
} catch (error) {
  console.error(`source-sandbox: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
