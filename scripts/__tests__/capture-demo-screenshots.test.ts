import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  assertTravelGlobePaint,
  buildIsolatedAppEnvironment,
  expectedShowcaseRelativePaths,
  handleWaiter,
  initialThemeForCapture,
  isOwnedShowcaseDirectory,
  parseCaptureArgs,
  publishCapturedPages,
  resolveScreenshotOutput,
  SHOWCASE_PAGES,
  SHOWCASE_NOW_ISO,
  SHOWCASE_THEMES,
  themeBootValues,
  TRAVEL_GLOBE_PATH,
} from "../capture-demo-screenshots";

async function syntheticTravelScreenshot(
  theme: "light" | "dark",
  filled: boolean,
): Promise<Buffer> {
  const width = 1728;
  const height = 1080;
  const channels = 3;
  const background = theme === "light" ? 255 : 9;
  const foreground = theme === "light" ? 160 : 64;
  const pixels = Buffer.alloc(width * height * channels, background);
  if (filled) {
    for (let y = 250; y < 450; y += 1) {
      for (let x = 600; x < 800; x += 1) {
        const offset = (y * width + x) * channels;
        pixels.fill(foreground, offset, offset + channels);
      }
    }
  }
  return await sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}

describe("capture-demo-screenshots safety contract", () => {
  it("requires the explicit public showcase output directory", () => {
    expect(() => parseCaptureArgs([])).toThrow(/explicit --output-dir/);
    expect(parseCaptureArgs(["--output-dir", "docs/images"])).toEqual({
      outputDirectory: "docs/images",
    });
    expect(resolveScreenshotOutput("docs/images")).toBe(
      path.resolve(process.cwd(), "docs", "images"),
    );
    expect(() => resolveScreenshotOutput("data")).toThrow(/only be written/);
    expect(() => resolveScreenshotOutput(os.tmpdir())).toThrow(/only be written/);
  });

  it("passes one exact database path to both database configuration variables", () => {
    const databasePath = path.join(os.tmpdir(), "localfi-test-fictional.db");
    const environment = buildIsolatedAppEnvironment(databasePath, 41337);
    expect(environment).toMatchObject({
      NODE_ENV: "production",
      BUDGET_DB_PATH: databasePath,
      DATABASE_URL: `file:${databasePath}`,
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:41337",
      HOSTNAME: "127.0.0.1",
      PORT: "41337",
      LOCALFI_TODAY_KEY: "2026-08-15",
    });
    expect(SHOWCASE_NOW_ISO).toBe("2026-08-15T12:00:00.000Z");
  });

  it("routes the dashboard comparison through the same fixed date contract", () => {
    const dashboardSource = readFileSync(
      path.join(process.cwd(), "app", "(dashboard)", "page.tsx"),
      "utf8",
    );
    expect(dashboardSource).toContain("fromDateKey(todayKey())");
    expect(dashboardSource).not.toMatch(/computeCashGrowth\([\s\S]*?new Date\(\)/);
  });

  it("recognizes only its direct, prefixed temporary directories as removable", () => {
    const owned = path.join(os.tmpdir(), "localfi-showcase-abc123");
    expect(isOwnedShowcaseDirectory(owned)).toBe(true);
    expect(isOwnedShowcaseDirectory(os.tmpdir())).toBe(false);
    expect(isOwnedShowcaseDirectory(path.join(os.tmpdir(), "other-abc123"))).toBe(false);
    expect(isOwnedShowcaseDirectory(path.join(owned, "nested"))).toBe(false);
  });

  it("covers each public feature promised by the README gallery", () => {
    expect(SHOWCASE_PAGES.map((page) => page.path)).toEqual([
      "/",
      "/accounts",
      "/transactions",
      "/budgets",
      "/reports",
      "/ledger",
      "/travel",
    ]);
    expect(new Set(SHOWCASE_PAGES.map((page) => page.filename)).size).toBe(7);
    expect(SHOWCASE_THEMES).toEqual(["light", "dark"]);
    expect(SHOWCASE_THEMES.flatMap((theme) =>
      SHOWCASE_PAGES.map((page) => `${theme}/${page.filename}`),
    )).toHaveLength(14);
    expect(expectedShowcaseRelativePaths()).toHaveLength(14);
  });

  it("boots in the opposite theme, then uses the UI toggle to reach the target", () => {
    expect(initialThemeForCapture("light")).toBe("dark");
    expect(initialThemeForCapture("dark")).toBe("light");
    expect(themeBootValues("light")).toEqual({
      theme: "light",
      "localfi-privacy-mode": "false",
    });
    expect(themeBootValues("dark")).toEqual({
      theme: "dark",
      "localfi-privacy-mode": "false",
    });
  });

  it("waits for the exact public profile and rejects the retired surname", () => {
    const source = readFileSync(
      path.join(process.cwd(), "scripts", "capture-demo-screenshots.ts"),
      "utf8",
    );
    expect(source).toContain('getByText("Khalil", { exact: true })');
    expect(source).not.toContain('getByText("Khalil Mansour"');
    expect(source).toMatch(/Demo\|Fictional\|Fixture\|Mansour/);
  });

  it("fails closed when the same-origin Travel globe is blank", async () => {
    expect(TRAVEL_GLOBE_PATH).toBe(
      "/maps/natural-earth-countries-110m-v5.1.2.geojson",
    );
    await expect(
      assertTravelGlobePaint(await syntheticTravelScreenshot("light", false), "light"),
    ).rejects.toThrow(/globe is blank/);
    await expect(
      assertTravelGlobePaint(await syntheticTravelScreenshot("dark", false), "dark"),
    ).rejects.toThrow(/globe is blank/);
    await expect(
      assertTravelGlobePaint(await syntheticTravelScreenshot("light", true), "light"),
    ).resolves.toBeUndefined();
    await expect(
      assertTravelGlobePaint(await syntheticTravelScreenshot("dark", true), "dark"),
    ).resolves.toBeUndefined();
  });

  it("handles a response waiter rejection immediately so failure cleanup can drain it", async () => {
    const failure = new Error("navigation failed before geography loaded");
    await expect(handleWaiter(Promise.reject(failure))).resolves.toEqual({
      ok: false,
      error: failure,
    });
  });

  it("rolls every published image back when replacement fails partway through", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "localfi-publish-test-"));
    const staging = path.join(root, "staging");
    const output = path.join(root, "output");
    try {
      for (const relativePath of expectedShowcaseRelativePaths()) {
        mkdirSync(path.dirname(path.join(staging, relativePath)), { recursive: true });
        mkdirSync(path.dirname(path.join(output, relativePath)), { recursive: true });
        writeFileSync(path.join(staging, relativePath), `new:${relativePath}`);
        writeFileSync(path.join(output, relativePath), `old:${relativePath}`);
      }

      expect(() =>
        publishCapturedPages(staging, output, {
          beforeReplace: (_relativePath, index) => {
            if (index === 3) throw new Error("simulated publication failure");
          },
        }),
      ).toThrow(/simulated publication failure/);

      for (const relativePath of expectedShowcaseRelativePaths()) {
        expect(readFileSync(path.join(output, relativePath), "utf8")).toBe(`old:${relativePath}`);
      }
      expect(readdirSync(output).some((entry) => entry.startsWith(".localfi-publish-"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects destination symlinks without following them", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "localfi-publish-test-"));
    const staging = path.join(root, "staging");
    const output = path.join(root, "output");
    const outside = path.join(root, "outside.txt");
    try {
      for (const relativePath of expectedShowcaseRelativePaths()) {
        mkdirSync(path.dirname(path.join(staging, relativePath)), { recursive: true });
        writeFileSync(path.join(staging, relativePath), `new:${relativePath}`);
      }
      const linkedRelativePath = expectedShowcaseRelativePaths()[0];
      const linkedDestination = path.join(output, linkedRelativePath);
      mkdirSync(path.dirname(linkedDestination), { recursive: true });
      writeFileSync(outside, "private sentinel");
      symlinkSync(outside, linkedDestination);

      expect(() => publishCapturedPages(staging, output)).toThrow(/Unsafe existing/);
      expect(readFileSync(outside, "utf8")).toBe("private sentinel");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
