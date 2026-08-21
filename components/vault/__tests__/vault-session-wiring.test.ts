import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("vault session expiry wiring", () => {
  it("checks status, batches user activity touches, hides finance UI, and redirects", () => {
    const source = readFileSync(
      path.resolve("components/vault/vault-session-coordinator.tsx"),
      "utf8",
    );
    expect(source).toContain('fetch("/api/vault/status"');
    expect(source).toContain('document.addEventListener("pointerdown"');
    expect(source).toContain('document.addEventListener("keydown"');
    expect(source).toContain('useState<"checking" | "unlocked" | "locked">("checking")');
    expect(source).toContain('setStatus("locked")');
    expect(source).toContain('window.location.replace("/vault")');
    expect(source).toContain('className="fixed inset-0');
  });

  it("never renders raw inspection errors on the public vault page", () => {
    const source = readFileSync(path.resolve("app/vault/page.tsx"), "utf8");
    expect(source).not.toContain("error.message");
    expect(source).toContain("The vault could not be inspected safely.");
  });
});
