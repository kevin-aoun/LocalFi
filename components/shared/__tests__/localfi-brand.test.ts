import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..", "..", "..");

describe("LocalFi brand mark", () => {
  it("uses Lucide BadgeDollarSign in the app chrome", () => {
    const sidebar = readFileSync(path.join(root, "components/shared/sidebar.tsx"), "utf8");
    expect(sidebar).toMatch(/<BadgeDollarSign[^>]+aria-hidden="true"/);
    expect(sidebar).toMatch(/BadgeDollarSign[\s\S]+LocalFi/);
  });

  it("uses the same Lucide paths for the browser icon", () => {
    const icon = readFileSync(path.join(root, "app/icon.svg"), "utf8");
    expect(icon).toContain("M3.85 8.62");
    expect(icon).toContain("M16 8h-6");
    expect(icon).toContain("M12 18V6");
  });
});
