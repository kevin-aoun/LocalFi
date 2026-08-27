import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  privateTrackedPathReason,
  privateTrackedPaths,
  sandboxRunArgs,
} from "../source-sandbox-logic";

describe("source-only Docker Sandbox", () => {
  it.each([
    "data/budget.db",
    "backups/budget.db.bak",
    "exports/report.csv",
    ".agent/session.json",
    "private.sqlite",
    "private.sqlite-shm",
    "private.db-wal",
    ".env",
    ".env.local",
    "credentials.json",
  ])("rejects private tracked path %s", (file) => {
    expect(privateTrackedPathReason(file)).not.toBeNull();
  });

  it.each([
    ".env.example",
    "components/exports/export-disclosure.tsx",
    "app/(dashboard)/budgets/page.tsx",
    "docs/images/dark/dashboard.png",
  ])("allows ordinary source path %s", (file) => {
    expect(privateTrackedPathReason(file)).toBeNull();
  });

  it("keeps the committed tree free of private artifacts", () => {
    const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      encoding: "utf8",
    }).split("\n").filter(Boolean);

    expect(privateTrackedPaths(tracked)).toEqual([]);
  });

  it("always uses clone isolation and disables shared skills", () => {
    expect(sandboxRunArgs("codex", "localfi-review", "/safe/source")).toEqual([
      "run",
      "--clone",
      "--no-share-skills",
      "--name",
      "localfi-review",
      "codex",
      "/safe/source",
    ]);
  });
});
