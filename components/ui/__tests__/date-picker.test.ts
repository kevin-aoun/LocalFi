import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { fromDateKey, isDateKey, toDateKey } from "@/lib/dates";

const datePickerSource = readFileSync(
  resolve(process.cwd(), "components/ui/date-picker.tsx"),
  "utf8",
);
const reportsSource = readFileSync(
  resolve(process.cwd(), "app/(dashboard)/reports/reports-client.tsx"),
  "utf8",
);

describe("DatePicker contract", () => {
  it("round-trips a calendar day without UTC serialization", () => {
    const key = "2026-07-28";

    expect(isDateKey(key)).toBe(true);
    expect(toDateKey(fromDateKey(key))).toBe(key);
  });

  it("emits DateKeys and uses the shared Calendar/Popover control", () => {
    expect(datePickerSource).toContain('fromDateKey, isDateKey, toDateKey');
    expect(datePickerSource).toContain("<Calendar");
    expect(datePickerSource).toContain("<Popover");
    expect(datePickerSource).not.toMatch(/type\s*=\s*["'](?:date|month)["']/);
    expect(datePickerSource).not.toContain("toISOString");
  });

  it("keeps report custom ranges on DatePicker", () => {
    expect(reportsSource).toContain('from "@/components/ui/date-picker"');
    expect(reportsSource).toContain('<DatePicker');
    expect(reportsSource).not.toMatch(/type\s*=\s*["'](?:date|month)["']/);
  });
});
