/**
 * Pure logic behind `color-picker.tsx` and the Accent Color setting.
 *
 * WHY THIS FILE EXISTS: the parsing/normalizing/contrast rules below decide what
 * gets written into `--primary` / `--primary-foreground` and what gets persisted
 * by `updateSettings`. That is exactly the kind of thing that must be unit
 * tested, and this project has no jsdom, so none of it can live in the `.tsx`.
 *
 * Everything here is pure: no DOM, no React, no I/O. The component decides
 * *when* to call these; this file decides *what the answer is*.
 *
 * FALSY-ZERO WARNING: a hue of 0 is red and a lightness of 0 is black. Never
 * test these numbers for truthiness. Invalid input is reported as `null` (or a
 * discriminated union), never as `0`, `""` or `NaN`.
 */

/** A colour channel, 0-255, integer. */
export type Rgb = { r: number; g: number; b: number };

/** Integer HSL: `h` 0-359, `s` and `l` 0-100. Matches Tailwind's CSS variables. */
export type Hsl = { h: number; s: number; l: number };

/**
 * The sentinel stored in `settings.accentColor` meaning "don't override
 * anything, use whatever the theme ships with". It is deliberately NOT a hex
 * value, so every function here that takes a hex rejects it.
 */
export const DEFAULT_ACCENT = "default";

/**
 * The two foreground colours the app actually has, as they appear in
 * app/globals.css (`--primary-foreground` is `0 0% 98%` in light mode and
 * `0 0% 9%` in dark mode). When we override the accent we pick one of these two
 * for BOTH themes, because the accent itself is theme-independent.
 */
export const FOREGROUND_LIGHT = "0 0% 98%";
export const FOREGROUND_DARK = "0 0% 9%";

/** The CSS custom properties the accent colour owns. */
export const ACCENT_CSS_PROPERTIES = ["--primary", "--chart-1", "--primary-foreground"] as const;

/** A named colour offered as a one-click swatch. */
export type ColorPreset = {
  /** Human name, shown in the tooltip and read out by screen readers. */
  name: string;
  /**
   * The value handed to `onValueChange`. Usually a `#rrggbb` hex, but it may be
   * a non-hex sentinel (e.g. `"default"`) for "let something else decide".
   */
  value: string;
  /**
   * Tailwind classes used to paint the swatch when `value` is NOT a hex.
   * Ignored for hex presets, which are painted with an inline background.
   */
  swatchClassName?: string;
};

/**
 * The accent palette the settings page offers. Lives here rather than in the
 * page so a test can assert every one of them parses.
 */
