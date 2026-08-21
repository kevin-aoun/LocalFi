import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";

import { DEMO_ANCHOR_DATE } from "../lib/db/demo-data";

const REPOSITORY_ROOT = path.resolve(process.cwd());
const CHROME_PATH = "/usr/bin/google-chrome";
const TEMP_PREFIX = "localfi-showcase-";
const VIEWPORT = { width: 1728, height: 1080 } as const;
export const TRAVEL_GLOBE_PATH = "/maps/natural-earth-countries-110m-v5.1.2.geojson";
const TRAVEL_GLOBE_REGION = { left: 420, top: 150, width: 850, height: 800 } as const;
const MINIMUM_TRAVEL_GLOBE_PIXELS = 20_000;
export const SHOWCASE_NOW_ISO = `${DEMO_ANCHOR_DATE}T12:00:00.000Z`;

export const SHOWCASE_PAGES = [
  {
    path: "/",
    heading: /Welcome back/i,
    readyText: "Net worth over time",
    filename: "dashboard.png",
  },
  {
    path: "/accounts",
    heading: "Accounts",
    readyText: "Net-worth history",
    filename: "accounts.png",
  },
  {
    path: "/transactions",
    heading: "Transactions",
    readyText: "$17.50",
    filename: "transactions.png",
  },
  {
    path: "/budgets",
    heading: /Categories & Budgets/i,
    readyText: "Spent against limits",
    filename: "budgets.png",
  },
  {
    path: "/reports",
    heading: "Reports",
    readyText: "Cash flow statement",
    filename: "reports.png",
  },
  {
    path: "/ledger",
    heading: /Ledger/i,
    readyText: "Corniche coffee and kaak",
    filename: "ledger.png",
  },
  {
    path: "/travel",
    heading: "Travel Map",
    readyText: "Itinerary",
    filename: "travel.png",
  },
] as const;

export const SHOWCASE_THEMES = ["light", "dark"] as const;
export type ShowcaseTheme = (typeof SHOWCASE_THEMES)[number];

export function expectedShowcaseRelativePaths(): string[] {
  return SHOWCASE_THEMES.flatMap((theme) =>
    SHOWCASE_PAGES.map((showcase) => path.join(theme, showcase.filename)),
  );
}

export class DemoScreenshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoScreenshotError";
  }
}

export type CaptureDemoOptions = {
  outputDirectory: string;
};

export type HandledWaiterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export function handleWaiter<T>(waiter: Promise<T>): Promise<HandledWaiterResult<T>> {
  return waiter.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

export function parseCaptureArgs(args: readonly string[]): CaptureDemoOptions | { help: true } {
  let outputDirectory: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--output-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new DemoScreenshotError("--output-dir requires an explicit path");
      }
      if (outputDirectory !== null) {
        throw new DemoScreenshotError("--output-dir may be supplied only once");
      }
      outputDirectory = value;
      index += 1;
      continue;
    }
    throw new DemoScreenshotError(`Unknown screenshot argument: ${argument}`);
  }
  if (outputDirectory === null) {
    throw new DemoScreenshotError("An explicit --output-dir path is required");
  }
  return { outputDirectory };
}

export function resolveScreenshotOutput(outputDirectory: string): string {
  if (typeof outputDirectory !== "string" || outputDirectory.trim() === "") {
    throw new DemoScreenshotError("An explicit --output-dir path is required");
  }
  if (outputDirectory.includes("\0")) {
    throw new DemoScreenshotError("The screenshot output path contains an invalid null byte");
  }
  const output = path.resolve(REPOSITORY_ROOT, outputDirectory.trim());
  const publicImages = path.join(REPOSITORY_ROOT, "docs", "images");
  if (output !== publicImages) {
    throw new DemoScreenshotError(
      `Screenshots may only be written to the repository showcase directory: ${publicImages}`,
    );
  }
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) {
    throw new DemoScreenshotError("The repository showcase directory may not be a symbolic link");
  }
  return output;
}

