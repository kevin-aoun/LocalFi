import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import { closeDb, withDb } from "../lib/db/client";
import {
  populateDemoDataWithin,
  type DemoDataSummary,
} from "../lib/db/demo-data";

const DEFAULT_OWNER_DB = path.resolve(process.cwd(), "data", "budget.db");

export class DemoDatabasePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoDatabasePathError";
  }
}

export type CreateDemoDatabaseOptions = {
  outputPath: string;
  replace?: boolean;
};

export type DemoDatabaseResult = DemoDataSummary & {
  outputPath: string;
  bytes: number;
};

type ProtectedTarget = {
  canonicalPath: string;
  identity: string | null;
};

function configuredOwnerDbPath(): string | null {
  const configured = process.env.BUDGET_DB_PATH?.trim();
  return configured ? path.resolve(process.cwd(), configured) : null;
}

function canonicalProspectivePath(file: string): string {
  let cursor = path.resolve(file);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(realpathSync.native(cursor), ...missing);
}

function existingIdentity(file: string): string | null {
  if (!existsSync(file)) return null;
  const stats = statSync(file, { bigint: true });
  return `${stats.dev}:${stats.ino}`;
}

function protectedOwnerTargets(): ProtectedTarget[] {
  const owners = [DEFAULT_OWNER_DB, configuredOwnerDbPath()].filter(
    (candidate): candidate is string => candidate !== null,
  );
  const paths = new Set<string>();
  for (const owner of owners) {
    paths.add(path.resolve(owner));
    paths.add(path.resolve(`${owner}.bak`));
    const canonicalOwner = canonicalProspectivePath(owner);
    paths.add(canonicalOwner);
    paths.add(path.resolve(`${canonicalOwner}.bak`));
  }
  return [...paths].map((candidate) => ({
    canonicalPath: canonicalProspectivePath(candidate),
    identity: existingIdentity(candidate),
  }));
}

function assertRegularReplaceableFile(file: string, label: string): void {
  const stats = lstatSync(file);
  if (stats.isSymbolicLink()) {
    throw new DemoDatabasePathError(`Refusing to replace ${label} because it is a symbolic link: ${file}`);
  }
  if (!stats.isFile()) {
    throw new DemoDatabasePathError(`Refusing to replace ${label} because it is not a regular file: ${file}`);
  }
}

function assertNoSymlinkedOutputAncestor(output: string): void {
  let existingAncestor = path.dirname(output);
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  if (realpathSync(existingAncestor) !== existingAncestor) {
    throw new DemoDatabasePathError(
      `Refusing a demo output beneath a symbolic-link directory: ${output}`,
    );
  }
}

export function resolveSafeDemoOutput(
  outputPath: string,
  options: { replace?: boolean } = {},
): string {
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new DemoDatabasePathError("An explicit --output path is required for the demo database");
  }
  if (outputPath.includes("\0")) {
    throw new DemoDatabasePathError("The demo database output path contains an invalid null byte");
  }
  const output = path.resolve(process.cwd(), outputPath.trim());
  assertSafeResolvedDemoOutput(output, options, protectedOwnerTargets());
  return output;
}

function assertSafeResolvedDemoOutput(
  output: string,
  options: { replace?: boolean },
  protectedTargets: readonly ProtectedTarget[],
): void {
  const aliasesProtectedTarget = [output, `${output}.bak`].some((candidate) => {
    const canonical = canonicalProspectivePath(candidate);
    const identity = existingIdentity(candidate);
    return protectedTargets.some((protectedTarget) =>
      protectedTarget.canonicalPath === canonical ||
      identity !== null && protectedTarget.identity === identity
    );
  });
  if (aliasesProtectedTarget) {
    throw new DemoDatabasePathError(
      `Refusing to use LocalFi's owner/default database as a demo target: ${output}`,
    );
  }
  assertNoSymlinkedOutputAncestor(output);

  const writerLock = `${output}.writer.lock`;
  if (existsSync(writerLock)) {
    throw new DemoDatabasePathError(
      `Refusing to create a demo while a writer lease exists for the requested target: ${writerLock}`,
    );
  }
  if (existsSync(output)) {
    if (!options.replace) {
      throw new DemoDatabasePathError(
        `Refusing to overwrite existing demo target ${output}; pass --replace only for a disposable demo file`,
      );
    }
    assertRegularReplaceableFile(output, "demo target");
  }
  const backup = `${output}.bak`;
  if (existsSync(backup)) {
    if (!options.replace) {
      throw new DemoDatabasePathError(
        `Refusing to overwrite the existing companion backup ${backup}; choose another output or pass --replace`,
      );
    }
    assertRegularReplaceableFile(backup, "demo companion backup");
  }
}

