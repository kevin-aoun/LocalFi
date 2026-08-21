import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import initSqlJs, { type Database } from "sql.js";

import {
  createVaultEnvelope,
  decryptVaultGeneration,
  destroyVaultKey,
  encryptVaultGeneration,
  isLegacySqliteImage,
  isVaultEnvelope,
  type UnlockedVaultKey,
  unlockVaultEnvelope,
} from "../vault/envelope";
import { VaultLegacyMigrationError, VaultUninitializedError } from "../vault/errors";
import {
  hardenLegacyVaultPathForSetup,
  managedVaultGenerationPaths,
  readSensitiveGeneration,
  writeEncryptedGenerationAtomically,
} from "../vault/paths";
import { assertPlaintextFixturePath, resolveDbPath } from "./client";
import { upgradeDatabaseImage } from "./upgrade";
import { acquireWriterLease } from "./writer-lease";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle", "migrations");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta", "_journal.json");

type JournalEntry = { idx: number; tag: string };

const DEFAULT_CATEGORIES = [
  ["Salary", "Income", null, "Wallet", "#10b981"],
  ["Allowance", "Income", null, "Coins", "#34d399"],
  ["Rent", "Expense", null, "Home", "#ef4444"],
  ["Groceries", "Expense", 10_000, "ShoppingCart", "#f59e0b"],
  ["Dining", "Expense", 7_000, "UtensilsCrossed", "#f97316"],
  ["Transport", "Expense", 3_000, "Car", "#8b5cf6"],
  ["Utilities", "Expense", 20_000, "Zap", "#06b6d4"],
  ["Entertainment", "Expense", 10_000, "Film", "#ec4899"],
  ["Shopping", "Expense", 30_000, "ShoppingBag", "#a855f7"],
  ["Healthcare", "Expense", null, "Heart", "#f43f5e"],
  ["Personal Development", "Expense", 20_000, "BookOpen", "#3b82f6"],
  ["Subscriptions", "Expense", 4_000, "CreditCard", "#6366f1"],
  ["Travel", "Expense", null, "Plane", "#14b8a6"],
  ["Savings", "Investment", 10_000, "PiggyBank", "#22c55e"],
  ["Startups", "Investment", 10_000, "Rocket", "#0ea5e9"],
] as const;

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function sqlRuntime() {
  SQL ??= await initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules/sql.js/dist", file),
  });
  return SQL;
}

export function resolveInitDbPath(): string {
  return resolveDbPath();
}

function assertHealthy(db: Database, label: string): void {
  const integrity = db.exec("PRAGMA integrity_check")[0]?.values ?? [];
  if (integrity.length !== 1 || String(integrity[0]?.[0]).toLowerCase() !== "ok") {
    throw new VaultLegacyMigrationError(`${label} failed SQLite integrity_check.`);
  }
  const foreignKeys = db.exec("PRAGMA foreign_key_check")[0]?.values ?? [];
  if (foreignKeys.length > 0) {
    throw new VaultLegacyMigrationError(`${label} failed SQLite foreign_key_check.`);
  }
}

async function validateSqliteImage(image: Uint8Array, label: string): Promise<void> {
  if (!isLegacySqliteImage(image)) {
    throw new VaultLegacyMigrationError(`${label} is not a SQLite database.`);
  }
  const runtime = await sqlRuntime();
  let db: Database | null = null;
  try {
    db = new runtime.Database(image);
    db.run("PRAGMA foreign_keys = ON");
    assertHealthy(db, label);
  } catch (error) {
    if (error instanceof VaultLegacyMigrationError) throw error;
    throw new VaultLegacyMigrationError(`${label} could not be verified.`, { cause: error });
  } finally {
    db?.close();
  }
}

