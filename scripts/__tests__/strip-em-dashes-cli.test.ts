/**
 * End-to-end tests for the codemod DRIVER: the safety behaviour that the pure
 * logic cannot express.
 *
 * There is no git in this project, so "did it refuse to write, and did it back
 * up first" is the property that actually protects the user. Every test here
 * runs the real script in a throwaway directory; nothing touches the repo.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO, "scripts/strip-em-dashes.ts");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");

let sandbox: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "strip-em-dashes-"));
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function write(relative: string, contents: string): string {
  const file = path.join(sandbox, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

function read(relative: string): string {
  return fs.readFileSync(path.join(sandbox, relative), "utf8");
}

function cli(...args: string[]): string {
  return execFileSync(process.execPath, [TSX, SCRIPT, ...args], {
    cwd: sandbox,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

const SAMPLE = [
  "/** The report period lengths — the same set budgets use. */",
  'export const LABEL = "Total — $4,496.18";',
  "",
].join("\n");

describe("dry run is the default", () => {
  it("changes nothing on disk when no flags are passed", () => {
    write("lib/sample.ts", SAMPLE);
    const output = cli();

    expect(read("lib/sample.ts")).toBe(SAMPLE);
    expect(output).toContain("DRY RUN");
    expect(output).toContain("Re-run with --write to apply.");
    expect(fs.existsSync(path.join(sandbox, ".strip-em-dashes-backups"))).toBe(false);
  });

  it("prints a unified diff with file names and line numbers", () => {
    write("lib/sample.ts", SAMPLE);
    const output = cli();

    expect(output).toContain("--- a/lib/sample.ts");
    expect(output).toContain("+++ b/lib/sample.ts");
    // Both lines changed and they are adjacent, so it is one hunk.
    expect(output).toMatch(/@@ -1,2 \+1,2 @@/);
    expect(output).toContain("-/** The report period lengths — the same set budgets use. */");
    expect(output).toContain("+/** The report period lengths: the same set budgets use. */");
  });

  it("reports totals broken down by site kind and dash character", () => {
    write("lib/sample.ts", SAMPLE);
    const output = cli();

    expect(output).toMatch(/files scanned\s+1/);
    expect(output).toMatch(/sites found\s+2\s+\(em 2, en 0, bar 0\)/);
    expect(output).toMatch(/sites changed\s+2/);
    expect(output).toMatch(/by site kind\s+comment 1, string 1, jsx 0/);
  });
});

describe("--write", () => {
  it("applies the changes", () => {
    write("lib/sample.ts", SAMPLE);
    cli("--write");

    expect(read("lib/sample.ts")).toBe(
      ["/** The report period lengths: the same set budgets use. */", 'export const LABEL = "Total: $4,496.18";', ""].join(
        "\n",
      ),
    );
  });

  it("copies every file it touches into a timestamped backup first, and says where", () => {
    write("lib/sample.ts", SAMPLE);
    const output = cli("--write");

    expect(output).toContain("Backup of every file about to change: .strip-em-dashes-backups/");

    const backupRoot = path.join(sandbox, ".strip-em-dashes-backups");
    const stamps = fs.readdirSync(backupRoot);
    expect(stamps).toHaveLength(1);

    // The backup holds the ORIGINAL, byte for byte, at its original path.
    const backed = fs.readFileSync(path.join(backupRoot, stamps[0], "lib/sample.ts"), "utf8");
    expect(backed).toBe(SAMPLE);
    // ...and the working file really did change.
    expect(read("lib/sample.ts")).not.toBe(SAMPLE);
  });

  it("does not back up files it is not going to change", () => {
    write("lib/sample.ts", SAMPLE);
    write("lib/untouched.ts", "export const A = 1;\n");
    cli("--write");

    const backupRoot = path.join(sandbox, ".strip-em-dashes-backups");
    const stamp = fs.readdirSync(backupRoot)[0];
    expect(fs.existsSync(path.join(backupRoot, stamp, "lib/sample.ts"))).toBe(true);
    expect(fs.existsSync(path.join(backupRoot, stamp, "lib/untouched.ts"))).toBe(false);
  });
});

describe("scope", () => {
  it("excludes __tests__ by default and says so", () => {
    write("lib/sample.ts", SAMPLE);
    const spec = '/** a test — with a dash */\nexport const T = 1;\n';
    write("lib/__tests__/sample.test.ts", spec);

    const output = cli("--write");
    expect(output).toContain("__tests__           EXCLUDED by default");
    expect(read("lib/__tests__/sample.test.ts")).toBe(spec);
  });

  it("includes __tests__ with --include-tests", () => {
    const spec = '/** a test — with a dash */\nexport const T = 1;\n';
    write("lib/__tests__/sample.test.ts", spec);

    const output = cli("--include-tests", "--write");
    expect(output).toContain("INCLUDED (--include-tests)");
    // "with" is a preposition, so the dash was doing a comma's job.
    expect(read("lib/__tests__/sample.test.ts")).toContain("/** a test, with a dash */");
  });

  it("honours --only=strings", () => {
    write("lib/sample.ts", SAMPLE);
    cli("--only=strings", "--write");

    const after = read("lib/sample.ts");
    expect(after).toContain("/** The report period lengths — the same set budgets use. */");
    expect(after).toContain('"Total: $4,496.18"');
  });

  it("skips node_modules, .next, data and drizzle", () => {
    for (const dir of ["node_modules", ".next", "data", "drizzle"]) {
      write(`lib/${dir}/sample.ts`, SAMPLE);
    }
    const output = cli();
    expect(output).toMatch(/files scanned\s+0/);
  });

  it("reports a test collision when a test asserts the string being rewritten", () => {
    write("lib/sample.ts", 'export const LABEL = "Filtered view — 1 of 4 holdings hidden";\n');
    write(
      "lib/__tests__/sample.test.ts",
      'it("labels", () => { expect(LABEL).toBe("Filtered view — 1 of 4 holdings hidden"); });\n',
    );

    const output = cli();
    expect(output).toContain("TEST COLLISIONS (certain)");
    expect(output).toContain("lib/__tests__/sample.test.ts");
    expect(output).toContain("Filtered view");
  });
});
