
import { describe, expect, it } from "vitest";

import {
  ACCENT_CSS_PROPERTIES,
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  FOREGROUND_DARK,
  FOREGROUND_LIGHT,
  contrastRatio,
  describeColor,
  findPreset,
  hexInputError,
  hexToHsl,
  hexToRgb,
  isValidHex,
  nextSwatchIndex,
  normalizeHex,
  pickForeground,
  relativeLuminance,
  resolveAccent,
  rgbToHex,
  type ColorPreset,
} from "@/components/ui/color-picker-logic";

describe("normalizeHex", () => {
  it("accepts #rrggbb in any case, with or without the hash", () => {
    expect(normalizeHex("#0EA5E9")).toBe("#0ea5e9");
    expect(normalizeHex("0ea5e9")).toBe("#0ea5e9");
    expect(normalizeHex("  #0Ea5E9  ")).toBe("#0ea5e9");
  });

  it("expands #rgb by doubling each digit, not by zero-padding", () => {
    expect(normalizeHex("#abc")).toBe("#aabbcc");
    expect(normalizeHex("F00")).toBe("#ff0000");
    expect(normalizeHex("#000")).toBe("#000000");
  });

  it("is idempotent", () => {
    const once = normalizeHex("#ABC");
    expect(normalizeHex(once)).toBe(once);
  });

  it("rejects partial, malformed and alpha hex rather than guessing", () => {
    for (const bad of ["", "#", "#a", "#a8", "#a85f", "#a855f", "#a855f77", "#12345678", "#gggggg", "rgb(1,2,3)", "default", "  ", "#a855f7 extra"]) {
      expect(normalizeHex(bad), bad).toBeNull();
    }
  });

  it("rejects non-strings without throwing", () => {
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
    expect(isValidHex(null)).toBe(false);
  });

  it("never returns a half-parsed colour for a half-typed one", () => {

    const typed = "#a855f7";
    const valid = [];
    for (let i = 1; i <= typed.length; i++) {
      const prefix = typed.slice(0, i);
      if (isValidHex(prefix)) valid.push(prefix);
    }
    expect(valid).toEqual(["#a85", "#a855f7"]);
  });
});

describe("hexToRgb / rgbToHex", () => {
  it("round-trips", () => {
    expect(hexToRgb("#0ea5e9")).toEqual({ r: 14, g: 165, b: 233 });
    expect(rgbToHex({ r: 14, g: 165, b: 233 })).toBe("#0ea5e9");
    expect(rgbToHex(hexToRgb("#abc")!)).toBe("#aabbcc");
  });

  it("keeps a zero channel as zero", () => {

    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
  });

  it("clamps out-of-range channels", () => {
    expect(rgbToHex({ r: -20, g: 300, b: 127.6 })).toBe("#00ff80");
  });
});

describe("hexToHsl", () => {
  it("converts the known presets", () => {
    expect(hexToHsl("#a855f7")).toEqual({ h: 271, s: 91, l: 65, hsl: "271 91% 65%" });
    expect(hexToHsl("#dc2626")?.hsl).toBe("0 72% 51%");
    expect(hexToHsl("#ffffff")?.hsl).toBe("0 0% 100%");
  });

  it("reports hue 0 for red instead of treating it as absent", () => {
    const red = hexToHsl("#ff0000");
    expect(red).not.toBeNull();
    expect(red!.h).toBe(0);
    expect(red!.s).toBe(100);
    expect(red!.hsl).toBe("0 100% 50%");
  });

  it("gives grey zero saturation and keeps black at lightness 0", () => {
    expect(hexToHsl("#808080")).toEqual({ h: 0, s: 0, l: 50, hsl: "0 0% 50%" });
    expect(hexToHsl("#000000")).toEqual({ h: 0, s: 0, l: 0, hsl: "0 0% 0%" });
  });

  it("handles 3-digit hex, which the old inline copy turned into NaN", () => {

    expect(hexToHsl("#f00")?.hsl).toBe("0 100% 50%");
  });

  it("returns null rather than a NaN colour for invalid input", () => {
    expect(hexToHsl("#a8")).toBeNull();
    expect(hexToHsl("default")).toBeNull();
  });
});