export async function buildInitialDatabaseImage(): Promise<Uint8Array> {
  const upgraded = await upgradeDatabaseImage();
  const runtime = await sqlRuntime();
  const db = new runtime.Database(upgraded.image);
  try {
    db.run("PRAGMA foreign_keys = ON");
    for (const [index, category] of DEFAULT_CATEGORIES.entries()) {
      db.run(
        `INSERT INTO categories
          (name, type, monthly_limit_cents, display_order, icon, color)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
        [category[0], category[1], category[2], index, category[3], category[4]],
      );
    }
    assertHealthy(db, "Initial database");
    return Uint8Array.from(db.export());
  } finally {
    db.close();
    upgraded.image.fill(0);
  }
}

type SetupPlaintext = { path: string; image: Uint8Array; live: boolean };

export type SetupVaultDatabaseResult = {
  dbPath: string;
  recoverySecret: string;
  key: UnlockedVaultKey;
  created: boolean;
  convertedLegacy: boolean;
  generations: string[];
};

function preVaultBackupPath(dbPath: string): string {
  const directory = path.join(path.dirname(dbPath), "backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.basename(dbPath, path.extname(dbPath));
  return path.join(directory, `${base}.${stamp}.${process.pid}.pre-vault.db`);
}

export async function setupVaultDatabase(options: {
  passphrase: string;
  dbPath?: string;
}): Promise<SetupVaultDatabaseResult> {
  const dbPath = path.resolve(options.dbPath ?? resolveInitDbPath());
  hardenLegacyVaultPathForSetup(dbPath);
  const lease = await acquireWriterLease(dbPath);
  const plaintexts: SetupPlaintext[] = [];
  let key: UnlockedVaultKey | null = null;
  try {
    const generationPaths = managedVaultGenerationPaths(dbPath);
    const liveExists = existsSync(dbPath);
    if (!liveExists && generationPaths.some((candidate) => candidate !== dbPath)) {
      throw new VaultUninitializedError("Managed backups exist without a live database generation.");
    }
    if (liveExists && isVaultEnvelope(readSensitiveGeneration(dbPath))) {
      throw new VaultUninitializedError("The LocalFi vault has already been initialized.");
    }

    if (!liveExists) {
      plaintexts.push({ path: dbPath, image: await buildInitialDatabaseImage(), live: true });
    } else {
      for (const generationPath of generationPaths) {
        if (!existsSync(generationPath)) continue;
        const stored = readSensitiveGeneration(generationPath);
        if (isVaultEnvelope(stored)) {
          const unlocked = await unlockVaultEnvelope(stored, options.passphrase);
          destroyVaultKey(unlocked.key);
          await validateSqliteImage(unlocked.plaintext, `Vault generation ${generationPath}`);
          plaintexts.push({
            path: generationPath,
            image: unlocked.plaintext,
            live: generationPath === dbPath,
          });
        } else if (isLegacySqliteImage(stored)) {
          await validateSqliteImage(stored, `Legacy generation ${generationPath}`);
          plaintexts.push({
            path: generationPath,
            image: Uint8Array.from(stored),
            live: generationPath === dbPath,
          });
        } else {
          throw new VaultLegacyMigrationError(
            `Managed generation has an unknown or corrupt format: ${generationPath}`,
          );
        }
      }
      const live = plaintexts.find((generation) => generation.live);
      if (!live) throw new VaultUninitializedError();
      const upgraded = await upgradeDatabaseImage(live.image);
      live.image.fill(0);
      live.image = upgraded.image;
    }

    const live = plaintexts.find((generation) => generation.live);
    if (!live) throw new VaultUninitializedError();
    const created = await createVaultEnvelope(live.image, options.passphrase);
    key = created.key;
    const convertedLegacy = generationPaths.some((generationPath) => {
      if (!existsSync(generationPath)) return false;
      return isLegacySqliteImage(readSensitiveGeneration(generationPath));
    });

    const writes: Array<{ path: string; envelope: Uint8Array }> = [];
    for (const generation of plaintexts.filter((candidate) => !candidate.live)) {
      writes.push({
        path: generation.path,
        envelope: await encryptVaultGeneration(generation.image, key),
      });
    }
    if (convertedLegacy) {
      const originalLive = readSensitiveGeneration(dbPath);
      writes.push({
        path: preVaultBackupPath(dbPath),
        envelope: await encryptVaultGeneration(originalLive, key),
      });
    }
    writes.push({ path: dbPath, envelope: created.envelope });

    for (const write of writes) {
      lease.assertOwned();
      await writeEncryptedGenerationAtomically(write.path, write.envelope, {
        replace: write.path === dbPath || existsSync(write.path),
        purpose: "vault-setup",
        allowLegacyPermissions: false,
      });
      const persisted = readSensitiveGeneration(write.path);
      const verified = await decryptVaultGeneration(persisted, key);
      try {
        await validateSqliteImage(verified, `Persisted vault generation ${write.path}`);
      } finally {
        verified.fill(0);
      }
    }

    return {
      dbPath,
      recoverySecret: created.recoverySecret,
      key,
      created: !liveExists,
      convertedLegacy,
      generations: writes.map((write) => write.path),
    };
  } catch (error) {
    if (key) destroyVaultKey(key);
    throw error;
  } finally {
    for (const generation of plaintexts) generation.image.fill(0);
    await lease.release();
  }
}

async function initPlaintextFixture(force: boolean, dbPath: string): Promise<void> {
  if (existsSync(dbPath) && !force && readFileSync(dbPath).length > 0) {
    throw new Error(`Refusing to overwrite existing database at ${dbPath}`);
  }
  const runtime = await sqlRuntime();
  const db = new runtime.Database();
  try {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: JournalEntry[];
    };
    for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
      const migration = readFileSync(
        path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
        "utf-8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) db.exec(statement);
      }
    }
    mkdirSync(path.dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, Buffer.from(db.export()), { mode: 0o600 });
  } finally {
    db.close();
  }
}

async function init(): Promise<void> {
  const dbPath = resolveInitDbPath();
  if (process.env.LOCALFI_VAULT_TEST_MODE === "plaintext") {
    assertPlaintextFixturePath(dbPath);
    await initPlaintextFixture(process.argv.includes("--force"), dbPath);
    return;
  }
  const passphrase = process.env.LOCALFI_VAULT_PASSPHRASE;
  if (!passphrase) throw new Error("LOCALFI_VAULT_PASSPHRASE is required for headless setup.");
  const result = await setupVaultDatabase({ dbPath, passphrase });
  destroyVaultKey(result.key);
  console.log(`Encrypted LocalFi vault initialized at ${result.dbPath}`);
  console.log("Save the recovery secret from the setup UI; CLI setup does not print secrets.");
}

if (/\binit\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  init().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
