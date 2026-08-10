import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..");

describe("shadcn Switch", () => {
  it("wraps the accessible Radix primitive and exposes focus and disabled states", () => {
    const component = readFileSync(path.join(ROOT, "components/ui/switch.tsx"), "utf8");
    expect(component).toContain('from "@radix-ui/react-switch"');
    expect(component).toContain("SwitchPrimitive.Root");
    expect(component).toContain("SwitchPrimitive.Thumb");
    expect(component).toContain("focus-visible:ring-2");
    expect(component).toContain("disabled:cursor-not-allowed");
  });
});