export function buildIsolatedAppEnvironment(
  databasePath: string,
  port: number,
): NodeJS.ProcessEnv {
  const absoluteDatabasePath = path.resolve(databasePath);
  return {
    ...process.env,
    NODE_ENV: "production",
    BUDGET_DB_PATH: absoluteDatabasePath,
    DATABASE_URL: `file:${absoluteDatabasePath}`,
    NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    LOCALFI_TODAY_KEY: DEMO_ANCHOR_DATE,
  };
}

export function themeBootValues(theme: ShowcaseTheme): Record<string, string> {
  return { theme, "localfi-privacy-mode": "false" };
}

export function initialThemeForCapture(theme: ShowcaseTheme): ShowcaseTheme {
  return theme === "light" ? "dark" : "light";
}

export function isOwnedShowcaseDirectory(directory: string): boolean {
  const absolute = path.resolve(directory);
  const parent = path.dirname(absolute);
  if (!existsSync(parent)) return false;
  const temporaryRoot = realpathSync(os.tmpdir());
  return (
    realpathSync(parent) === temporaryRoot &&
    path.basename(absolute).startsWith(TEMP_PREFIX)
  );
}

function removeOwnedShowcaseDirectory(directory: string): void {
  if (!isOwnedShowcaseDirectory(directory)) {
    throw new DemoScreenshotError(`Refusing to remove a directory not owned by this run: ${directory}`);
  }
  rmSync(directory, { recursive: true, force: true });
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: REPOSITORY_ROOT,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-8_000);
    });
    child.stderr?.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-8_000);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new DemoScreenshotError(
            `${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`}):\n${output}`,
          ),
        );
      }
    });
  });
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new DemoScreenshotError("Could not reserve an isolated loopback port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForServer(url: string, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new DemoScreenshotError(`LocalFi exited before it became ready:\n${logs()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // The child is still compiling or binding its loopback listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new DemoScreenshotError(`Timed out waiting for ${url}:\n${logs()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new DemoScreenshotError("LocalFi did not stop; preserving its temporary database");
  }
}

async function preparePage(page: Page, baseUrl: string, theme: ShowcaseTheme): Promise<void> {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === baseUrl) await route.continue();
    else await route.abort("blockedbyclient");
  });
  const initialTheme = initialThemeForCapture(theme);
  await page.clock.setFixedTime(new Date(SHOWCASE_NOW_ISO));
  await page.addInitScript((values) => {
    for (const [key, value] of Object.entries(values)) window.localStorage.setItem(key, value);
  }, themeBootValues(initialTheme));
  await page.emulateMedia({ colorScheme: initialTheme, reducedMotion: "reduce" });
}

