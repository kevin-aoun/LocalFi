import { describe, expect, it } from "vitest";
import {
  CATEGORY_ICON_OPTIONS,
  resolveCategoryIcon,
} from "../category-icons";

describe("category icon registry", () => {
  it("offers a broad visual selection including Bitcoin", () => {
    expect(CATEGORY_ICON_OPTIONS).toContain("Bitcoin");
    expect(CATEGORY_ICON_OPTIONS.length).toBeGreaterThan(40);
  });

  it("resolves known icons and safely falls back for unknown stored values", () => {
    expect(resolveCategoryIcon("Bitcoin")).toBeDefined();
    expect(resolveCategoryIcon("Wallet")).toBe(resolveCategoryIcon("not-a-real-icon"));
    expect(resolveCategoryIcon(null)).toBe(resolveCategoryIcon(undefined));
  });

  it("rejects non-icon lucide exports even when the persisted name collides", () => {
    expect(resolveCategoryIcon("createLucideIcon")).toBe(resolveCategoryIcon("Wallet"));
    expect(resolveCategoryIcon("icons")).toBe(resolveCategoryIcon("Wallet"));
  });
});