describe("contrast", () => {
  it("computes the WCAG anchors", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 10);
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 10);
  });

  it("is symmetric", () => {
    const a = hexToRgb("#0ea5e9")!;
    const b = hexToRgb("#f59e0b")!;
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 12);
  });

  it("picks the foreground with the better contrast, not the lower HSL lightness", () => {

    const amber = hexToRgb("#f59e0b")!;
    expect(pickForeground(amber).hsl).toBe(FOREGROUND_DARK);
    expect(pickForeground(amber).ratio).toBeGreaterThan(4.5);

    expect(pickForeground(hexToRgb("#1e3a8a")!).hsl).toBe(FOREGROUND_LIGHT);
  });

  it("gives every preset a foreground that clears WCAG AA", () => {
    for (const preset of ACCENT_PRESETS) {
      const rgb = hexToRgb(preset.value);
      if (rgb === null) continue;
      expect(pickForeground(rgb).ratio, preset.name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("documents the removed #a855f7 special case", () => {

    const purple = hexToRgb("#a855f7")!;
    const onLight = contrastRatio(purple, { r: 249.9, g: 249.9, b: 249.9 });
    const onDark = contrastRatio(purple, { r: 22.95, g: 22.95, b: 22.95 });
    expect(onLight).toBeCloseTo(3.79, 1);
    expect(onDark).toBeCloseTo(4.53, 1);
    expect(pickForeground(purple).hsl).toBe(FOREGROUND_DARK);
  });

  it("works for a user-entered hex that is not a preset", () => {
    expect(pickForeground(hexToRgb("#ffff00")!).hsl).toBe(FOREGROUND_DARK);
    expect(pickForeground(hexToRgb("#000080")!).hsl).toBe(FOREGROUND_LIGHT);
    expect(pickForeground(hexToRgb("#fff")!).hsl).toBe(FOREGROUND_DARK);
    expect(pickForeground(hexToRgb("#000")!).hsl).toBe(FOREGROUND_LIGHT);
  });
});

describe("resolveAccent", () => {
  it("resets every property it owns for the default sentinel", () => {
    const application = resolveAccent(DEFAULT_ACCENT);
    expect(application).not.toBeNull();
    expect(application!.kind).toBe("reset");
    expect(application!.kind === "reset" && application!.remove).toEqual(ACCENT_CSS_PROPERTIES);
    expect(ACCENT_CSS_PROPERTIES).toContain("--primary");
    expect(ACCENT_CSS_PROPERTIES).toContain("--chart-1");
    expect(ACCENT_CSS_PROPERTIES).toContain("--primary-foreground");
  });

  it("accepts the sentinel in any case, with padding", () => {
    expect(resolveAccent("  DEFAULT ")?.kind).toBe("reset");
  });

  it("writes primary, chart-1 and a contrasting foreground for a hex", () => {
    const application = resolveAccent("#0EA5E9");
    expect(application?.kind).toBe("set");
    if (application?.kind !== "set") throw new Error("expected a set application");
    expect(application.hex).toBe("#0ea5e9");
    expect(application.set["--primary"]).toBe("199 89% 48%");
    expect(application.set["--chart-1"]).toBe(application.set["--primary"]);
    expect(application.set["--primary-foreground"]).toBe(FOREGROUND_DARK);
    expect(application.contrast).toBeGreaterThan(4.5);
  });

  it("accepts a short hex", () => {
    const application = resolveAccent("f00");
    expect(application?.kind === "set" && application.hex).toBe("#ff0000");
  });

  it("returns null for anything unusable so the caller can report it", () => {
    for (const bad of ["#a8", "", "purple", "#12345", null, undefined]) {
      expect(resolveAccent(bad), String(bad)).toBeNull();
    }
  });
});

describe("presets", () => {
  it("keeps every non-sentinel preset a canonical hex", () => {
    for (const preset of ACCENT_PRESETS) {
      if (preset.value === DEFAULT_ACCENT) continue;
      expect(normalizeHex(preset.value), preset.name).toBe(preset.value);
    }
  });

  it("has unique values and names", () => {
    expect(new Set(ACCENT_PRESETS.map((p) => p.value)).size).toBe(ACCENT_PRESETS.length);
    expect(new Set(ACCENT_PRESETS.map((p) => p.name)).size).toBe(ACCENT_PRESETS.length);
  });

  it("gives the sentinel preset something to paint with", () => {
    const fallback = ACCENT_PRESETS.find((p) => p.value === DEFAULT_ACCENT);
    expect(fallback?.swatchClassName).toBeTruthy();
  });

  it("preserves the original palette so no saved setting becomes unselectable", () => {
    expect(ACCENT_PRESETS.map((p) => p.value)).toEqual([
      "default",
      "#dc2626",
      "#f59e0b",
      "#84cc16",
      "#0ea5e9",
      "#a855f7",
      "#d946ef",
      "#06b6d4",
    ]);
  });
});

describe("findPreset / describeColor", () => {
  const presets: ColorPreset[] = ACCENT_PRESETS;

  it("matches hex presets across spellings", () => {
    expect(findPreset("#A855F7", presets)?.name).toBe("Purple");
    expect(findPreset("a855f7", presets)?.name).toBe("Purple");
  });

  it("matches the sentinel case-insensitively", () => {
    expect(findPreset("Default", presets)?.name).toBe("Default");
  });

  it("returns undefined for a custom colour", () => {
    expect(findPreset("#123456", presets)).toBeUndefined();
  });

  it("labels a custom colour with its canonical hex", () => {
    expect(describeColor("#ABC", presets)).toBe("#aabbcc");
    expect(describeColor("#0ea5e9", presets)).toBe("Sky");

    expect(describeColor("nonsense", presets)).toBe("nonsense");
  });

  it("would match a 3-digit preset against its expanded form", () => {
    const short: ColorPreset[] = [{ name: "Short", value: "#abc" }];
    expect(findPreset("#aabbcc", short)?.name).toBe("Short");
  });
});

describe("hexInputError", () => {
  it("says nothing about an empty field", () => {
    expect(hexInputError("")).toBeNull();
    expect(hexInputError("   ")).toBeNull();
  });

  it("says nothing about a valid colour", () => {
    expect(hexInputError("#abc")).toBeNull();
    expect(hexInputError("0EA5E9")).toBeNull();
  });

  it("explains what is accepted when the value is wrong", () => {
    const message = hexInputError("#a8");
    expect(message).toContain("#rrggbb");
    expect(hexInputError("chartreuse")).toBe(message);
  });
});

describe("nextSwatchIndex", () => {

  const count = 8;
  const columns = 4;

  it("moves and wraps horizontally", () => {
    expect(nextSwatchIndex("ArrowRight", 0, count, columns)).toBe(1);
    expect(nextSwatchIndex("ArrowRight", 7, count, columns)).toBe(0);
    expect(nextSwatchIndex("ArrowLeft", 0, count, columns)).toBe(7);
    expect(nextSwatchIndex("ArrowLeft", 4, count, columns)).toBe(3);
  });

  it("moves and wraps vertically", () => {
    expect(nextSwatchIndex("ArrowDown", 0, count, columns)).toBe(4);
    expect(nextSwatchIndex("ArrowDown", 5, count, columns)).toBe(1);
    expect(nextSwatchIndex("ArrowUp", 6, count, columns)).toBe(2);
    expect(nextSwatchIndex("ArrowUp", 2, count, columns)).toBe(6);
  });

  it("keeps index 0 reachable, which a falsy check would drop", () => {
    expect(nextSwatchIndex("Home", 5, count, columns)).toBe(0);
    expect(nextSwatchIndex("ArrowLeft", 1, count, columns)).toBe(0);
    expect(nextSwatchIndex("End", 0, count, columns)).toBe(7);
  });

  it("clamps a ragged last row instead of focusing a swatch that is not there", () => {

    expect(nextSwatchIndex("ArrowDown", 2, 6, 4)).toBe(2);
    expect(nextSwatchIndex("ArrowUp", 2, 6, 4)).toBe(2);
    expect(nextSwatchIndex("ArrowDown", 1, 6, 4)).toBe(5);
    expect(nextSwatchIndex("ArrowUp", 5, 6, 4)).toBe(1);
  });

  it("leaves other keys to the browser", () => {
    for (const key of ["Enter", " ", "Tab", "Escape", "a"]) {
      expect(nextSwatchIndex(key, 0, count, columns), key).toBeNull();
    }
  });

  it("survives degenerate grids", () => {
    expect(nextSwatchIndex("ArrowRight", 0, 0, 4)).toBeNull();
    expect(nextSwatchIndex("ArrowDown", 0, 3, 0)).toBe(1);
    expect(nextSwatchIndex("ArrowRight", 0, 1, 1)).toBe(0);
  });
});