async function waitForShowcaseReady(
  page: Page,
  showcase: (typeof SHOWCASE_PAGES)[number],
  theme: ShowcaseTheme,
): Promise<void> {
  await page.getByRole("heading", { name: showcase.heading }).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByText(showcase.readyText, { exact: false }).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByText("Khalil", { exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.waitForFunction(
    (selectedTheme) => document.documentElement.classList.contains(selectedTheme),
    theme,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => (document.querySelector("main h1")?.getBoundingClientRect().left ?? 0) >= 300,
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function countForegroundPixels(
  screenshot: Buffer,
  region: { left: number; top: number; width: number; height: number },
  theme: ShowcaseTheme,
): Promise<number> {
  const { data, info } = await sharp(screenshot)
    .extract(region)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let foreground = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    const luminance = (data[index] + data[index + 1] + data[index + 2]) / 3;
    if (theme === "dark" ? luminance > 120 : luminance < 120) foreground += 1;
  }
  return foreground;
}

export async function travelGlobeCoveragePixels(
  screenshot: Buffer,
  theme: ShowcaseTheme,
): Promise<number> {
  const { data, info } = await sharp(screenshot)
    .extract(TRAVEL_GLOBE_REGION)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let coveredPixels = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    const luminance = (data[index] + data[index + 1] + data[index + 2]) / 3;
    if (theme === "dark" ? luminance > 35 : luminance < 225) coveredPixels += 1;
  }
  return coveredPixels;
}

export async function assertTravelGlobePaint(
  screenshot: Buffer,
  theme: ShowcaseTheme,
): Promise<void> {
  const coveredPixels = await travelGlobeCoveragePixels(screenshot, theme);
  if (coveredPixels < MINIMUM_TRAVEL_GLOBE_PIXELS) {
    throw new DemoScreenshotError(
      `${theme}/travel globe is blank: ${coveredPixels} covered pixels; ` +
        `expected at least ${MINIMUM_TRAVEL_GLOBE_PIXELS}`,
    );
  }
}

async function assertPublicationPaint(
  screenshot: Buffer,
  theme: ShowcaseTheme,
  pagePath: string,
): Promise<void> {
  if (pagePath === "/ledger") return;
  const brandPixels = await countForegroundPixels(
    screenshot,
    { left: 43, top: 12, width: 48, height: 32 },
    theme,
  );
  const misplacedHeadingPixels = await countForegroundPixels(
    screenshot,
    { left: 112, top: 0, width: 175, height: 55 },
    theme,
  );
  if (brandPixels < 100 || misplacedHeadingPixels > 10) {
    throw new DemoScreenshotError(
      `${theme}${pagePath} retained a stale heading paint ` +
        `(brand pixels ${brandPixels}, misplaced heading pixels ${misplacedHeadingPixels})`,
    );
  }
  if (pagePath === "/travel") await assertTravelGlobePaint(screenshot, theme);
}

async function capturePages(
  context: BrowserContext,
  baseUrl: string,
  outputRoot: string,
): Promise<void> {
  for (const theme of SHOWCASE_THEMES) {
    const outputDirectory = path.join(outputRoot, theme);
    mkdirSync(outputDirectory, { recursive: true });
    for (const showcase of SHOWCASE_PAGES) {
      const page = await context.newPage();
      let travelGeographyResponse: Promise<HandledWaiterResult<unknown>> | null = null;
      try {
        await preparePage(page, baseUrl, theme);
        travelGeographyResponse = showcase.path === "/travel"
          ? handleWaiter(page.waitForResponse(
              (response) => {
                const requestUrl = new URL(response.url());
                return requestUrl.pathname === TRAVEL_GLOBE_PATH && response.ok();
              },
              { timeout: 30_000 },
            ))
          : null;
        const response = await page.goto(`${baseUrl}${showcase.path}`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        if (!response?.ok()) {
          throw new DemoScreenshotError(
            `Could not load ${showcase.path}: HTTP ${response?.status() ?? "unknown"}`,
          );
        }
        const geographyResult = await travelGeographyResponse;
        if (geographyResult && !geographyResult.ok) throw geographyResult.error;
        // Chrome can retain the server-rendered heading's initial paint position even after
        // hydration has laid it out correctly. A warm reload after the fully-ready first render
        // gives the software compositor a stable document without mutating the publication DOM.
        const initialTheme = initialThemeForCapture(theme);
        await waitForShowcaseReady(page, showcase, initialTheme);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await waitForShowcaseReady(page, showcase, initialTheme);
        await page.getByRole("button", { name: "Toggle theme" }).click();
        await waitForShowcaseReady(page, showcase, theme);
        if (showcase.path === "/ledger") {
          await page.getByText("Corniche coffee and kaak", { exact: true }).click();
          await page.getByText("$17.50", { exact: false }).first().waitFor({
            state: "visible",
            timeout: 30_000,
          });
        }
        await page.waitForTimeout(300);
        await page.locator("main").evaluate((element) => {
          element.scrollTop = 0;
          element.scrollLeft = 0;
        });
        await page.addStyleTag({
          content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
        });
        await page.waitForFunction(
          () => (document.querySelector("main h1")?.getBoundingClientRect().left ?? 0) >= 300,
          undefined,
          { timeout: 30_000 },
        );
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
        });
        const visibleText = await page.locator("body").innerText();
        if (/\b(?:Demo|Fictional|Fixture|Mansour)\b/i.test(visibleText)) {
          const matches = visibleText
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => /\b(?:Demo|Fictional|Fixture|Mansour)\b/i.test(line));
          throw new DemoScreenshotError(
            `${showcase.path} exposes placeholder fixture language: ${matches.join(" | ")}`,
          );
        }
        let publicationScreenshot: Buffer | null = null;
        for (let paintAttempt = 1; paintAttempt <= 3; paintAttempt += 1) {
          const screenshot = await page.screenshot({ caret: "hide", fullPage: false });
          try {
            await assertPublicationPaint(screenshot, theme, showcase.path);
            publicationScreenshot = screenshot;
            break;
          } catch (error) {
            if (paintAttempt === 3) throw error;
            await page.getByRole("button", { name: "Toggle theme" }).click();
            await waitForShowcaseReady(page, showcase, initialThemeForCapture(theme));
            await page.getByRole("button", { name: "Toggle theme" }).click();
            await waitForShowcaseReady(page, showcase, theme);
          }
        }
        if (!publicationScreenshot) {
          throw new DemoScreenshotError(`Could not produce a publication-safe ${theme}${showcase.path}`);
        }
        writeFileSync(path.join(outputDirectory, showcase.filename), publicationScreenshot);
      } catch (error) {
        const diagnostics = await page.evaluate(() => ({
          bodyText: document.body.innerText.slice(0, 800),
          documentClass: document.documentElement.className,
          headingLeft: document.querySelector("main h1")?.getBoundingClientRect().left ?? null,
        })).catch(() => null);
        const message = error instanceof Error ? error.message : String(error);
        throw new DemoScreenshotError(
          `${theme}${showcase.path} capture failed: ${message}\n` +
            `Page diagnostics: ${JSON.stringify(diagnostics)}`,
        );
      } finally {
        await page.close();
        // Closing rejects any pending Playwright waiter. It was handled at creation time;
        // awaiting its settled wrapper here also drains it on navigation and HTTP failures.
        await travelGeographyResponse;
      }
    }
  }
}

