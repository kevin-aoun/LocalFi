import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("sidebar vault lock control", () => {
  it("posts through the same-origin lock endpoint before leaving financial UI", () => {
    const source = readFileSync(path.resolve("components/shared/sidebar.tsx"), "utf8");
    expect(source).toContain('fetch("/api/vault/lock"');
    expect(source).toContain('credentials: "same-origin"');
    expect(source).toContain('aria-label="Lock LocalFi"');
    expect(source).toContain('router.push("/vault")');
    expect(source).toContain("router.refresh()");
    expect(source).toContain("<VaultSessionCoordinator />");
  });

  it("treats an already-locked vault as an idempotent successful lock", () => {
    const source = readFileSync(path.resolve("app/api/vault/lock/route.ts"), "utf8");
    expect(source).toContain("await vaultSessionManager.lock");
    expect(source).not.toContain("if (!locked)");
    expect(source).toContain('{ status: "locked" }');
  });
});
