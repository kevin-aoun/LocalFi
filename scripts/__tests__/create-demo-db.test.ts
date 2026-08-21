import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { afterEach, describe, expect, it } from "vitest";

import { verifyLedgerRaw } from "../../lib/ledger";
import {
  parseCreateDemoArgs,
  resolveSafeDemoOutput,
} from "../create-demo-db";

const CREATE_DEMO_SCRIPT = path.resolve(process.cwd(), "scripts", "create-demo-db.ts");

function runCreateDemoCli(
  args: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
) {
  const env = { ...process.env, ...overrides };
  delete env.BUDGET_DB_PATH;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", CREATE_DEMO_SCRIPT, ...args],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
}

describe.sequential("create-demo-db path safety", () => {
  const directories: string[] = [];
  const originalDbPath = process.env.BUDGET_DB_PATH;

  function directory(): string {
    const created = mkdtempSync(path.join(os.tmpdir(), "localfi-demo-script-test-"));
    directories.push(created);
    return created;
  }

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.BUDGET_DB_PATH;
    else process.env.BUDGET_DB_PATH = originalDbPath;
    directories.splice(0).forEach((item) => rmSync(item, { recursive: true, force: true }));
  });

  it("requires an explicit output and rejects the default owner path before opening it", () => {
    expect(() => parseCreateDemoArgs([])).toThrow(/explicit --output path is required/);
    expect(() => resolveSafeDemoOutput(path.resolve(process.cwd(), "data", "budget.db")))
      .toThrow(/owner\/default database/);
    expect(() => resolveSafeDemoOutput(path.resolve(process.cwd(), "data", "budget.db.bak")))
      .toThrow(/owner\/default database/);
  });

  it("also protects the configured owner path", () => {
    const configured = path.join(directory(), "owner.db");
    process.env.BUDGET_DB_PATH = configured;
    expect(() => resolveSafeDemoOutput(configured)).toThrow(/owner\/default database/);
  });

  it("protects configured owner and backup aliases without reading or changing their bytes", () => {
    const dir = directory();
    const realDirectory = path.join(dir, "real");
    const aliasDirectory = path.join(dir, "alias");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, aliasDirectory);
    const canonicalOwner = path.join(realDirectory, "owner.db");
    const canonicalBackup = `${canonicalOwner}.bak`;
    const ownerBytes = Buffer.from("owner-sentinel");
    const backupBytes = Buffer.from("backup-sentinel");
    writeFileSync(canonicalOwner, ownerBytes);
    writeFileSync(canonicalBackup, backupBytes);
    process.env.BUDGET_DB_PATH = path.join(aliasDirectory, "owner.db");

    expect(() => resolveSafeDemoOutput(canonicalOwner, { replace: true }))
      .toThrow(/owner\/default database/);
    expect(() => resolveSafeDemoOutput(canonicalBackup, { replace: true }))
      .toThrow(/owner\/default database/);

    const hardOwner = path.join(dir, "hard-owner.db");
    const hardBackup = path.join(dir, "hard-backup.db");
    linkSync(canonicalOwner, hardOwner);
    linkSync(canonicalBackup, hardBackup);
    expect(() => resolveSafeDemoOutput(hardOwner, { replace: true }))
      .toThrow(/owner\/default database/);
    expect(() => resolveSafeDemoOutput(hardBackup, { replace: true }))
      .toThrow(/owner\/default database/);

    expect(readFileSync(canonicalOwner)).toEqual(ownerBytes);
    expect(readFileSync(canonicalBackup)).toEqual(backupBytes);
  });

  it("preserves existing targets unless replacement is explicit and refuses symlinks", () => {
    const dir = directory();
    const existing = path.join(dir, "existing.db");
    writeFileSync(existing, "sentinel");
    expect(() => resolveSafeDemoOutput(existing)).toThrow(/Refusing to overwrite existing demo target/);
    expect(readFileSync(existing, "utf8")).toBe("sentinel");

    const link = path.join(dir, "link.db");
    symlinkSync(existing, link);
    expect(() => resolveSafeDemoOutput(link, { replace: true })).toThrow(/symbolic link/);
    expect(readFileSync(existing, "utf8")).toBe("sentinel");

    const realDirectory = path.join(dir, "real");
    const aliasDirectory = path.join(dir, "alias");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, aliasDirectory);
    expect(() => resolveSafeDemoOutput(path.join(aliasDirectory, "nested.db"), { replace: true }))
      .toThrow(/symbolic-link directory/);
  });

  it("creates one verified SQLite file and safely supports explicit replacement", async () => {
    const dir = directory();
    const output = path.join(dir, "demo.db");
    const firstRun = runCreateDemoCli(["--output", output]);
    expect(firstRun.status, firstRun.stderr).toBe(0);
    const first = JSON.parse(firstRun.stdout) as Record<string, unknown>;

    expect(first).toMatchObject({
      outputPath: output,
      accounts: 4,
      assets: 4,
      confirmedTransactions: 26,
      ledgerEvents: 28,
    });
    expect(first.bytes).toBeGreaterThan(100_000);
    expect(readdirSync(dir).sort()).toEqual(["demo.db"]);
    expect(existsSync(`${output}.bak`)).toBe(false);

    const refused = runCreateDemoCli(["--output", output]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/Refusing to overwrite existing demo target/);
    const replacement = runCreateDemoCli(["--output", output, "--replace"]);
    expect(replacement.status, replacement.stderr).toBe(0);
    const second = JSON.parse(replacement.stdout) as Record<string, unknown>;
    expect(second).toEqual(first);
    expect(readdirSync(dir).sort()).toEqual(["demo.db"]);

    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), "node_modules/sql.js/dist", file),
    });
    const raw = new SQL.Database(readFileSync(output));
    try {
      expect(verifyLedgerRaw(raw)).toMatchObject({ ok: true, failures: [] });
    } finally {
      raw.close();
    }
  }, 15_000);

  it("creates the same SQLite image in UTC+14 and UTC-11", () => {
    const dir = directory();
    const ahead = path.join(dir, "ahead.db");
    const behind = path.join(dir, "behind.db");

    const aheadRun = runCreateDemoCli(["--output", ahead], { TZ: "Pacific/Kiritimati" });
    const behindRun = runCreateDemoCli(["--output", behind], { TZ: "Pacific/Niue" });

    expect(aheadRun.status, aheadRun.stderr).toBe(0);
    expect(behindRun.status, behindRun.stderr).toBe(0);
    expect(readFileSync(ahead)).toEqual(readFileSync(behind));
  }, 15_000);

  it("keeps environment-switching generation private to the CLI module", () => {
    const source = readFileSync(CREATE_DEMO_SCRIPT, "utf8");
    expect(source).not.toMatch(/export\s+(?:async\s+)?function\s+createDemoDatabase/);
    expect(source).toMatch(/createDemoDatabaseInCliProcess\(parsed\.options\)/);
  });
});
