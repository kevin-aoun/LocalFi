import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(path.resolve(__dirname, "..", "..", ".."), "components/ui/tooltip.tsx"),
  "utf8",
);

describe("tooltip theme", () => {
  it("uses the theme-aware popover surface and foreground", () => {
    expect(source).toMatch(/bg-popover/);
    expect(source).toMatch(/text-popover-foreground/);
    expect(source).not.toMatch(/bg-primary/);
  });
});
