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
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const INIT_SCRIPT = path.join("lib", "db", "init.ts");
const TSX = path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

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
  return execFileSync(process.execPath, [TSX, INIT_SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, BUDGET_DB_PATH: dbPath },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("lib/db/init.ts", () => {
  it("creates the database at BUDGET_DB_PATH, not at data/budget.db", () => {
    const dbPath = path.join(tempDir(), "nested", "target.db");
    const output = runInit(dbPath);

    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).size).toBeGreaterThan(0);
    expect(output).toContain(dbPath);
  }, 60_000);

  it("applies the whole journal, including 0003", () => {
    const dbPath = path.join(tempDir(), "target.db");
    const output = runInit(dbPath);

    expect(output).toContain("0000_acoustic_natasha_romanoff");
    expect(output).toContain("0002_money_to_cents");
    expect(output).toContain("0003_accounts_and_budget_periods");
    for (const table of ["accounts", "budgets", "recurring_transactions", "net_worth_snapshots"]) {
      expect(output).toContain(table);
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
    const output = execFileSync(
      process.execPath,
      [
        TSX,
        "-e",
        'import { resolveInitDbPath } from "./lib/db/init"; console.log(resolveInitDbPath());',
      ],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, BUDGET_DB_PATH: "" },
        encoding: "utf-8",
      },
    );
    expect(output.trim()).toBe(path.join(PROJECT_ROOT, "data", "budget.db"));
  }, 60_000);
});