export type PublishCapturedPagesHooks = {
  beforeReplace?: (relativePath: string, index: number) => void;
};

export function publishCapturedPages(
  stagingRoot: string,
  outputRoot: string,
  hooks: PublishCapturedPagesHooks = {},
): void {
  const relativePaths = expectedShowcaseRelativePaths();
  mkdirSync(outputRoot, { recursive: true });
  if (lstatSync(outputRoot).isSymbolicLink() || !lstatSync(outputRoot).isDirectory()) {
    throw new DemoScreenshotError("The showcase output root must be a real directory");
  }

  for (const relativePath of relativePaths) {
    const staged = path.join(stagingRoot, relativePath);
    if (!existsSync(staged) || !lstatSync(staged).isFile() || lstatSync(staged).isSymbolicLink()) {
      throw new DemoScreenshotError(
        `Refusing to publish an incomplete showcase; missing or unsafe ${relativePath}`,
      );
    }
  }

  const publicationRoot = mkdtempSync(path.join(outputRoot, ".localfi-publish-"));
  const backups = new Map<string, string | null>();
  const replaced: string[] = [];
  try {
    for (const [index, relativePath] of relativePaths.entries()) {
      const staged = path.join(stagingRoot, relativePath);
      const destination = path.join(outputRoot, relativePath);
      const destinationDirectory = path.dirname(destination);
      mkdirSync(destinationDirectory, { recursive: true });
      const destinationDirectoryStat = lstatSync(destinationDirectory);
      if (destinationDirectoryStat.isSymbolicLink() || !destinationDirectoryStat.isDirectory()) {
        throw new DemoScreenshotError(`Unsafe showcase destination directory: ${relativePath}`);
      }
      if (existsSync(destination)) {
        const destinationStat = lstatSync(destination);
        if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
          throw new DemoScreenshotError(`Unsafe existing showcase destination: ${relativePath}`);
        }
        const backup = path.join(publicationRoot, "backups", relativePath);
        mkdirSync(path.dirname(backup), { recursive: true });
        copyFileSync(destination, backup);
        backups.set(relativePath, backup);
      } else {
        backups.set(relativePath, null);
      }

      const prepared = path.join(publicationRoot, "prepared", relativePath);
      mkdirSync(path.dirname(prepared), { recursive: true });
      copyFileSync(staged, prepared);

      hooks.beforeReplace?.(relativePath, index);
      renameSync(prepared, destination);
      replaced.push(relativePath);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const relativePath of replaced.reverse()) {
      const destination = path.join(outputRoot, relativePath);
      const backup = backups.get(relativePath);
      try {
        if (backup) renameSync(backup, destination);
        else if (existsSync(destination)) unlinkSync(destination);
      } catch (rollbackError) {
        rollbackErrors.push(
          `${relativePath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    if (rollbackErrors.length > 0) {
      const original = error instanceof Error ? error.message : String(error);
      throw new DemoScreenshotError(
        `${original}\nShowcase rollback also failed:\n${rollbackErrors.join("\n")}`,
      );
    }
    throw error;
  } finally {
    rmSync(publicationRoot, { recursive: true, force: true });
  }
}

export async function captureDemoScreenshots(options: CaptureDemoOptions): Promise<void> {
  const outputDirectory = resolveScreenshotOutput(options.outputDirectory);
  if (!existsSync(CHROME_PATH)) {
    throw new DemoScreenshotError(`System Chrome is required at ${CHROME_PATH}`);
  }

  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  if (!isOwnedShowcaseDirectory(temporaryDirectory)) {
    throw new DemoScreenshotError(`Temporary demo directory failed its ownership check`);
  }
  const databasePath = path.join(temporaryDirectory, "localfi-showcase.db");
  const stagingDirectory = path.join(temporaryDirectory, "publication");
  const port = await reserveLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const isolatedEnvironment = buildIsolatedAppEnvironment(databasePath, port);
  let app: ChildProcess | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let serverLogs = "";
  try {
    await runCommand("bun", ["run", "db:demo", "--", "--output", databasePath]);
    await runCommand("bun", ["run", "ledger:verify"], { env: isolatedEnvironment });
    await runCommand("bun", ["run", "build"], { env: isolatedEnvironment });

    app = spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "start",
        "-H",
        "127.0.0.1",
        "-p",
        String(port),
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: isolatedEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    app.stdout?.on("data", (chunk) => {
      serverLogs = `${serverLogs}${String(chunk)}`.slice(-12_000);
    });
    app.stderr?.on("data", (chunk) => {
      serverLogs = `${serverLogs}${String(chunk)}`.slice(-12_000);
    });
    await waitForServer(baseUrl, app, () => serverLogs);

    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-threaded-animation",
        "--disable-features=PaintHolding",
      ],
    });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
    });
    await capturePages(context, baseUrl, stagingDirectory);
    await context.close();
    publishCapturedPages(stagingDirectory, outputDirectory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DemoScreenshotError(
      serverLogs ? `${message}\n\nLocalFi server output:\n${serverLogs}` : message,
    );
  } finally {
    await browser?.close().catch(() => undefined);
    if (app) await stopChild(app);
    removeOwnedShowcaseDirectory(temporaryDirectory);
  }
}

const usage = `Capture LocalFi's fictional public showcase.

Usage:
  bun run showcase:capture -- --output-dir docs/images

The command creates and verifies a fresh disposable demo database, builds and starts LocalFi in
production on an isolated loopback port, writes 14 light/dark screenshots, and removes only its
own temp data.`;

async function main(): Promise<void> {
  const parsed = parseCaptureArgs(process.argv.slice(2));
  if ("help" in parsed) {
    console.log(usage);
    return;
  }
  await captureDemoScreenshots(parsed);
  console.log(
    JSON.stringify(
      {
        outputDirectory: resolveScreenshotOutput(parsed.outputDirectory),
        viewport: VIEWPORT,
        themes: SHOWCASE_THEMES,
        pages: SHOWCASE_PAGES.map(({ path: pagePath, filename }) => ({ pagePath, filename })),
      },
      null,
      2,
    ),
  );
}

if (/\bcapture-demo-screenshots\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