export const ACCENT_PRESETS: ColorPreset[] = [
  { name: "Default", value: DEFAULT_ACCENT, swatchClassName: "bg-black dark:bg-white" },
  { name: "Red", value: "#dc2626" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Lime", value: "#84cc16" },
  { name: "Sky", value: "#0ea5e9" },
  { name: "Purple", value: "#a855f7" },
  { name: "Fuchsia", value: "#d946ef" },
  { name: "Cyan", value: "#06b6d4" },
];

const SHORT_HEX = /^[0-9a-f]{3}$/;
const LONG_HEX = /^[0-9a-f]{6}$/;

/**
 * Normalize any accepted spelling of a hex colour to the single canonical form
 * `#rrggbb`, lower case.
 *
 * Accepts: `#fff`, `fff`, `#FFF`, `#ffffff`, `ffffff`, with surrounding
 * whitespace. Rejects everything else, INCLUDING 4- and 8-digit (alpha) hex:
 * `--primary` is an opaque colour and a half-transparent accent would silently
 * lose its alpha when converted to HSL.
 *
 * Returns `null` for invalid input — never a partially-parsed colour, so a
 * half-typed `#a8` can never reach the DOM or the database.
 */
export function normalizeHex(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;

  const trimmed = input.trim().toLowerCase();
  const body = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;

  if (SHORT_HEX.test(body)) {
    // #abc is shorthand for #aabbcc, not #0a0b0c.
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  if (LONG_HEX.test(body)) return `#${body}`;
  return null;
}

/** True when `input` is a hex colour this app can use. See `normalizeHex`. */
export function isValidHex(input: string | null | undefined): boolean {
  return normalizeHex(input) !== null;
}

/** Parse any accepted hex spelling into 0-255 integer channels, or `null`. */
export function hexToRgb(input: string | null | undefined): Rgb | null {
  const hex = normalizeHex(input);
  if (hex === null) return null;
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/** Render 0-255 channels back to canonical `#rrggbb`. */
export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Hex -> HSL, returning both the integer components and the space-separated
 * string Tailwind's `hsl(var(--primary))` expects.
 *
 * This is the function that used to be duplicated inline in
 * app/(dashboard)/settings/page.tsx and app/providers.tsx. Both copies indexed
 * `hex.substring(0, 2)` directly, so a 3-digit `#f00` produced `NaN NaN% NaN%`
 * and silently painted the app's primary colour as nothing. Going through
 * `hexToRgb` (and therefore `normalizeHex`) is what fixes that.
 *
 * Returns `null` rather than a `NaN`-filled object when the input is not a hex.
 */
export function hexToHsl(input: string | null | undefined): (Hsl & { hsl: string }) | null {
  const rgb = hexToRgb(input);
  if (rgb === null) return null;

  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      default:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  const hue = Math.round(h * 360) % 360;
  const saturation = Math.round(s * 100);
  const lightness = Math.round(l * 100);

  return { h: hue, s: saturation, l: lightness, hsl: `${hue} ${saturation}% ${lightness}%` };
}

/** sRGB -> linear, the WCAG 2.x transfer function. */
function toLinear(channel8Bit: number): number {
  const c = channel8Bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

/** WCAG contrast ratio between two colours, 1 (identical) to 21 (black/white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** An achromatic `l%` grey (what `0 0% 98%` means) as 0-255 channels. */
function greyFromLightness(lightnessPercent: number): Rgb {
  const v = (lightnessPercent / 100) * 255;
  return { r: v, g: v, b: v };
}

const FOREGROUND_CANDIDATES = [
  { hsl: FOREGROUND_LIGHT, rgb: greyFromLightness(98) },
  { hsl: FOREGROUND_DARK, rgb: greyFromLightness(9) },
] as const;

/**
 * Pick the text colour to put ON TOP of `background`.
 *
 * WHY NOT THE OLD RULE: both copies of this code used
 * `lightness <= 60 ? white : near-black`, plus a hardcoded
 * `color === '#a855f7' -> always white` special case.
 *
 * HSL lightness is not perceived brightness: it weights red, green and blue
 * equally, but the eye is ~10x more sensitive to green than to blue. That makes
 * the 60% threshold wrong in both directions, and it is wrong for shipped
 * presets, not just hypothetical user input:
 *
 *   - Amber `#f59e0b` has HSL lightness 50, so the old rule chose WHITE text.
 *     White on amber measures 2.06:1 — below even the 3:1 large-text floor.
 *     Near-black measures 8.35:1. The old rule shipped unreadable buttons.
 *     Lime, Sky and Cyan were wrong the same way (1.89, 2.65 and 2.32:1).
 *   - Purple `#a855f7` has HSL lightness 65, so the old rule chose near-black,
 *     which the author evidently disliked, hence the `#a855f7` special case.
 *
 * So the special case WAS a workaround for a real bug: the lightness heuristic.
 * The root-cause fix is to compare actual WCAG contrast against the two
 * foregrounds the app owns and take the winner, which is what this does. The
 * hack is therefore gone rather than carried forward.
 *
 * NOTE ON PURPLE, since removing the hack changes what purple looks like:
 * measured against this app's foregrounds, `#a855f7` scores 4.53:1 with
 * near-black and 3.79:1 with near-white, so the contrast-driven answer is
 * near-black — the opposite of what the hack forced. White-on-purple was an
 * aesthetic preference, and it was the less accessible of the two options. If
 * the design ever wants it back, the honest way is a per-preset
 * `foreground` override on `ColorPreset`, not a hex compared with `===`.
 */
export function pickForeground(background: Rgb): { hsl: string; ratio: number } {
  let best: { hsl: string; ratio: number } = { hsl: FOREGROUND_CANDIDATES[0].hsl, ratio: -1 };
  for (const candidate of FOREGROUND_CANDIDATES) {
    const ratio = contrastRatio(background, candidate.rgb);
    if (ratio > best.ratio) best = { hsl: candidate.hsl, ratio };
  }
  return best;
}

/**
 * What the DOM should be told to do for a given stored accent value.
 *
 * `reset` = remove the overrides and let app/globals.css win again ("Default").
 * `set`   = write these exact custom properties.
 *
 * Returning a plain description instead of touching `document` is what makes
 * the whole accent pipeline testable in a `node` environment.
 */
export type AccentApplication =
  | { kind: "reset"; remove: readonly string[] }
  | { kind: "set"; set: Record<string, string>; hex: string; contrast: number };

/**
 * Resolve a stored accent value into the CSS mutation it implies.
 *
 * Returns `null` when `value` is neither `"default"` nor a valid hex. Callers
 * MUST surface that to the user instead of applying nothing quietly — a saved
 * setting that no longer renders is exactly the sort of failure this codebase
 * has been bitten by before.
 */
export function resolveAccent(value: string | null | undefined): AccentApplication | null {
  if (typeof value === "string" && value.trim().toLowerCase() === DEFAULT_ACCENT) {
    return { kind: "reset", remove: ACCENT_CSS_PROPERTIES };
  }

  const hex = normalizeHex(value);
  if (hex === null) return null;

  const hsl = hexToHsl(hex);
  const rgb = hexToRgb(hex);
  // Both are non-null because `hex` normalized; the guard is for the type system
  // and for anyone who edits `normalizeHex` later.
  if (hsl === null || rgb === null) return null;

  const foreground = pickForeground(rgb);
  return {
    kind: "set",
    hex,
    contrast: foreground.ratio,
    set: {
      "--primary": hsl.hsl,
      // The accent doubles as the first chart series so a chart and a button
      // agree about what "primary" looks like.
      "--chart-1": hsl.hsl,
      "--primary-foreground": foreground.hsl,
    },
  };
}

/**
 * Human-readable label for a value, used by the picker's trigger.
 * Falls back to the canonical hex, or to the raw value if it is a sentinel.
 */
export function describeColor(value: string, presets: readonly ColorPreset[]): string {
  const match = findPreset(value, presets);
  if (match) return match.name;
  return normalizeHex(value) ?? value;
}

/**
 * Find the preset a value corresponds to. Hex presets match case-insensitively
 * and across the `#abc` / `#aabbcc` spellings; sentinel presets match exactly
 * (after trimming), so `"default"` and `"DEFAULT"` are the same option.
 */
export function findPreset(
  value: string | null | undefined,
  presets: readonly ColorPreset[],
): ColorPreset | undefined {
  if (typeof value !== "string") return undefined;
  const hex = normalizeHex(value);
  const raw = value.trim().toLowerCase();

  return presets.find((preset) => {
    const presetHex = normalizeHex(preset.value);
    if (presetHex !== null && hex !== null) return presetHex === hex;
    return preset.value.trim().toLowerCase() === raw;
  });
}

/**
 * The message shown under the hex field. `null` means "nothing is wrong".
 *
 * An empty draft is not an error (the user just cleared the box to retype); it
 * is simply not committable, which `isValidHex` already reports.
 */
export function hexInputError(draft: string): string | null {
  if (draft.trim().length === 0) return null;
  if (isValidHex(draft)) return null;
  return "Enter a color as #rgb or #rrggbb, for example #0ea5e9.";
}

/**
 * Move focus inside the swatch grid.
 *
 * Extracted from the component because "does Home wrap to the last row?" is a
 * pure question about integers and should not need a browser to answer. Returns
 * the index the caller should focus, or `null` if the key is not a navigation
 * key and the event should be left alone.
 *
 * The grid wraps in both directions: pressing Left on the first swatch lands on
 * the last one, and Down from the bottom row wraps to the top of the same
 * column (clamped to the last item when that column is short).
 */
export function nextSwatchIndex(
  key: string,
  currentIndex: number,
  count: number,
  columns: number,
): number | null {
  if (count <= 0) return null;
  const cols = Math.max(1, columns);

  switch (key) {
    case "ArrowRight":
      return (currentIndex + 1) % count;
    case "ArrowLeft":
      return (currentIndex - 1 + count) % count;
    case "ArrowDown": {
      const next = currentIndex + cols;
      return next < count ? next : currentIndex % cols;
    }
    case "ArrowUp": {
      const previous = currentIndex - cols;
      if (previous >= 0) return previous;
      // Jump to the bottom-most swatch in this column.
      const column = currentIndex % cols;
      const rows = Math.ceil(count / cols);
      for (let row = rows - 1; row >= 0; row--) {
        const candidate = row * cols + column;
        if (candidate < count) return candidate;
      }
      return currentIndex;
    }
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
