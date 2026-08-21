import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";

import { inspectVaultEnvelope, isVaultEnvelope } from "./envelope";
import { VaultPathError, VaultPermissionError } from "./errors";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwned(stat: Stats, label: string): void {
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new VaultPermissionError(`${label} is not owned by the LocalFi process user.`);
  }
}

export function ensureOwnerOnlyDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  const created = !existsSync(resolved);
  if (created) mkdirSync(resolved, { recursive: true, mode: DIRECTORY_MODE });
  const linkStat = lstatSync(resolved);
  if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) {
    throw new VaultPathError(`Vault directory is not a real directory: ${resolved}`);
  }
  assertOwned(linkStat, `Vault directory ${resolved}`);
  if (!created && (linkStat.mode & 0o077) !== 0) {
    throw new VaultPermissionError(`Vault directory is not mode 0700: ${resolved}`);
  }
  chmodSync(resolved, DIRECTORY_MODE);
  return realpathSync(resolved);
}

export function hardenLegacyVaultPathForSetup(file: string): void {
  const requested = path.resolve(file);
  const directory = path.dirname(requested);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });

  const directoryLinkStat = lstatSync(directory);
  if (directoryLinkStat.isSymbolicLink() || !directoryLinkStat.isDirectory()) {
    throw new VaultPathError(`Vault directory is not a real directory: ${directory}`);
  }
  assertOwned(directoryLinkStat, `Vault directory ${directory}`);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const directoryOnly = "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;
  const directoryDescriptor = openSync(directory, constants.O_RDONLY | noFollow | directoryOnly);
  try {
    const opened = fstatSync(directoryDescriptor);
    assertOwned(opened, `Vault directory ${directory}`);
    if (
      !opened.isDirectory() ||
      opened.dev !== directoryLinkStat.dev ||
      opened.ino !== directoryLinkStat.ino
    ) {
      throw new VaultPathError(`Vault directory changed identity while opening: ${directory}`);
    }
    fchmodSync(directoryDescriptor, DIRECTORY_MODE);
  } finally {
    closeSync(directoryDescriptor);
  }

  if (!existsSync(requested)) return;
  const fileLinkStat = lstatSync(requested);
  if (fileLinkStat.isSymbolicLink() || !fileLinkStat.isFile() || fileLinkStat.nlink !== 1) {
    throw new VaultPathError(`Legacy vault generation is not a safe regular file: ${requested}`);
  }
  assertOwned(fileLinkStat, `Legacy vault generation ${requested}`);
  const descriptor = openSync(requested, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    assertOwned(opened, `Legacy vault generation ${requested}`);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== fileLinkStat.dev ||
      opened.ino !== fileLinkStat.ino
    ) {
      throw new VaultPathError(`Legacy vault generation changed identity while opening: ${requested}`);
    }
    fchmodSync(descriptor, FILE_MODE);
  } finally {
    closeSync(descriptor);
  }
}

function assertRegularFile(file: string, requireOwnerOnly: boolean): Stats {
  const linkStat = lstatSync(file);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new VaultPathError(`Sensitive generation is not a regular file: ${file}`);
  }
  const stat = statSync(file);
  assertOwned(stat, `Sensitive generation ${file}`);
  if (stat.nlink !== 1) {
    throw new VaultPathError(`Sensitive generation has an unsafe hard-link alias: ${file}`);
  }
  if (requireOwnerOnly && (stat.mode & 0o077) !== 0) {
    throw new VaultPermissionError(`Sensitive generation is not mode 0600: ${file}`);
  }
  return stat;
}

export function readSensitiveGeneration(
  file: string,
  options: { requireOwnerOnly?: boolean } = {},
): Buffer {
  const resolved = path.resolve(file);
  assertRegularFile(resolved, options.requireOwnerOnly ?? true);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(resolved, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    assertOwned(opened, `Sensitive generation ${resolved}`);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new VaultPathError(`Sensitive generation changed identity while opening: ${resolved}`);
    }
    if ((options.requireOwnerOnly ?? true) && (opened.mode & 0o077) !== 0) {
      throw new VaultPermissionError(`Sensitive generation is not mode 0600: ${resolved}`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function readEncryptedGeneration(file: string): Promise<Buffer> {
  const bytes = readSensitiveGeneration(file);
  await inspectVaultEnvelope(bytes);
  return bytes;
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function temporaryPath(target: string, purpose: string): string {
  const suffix = randomBytes(12).toString("hex");
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${purpose}-${process.pid}-${suffix}.tmp`,
  );
}

export async function writeEncryptedGenerationAtomically(
  file: string,
  envelope: Uint8Array,
  options: {
    replace?: boolean;
    purpose?: string;
    allowLegacyPermissions?: boolean;
  } = {},
): Promise<void> {
  await inspectVaultEnvelope(envelope);
  const requested = path.resolve(file);
  const directory = ensureOwnerOnlyDirectory(path.dirname(requested));
  const target = path.join(directory, path.basename(requested));
  if (existsSync(target)) {
    assertRegularFile(target, !(options.allowLegacyPermissions ?? false));
    if (options.replace === false) throw new VaultPathError(`Vault target already exists: ${target}`);
  }
  const temporary = temporaryPath(target, options.purpose ?? "persist");
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      FILE_MODE,
    );
    try {
      writeSync(descriptor, envelope, 0, envelope.byteLength, 0);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temporary, FILE_MODE);
    renameSync(temporary, target);
    fsyncDirectory(directory);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {

    }
    throw error;
  }
}

export async function copyEncryptedGenerationAtomically(
  source: string,
  target: string,
): Promise<void> {
  const bytes = await readEncryptedGeneration(source);
  await writeEncryptedGenerationAtomically(target, bytes, {
    replace: true,
    purpose: "backup",
  });
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function managedVaultGenerationPaths(dbPath: string): string[] {
  const live = path.resolve(dbPath);
  const paths = [live];
  const automaticBackup = `${live}.bak`;
  if (existsSync(automaticBackup)) paths.push(automaticBackup);
  const backupDirectory = path.join(path.dirname(live), "backups");
  if (existsSync(backupDirectory)) {
    const directoryStat = lstatSync(backupDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new VaultPathError(`Managed backup path is not a real directory: ${backupDirectory}`);
    }
    assertOwned(directoryStat, `Managed backup directory ${backupDirectory}`);
    const base = path.basename(live, path.extname(live));
    const pattern = new RegExp(`^${escaped(base)}\\..+\\.db$`);
    for (const entry of readdirSync(backupDirectory).sort()) {
      if (pattern.test(entry)) paths.push(path.join(backupDirectory, entry));
    }
  }
  const identities = new Set<string>();
  for (const candidate of paths.filter(existsSync)) {
    const stat = assertRegularFile(candidate, false);
    const identity = `${stat.dev}:${stat.ino}`;
    if (identities.has(identity)) {
      throw new VaultPathError("Managed vault generations contain a hard-link alias.");
    }
    identities.add(identity);
  }
  return paths;
}

export function assertNoPlaintextTemporaryGenerations(directory: string): void {
  const resolved = path.resolve(directory);
  if (!existsSync(resolved)) return;
  for (const entry of readdirSync(resolved)) {
    if (!entry.startsWith(".") || !entry.endsWith(".tmp")) continue;
    const file = path.join(resolved, entry);
    const bytes = readSensitiveGeneration(file, { requireOwnerOnly: false });
    if (!isVaultEnvelope(bytes)) {
      throw new VaultPathError(`Unencrypted vault temporary generation detected: ${file}`);
    }
  }
}