function removePreparedOutput(
  output: string,
  protectedTargets: readonly ProtectedTarget[],
): void {
  assertSafeResolvedDemoOutput(output, { replace: true }, protectedTargets);
  for (const file of [output, `${output}.bak`]) {
    if (existsSync(file)) unlinkSync(file);
  }
}

function reservePreparedOutput(output: string): void {
  try {
    const descriptor = openSync(output, "wx", 0o600);
    closeSync(descriptor);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DemoDatabasePathError(
      `Could not exclusively reserve demo output ${output}; choose another path or retry. (${detail})`,
    );
  }
}

async function createDemoDatabaseInCliProcess(
  options: CreateDemoDatabaseOptions,
): Promise<DemoDatabaseResult> {
  const protectedTargets = protectedOwnerTargets();
  const output = resolveSafeDemoOutput(options.outputPath, { replace: options.replace });
  const previousDbPath = process.env.BUDGET_DB_PATH;
  const previousTimeZone = process.env.TZ;
  let ownsOutput = false;
  process.env.TZ = "UTC";
  await closeDb();
  try {
    mkdirSync(path.dirname(output), { recursive: true });
    assertSafeResolvedDemoOutput(output, { replace: options.replace }, protectedTargets);
    if (options.replace) removePreparedOutput(output, protectedTargets);
    reservePreparedOutput(output);
    ownsOutput = true;
    assertSafeResolvedDemoOutput(output, { replace: true }, protectedTargets);
    process.env.BUDGET_DB_PATH = output;
    const summary = await withDb((db, raw) => populateDemoDataWithin(db, raw));
    await closeDb();
    assertSafeResolvedDemoOutput(output, { replace: true }, protectedTargets);
    const bytes = statSync(output).size;
    const generatedBackup = `${output}.bak`;
    if (existsSync(generatedBackup)) unlinkSync(generatedBackup);
    return { ...summary, outputPath: output, bytes };
  } catch (error) {
    await closeDb().catch(() => undefined);
    if (ownsOutput) {
      try {
        removePreparedOutput(output, protectedTargets);
      } catch {
        // Fail closed if the path changed identity while generation was running.
      }
    }
    throw error;
  } finally {
    if (previousDbPath === undefined) delete process.env.BUDGET_DB_PATH;
    else process.env.BUDGET_DB_PATH = previousDbPath;
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
}

export function parseCreateDemoArgs(args: readonly string[]):
  | { help: true }
  | { help: false; options: CreateDemoDatabaseOptions } {
  let outputPath: string | null = null;
  let replace = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--replace") {
      replace = true;
      continue;
    }
    if (argument === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new DemoDatabasePathError("--output requires an explicit path");
      }
      if (outputPath !== null) throw new DemoDatabasePathError("--output may be supplied only once");
      outputPath = value;
      index += 1;
      continue;
    }
    throw new DemoDatabasePathError(`Unknown demo database argument: ${argument}`);
  }
  if (outputPath === null) {
    throw new DemoDatabasePathError("An explicit --output path is required for the demo database");
  }
  return { help: false, options: { outputPath, replace } };
}

const usage = `Create a deterministic LocalFi showcase database.

Usage:
  bun run db:demo -- --output /absolute/path/localfi-demo.db [--replace]

The command refuses LocalFi's default/configured owner database and refuses existing targets
unless --replace is explicitly supplied.`;

async function main(): Promise<void> {
  const parsed = parseCreateDemoArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage);
    return;
  }
  const result = await createDemoDatabaseInCliProcess(parsed.options);
  console.log(JSON.stringify(result, null, 2));
}

if (/\bcreate-demo-db\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
