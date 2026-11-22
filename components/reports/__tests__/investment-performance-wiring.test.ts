import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(__dirname, "..", "investment-performance.tsx"), "utf8");

describe("investment performance wiring", () => {
  it("isolates a line on legend double-click", () => {
    expect(source).toMatch(/onDoubleClick=\{\(\) => isolate\(item\.key\)\}/);
    expect(source).toMatch(/isolateLine\(lines\.map\(\(item\) => item\.key\), current, key\)/);
  });

  it("limits the tooltip to the hovered line through wide invisible hit strokes", () => {
    expect(source).toMatch(/byKey\.get\(String\(entry\.dataKey\)\)\?\.key === hovered/);
    expect(source).toMatch(/stroke="transparent"[\s\S]*tooltipType="none"[\s\S]*onMouseEnter=\{\(\) => setHovered\(hit\.owner\)\}/);
  });

  it("plots the total line and summarizes holdings in a table with a total row", () => {
    expect(source).toMatch(/dataKey=\{TOTAL_KEY\}/);
    expect(source).toMatch(/<TableFooter[\s\S]*Total portfolio/);
  });
});
