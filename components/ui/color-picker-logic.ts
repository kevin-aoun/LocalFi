

export type Rgb = { r: number; g: number; b: number };

export type Hsl = { h: number; s: number; l: number };

export const DEFAULT_ACCENT = "default";

export const FOREGROUND_LIGHT = "0 0% 98%";
export const FOREGROUND_DARK = "0 0% 9%";

export const ACCENT_CSS_PROPERTIES = ["--primary", "--chart-1", "--primary-foreground"] as const;

export type ColorPreset = {

  name: string;

  value: string;

  swatchClassName?: string;
};

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

export function normalizeHex(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;

  const trimmed = input.trim().toLowerCase();
  const body = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;

  if (SHORT_HEX.test(body)) {

    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  if (LONG_HEX.test(body)) return `#${body}`;
  return null;
}


export function isValidHex(input: string | null | undefined): boolean {
  return normalizeHex(input) !== null;
}


export function hexToRgb(input: string | null | undefined): Rgb | null {
  const hex = normalizeHex(input);
  if (hex === null) return null;
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}


export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}


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


function toLinear(channel8Bit: number): number {
  const c = channel8Bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}


export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}


export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}


function greyFromLightness(lightnessPercent: number): Rgb {
  const v = (lightnessPercent / 100) * 255;
  return { r: v, g: v, b: v };
}

const FOREGROUND_CANDIDATES = [
  { hsl: FOREGROUND_LIGHT, rgb: greyFromLightness(98) },
  { hsl: FOREGROUND_DARK, rgb: greyFromLightness(9) },
] as const;


export function pickForeground(background: Rgb): { hsl: string; ratio: number } {
  let best: { hsl: string; ratio: number } = { hsl: FOREGROUND_CANDIDATES[0].hsl, ratio: -1 };
  for (const candidate of FOREGROUND_CANDIDATES) {
    const ratio = contrastRatio(background, candidate.rgb);
    if (ratio > best.ratio) best = { hsl: candidate.hsl, ratio };
  }
  return best;
}


export type AccentApplication =
  | { kind: "reset"; remove: readonly string[] }
  | { kind: "set"; set: Record<string, string>; hex: string; contrast: number };


export function resolveAccent(value: string | null | undefined): AccentApplication | null {
  if (typeof value === "string" && value.trim().toLowerCase() === DEFAULT_ACCENT) {
    return { kind: "reset", remove: ACCENT_CSS_PROPERTIES };
  }

  const hex = normalizeHex(value);
  if (hex === null) return null;

  const hsl = hexToHsl(hex);
  const rgb = hexToRgb(hex);


  if (hsl === null || rgb === null) return null;

  const foreground = pickForeground(rgb);
  return {
    kind: "set",
    hex,
    contrast: foreground.ratio,
    set: {
      "--primary": hsl.hsl,


      "--chart-1": hsl.hsl,
      "--primary-foreground": foreground.hsl,
    },
  };
}


export function describeColor(value: string, presets: readonly ColorPreset[]): string {
  const match = findPreset(value, presets);
  if (match) return match.name;
  return normalizeHex(value) ?? value;
}


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


export function hexInputError(draft: string): string | null {
  if (draft.trim().length === 0) return null;
  if (isValidHex(draft)) return null;
  return "Enter a color as #rgb or #rrggbb, for example #0ea5e9.";
}


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
