import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  WriterLeaseError,
  acquireWriterLease,
  writerLeasePath,
} from "../writer-lease";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const temporaryDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "localfi-writer-lease-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("writer lease", () => {
  it("refuses a second owner with actionable recovery guidance", async () => {
    const dbPath = path.join(tempDirectory(), "budget.db");
    const first = await acquireWriterLease(dbPath);
    try {
      await expect(acquireWriterLease(dbPath)).rejects.toMatchObject({
        name: "WriterLeaseError",
        dbPath,
      });
      await expect(acquireWriterLease(dbPath)).rejects.toThrow(/stop the other LocalFi app/i);
      await expect(acquireWriterLease(dbPath)).rejects.toThrow(/stale-lease recovery/i);
    } finally {
      await first.release();
    }

    const next = await acquireWriterLease(dbPath);
    await next.release();
  });

  it("canonicalizes directory symlinks to one lease target", async () => {
    const root = tempDirectory();
    const realDirectory = path.join(root, "real");
    const aliasDirectory = path.join(root, "alias");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, aliasDirectory, "dir");
    const firstPath = path.join(realDirectory, "budget.db");
    const aliasPath = path.join(aliasDirectory, "budget.db");

    const lease = await acquireWriterLease(firstPath);
    try {
      await expect(acquireWriterLease(aliasPath)).rejects.toBeInstanceOf(WriterLeaseError);
    } finally {
      await lease.release();
    }
  });

  it("recovers a dead writer's stale lease directory", async () => {
    const dbPath = path.join(tempDirectory(), "budget.db");
    const lockPath = writerLeasePath(dbPath);
    mkdirSync(lockPath);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const lease = await acquireWriterLease(dbPath);
    expect(existsSync(lockPath)).toBe(true);
    await lease.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("allows only one writer across independent Node processes", async ({ skip }) => {
    const dbPath = path.join(tempDirectory(), "budget.db");
    const contenderSource = `
      import writerLease from './lib/db/writer-lease.ts';
      const { acquireWriterLease } = writerLease;
      try {
        const lease = await acquireWriterLease(process.argv[1]);
        await lease.release();
        process.exit(0);
      } catch (error) {
        console.error(error.message);
        process.exit(23);
      }
    `;
    const orchestratorSource = `
      import { spawnSync } from 'node:child_process';
      import writerLease from './lib/db/writer-lease.ts';
      const { acquireWriterLease } = writerLease;
      const dbPath = process.argv[1];
      const contenderSource = process.argv[2];
      const lease = await acquireWriterLease(dbPath);
      const held = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--no-warnings', '-e', contenderSource, dbPath],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      await lease.release();
      const after = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--no-warnings', '-e', contenderSource, dbPath],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      console.log(JSON.stringify({
        heldStatus: held.status,
        heldStderr: held.stderr,
        afterStatus: after.status,
        afterStderr: after.stderr,
      }));
    `;
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--no-warnings",
        "-e",
        orchestratorSource,
        dbPath,
        contenderSource,
      ],
      { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 20_000 },
    );
    if ((run.error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
      skip("This test runner sandbox blocks child-process creation; run the process check externally.");
      return;
    }
    expect(
      run.status,
      JSON.stringify({ stderr: run.stderr, stdout: run.stdout, signal: run.signal, error: run.error }),
    ).toBe(0);
    expect(
      run.stdout.trim(),
      JSON.stringify({ stderr: run.stderr, signal: run.signal, error: run.error }),
    ).not.toBe("");
    const evidence = JSON.parse(run.stdout.trim()) as {
      heldStatus: number;
      heldStderr: string;
      afterStatus: number;
      afterStderr: string;
    };
    expect(evidence.heldStatus).toBe(23);
    expect(evidence.heldStderr).toMatch(/another LocalFi process/i);
    expect(evidence.heldStderr).toContain(writerLeasePath(dbPath));
    expect(evidence.afterStatus, evidence.afterStderr).toBe(0);
  }, 20_000);
});
