import path from "node:path";

const PRIVATE_ROOTS = new Set([".agent", "backups", "data", "exports"]);
const PRIVATE_DATABASE_SUFFIX = /\.(?:bak|backup|(?:db|sqlite|sqlite3)(?:-[^/]*)?)$/i;
const PRIVATE_CREDENTIAL_NAME = /^credentials[^/]*\.json$/i;

export function normalizeTrackedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function privateTrackedPathReason(value: string): string | null {
  const file = normalizeTrackedPath(value);
  const [root = ""] = file.split("/");
  const name = path.posix.basename(file);

  if (PRIVATE_ROOTS.has(root)) return `private root ${root}/`;
  if (PRIVATE_DATABASE_SUFFIX.test(name)) return "database or backup file";
  if (name === ".env" || (name.startsWith(".env.") && !name.endsWith(".example"))) {
    return "environment file";
  }
  if (PRIVATE_CREDENTIAL_NAME.test(name)) return "credential file";
  return null;
}

export function privateTrackedPaths(paths: readonly string[]): string[] {
  return paths
    .map(normalizeTrackedPath)
    .filter((file) => privateTrackedPathReason(file) !== null)
    .sort((a, b) => a.localeCompare(b));
}

export function assertSandboxName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
    throw new Error("Sandbox name must use 1-63 lowercase letters, digits, or hyphens.");
  }
  return value;
}

export function assertSandboxTemplate(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
    throw new Error("Sandbox template must use lowercase letters, digits, or hyphens.");
  }
  return value;
}

export function sandboxRunArgs(template: string, name: string, sourcePath: string): string[] {
  return [
    "run",
    "--clone",
    "--no-share-skills",
    "--name",
    assertSandboxName(name),
    assertSandboxTemplate(template),
    sourcePath,
  ];
}
