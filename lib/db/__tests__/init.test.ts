/**
 * `db:init` must be targetable at a temp file.
 *
 * It used to hard-code `<cwd>/data/budget.db`, which meant every script and test
 * that wanted a throwaway database either hand-rolled the journal replay or
 * risked pointing the initialiser at the user's real financial history. Honouring
 * BUDGET_DB_PATH (the same variable lib/db/client.ts reads) removes that hazard.
 *
 * This test drives the script as a subprocess, because that is how it is used.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInitDbPath } from "../init";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const INIT_SCRIPT = path.join("lib", "db", "init.ts");

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "budget-init-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function runInit(dbPath: string, args: string[] = []) {
  return execFileSync(process.execPath, ["--import", "tsx", INIT_SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, BUDGET_DB_PATH: dbPath },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("lib/db/init.ts", () => {
  it("creates the database at BUDGET_DB_PATH, not at data/budget.db", () => {
    const dbPath = path.join(tempDir(), "nested", "target.db");
    runInit(dbPath);

    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).size).toBeGreaterThan(0);
  }, 60_000);

  it("applies the whole journal, including 0003", () => {
    const dbPath = path.join(tempDir(), "target.db");
    runInit(dbPath);
    const image = readFileSync(dbPath);
    for (const table of [
      "accounts",
      "budgets",
      "recurring_transactions",
      "net_worth_snapshots",
      "ledger_events",
      "instrument_positions",
    ]) {
      expect(image.includes(Buffer.from(table))).toBe(true);
    }
  }, 60_000);

  it("refuses to clobber a non-empty file at BUDGET_DB_PATH", () => {
    const dbPath = path.join(tempDir(), "existing.db");
    writeFileSync(dbPath, "not really a database but definitely not empty");

    expect(() => runInit(dbPath)).toThrow();
    // The file must be exactly as it was.
    expect(statSync(dbPath).size).toBe("not really a database but definitely not empty".length);
  }, 60_000);

  it("overwrites when --force is passed", () => {
    const dbPath = path.join(tempDir(), "existing.db");
    writeFileSync(dbPath, "stale");
    runInit(dbPath, ["--force"]);
    expect(statSync(dbPath).size).toBeGreaterThan(1000);
  }, 60_000);

  it("still defaults to data/budget.db when the variable is unset", () => {
    // Only the resolver is checked here — actually running it would target the
    // user's real database.
    const previous = process.env.BUDGET_DB_PATH;
    process.env.BUDGET_DB_PATH = "";
    try {
      expect(resolveInitDbPath()).toBe(path.join(PROJECT_ROOT, "data", "budget.db"));
    } finally {
      if (previous === undefined) delete process.env.BUDGET_DB_PATH;
      else process.env.BUDGET_DB_PATH = previous;
    }
  }, 60_000);
});
