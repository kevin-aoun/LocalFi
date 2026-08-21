import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createExportConfirmationGate,
  exportDisclosureCopy,
} from "../export-disclosure-logic";

const ROOT = process.cwd();

describe("export disclosure copy", () => {
  it("identifies CSV as Excel-readable plaintext outside the vault", () => {
    const copy = exportDisclosureCopy("csv");
    expect(`${copy.title} ${copy.description}`).toMatch(/plaintext/i);
    expect(copy.description).toMatch(/Excel/i);
    expect(copy.description).toMatch(/outside LocalFi vault protection/i);
  });

  it("identifies JSON as plaintext outside the vault", () => {
    const copy = exportDisclosureCopy("json");
    expect(`${copy.title} ${copy.description}`).toMatch(/plaintext/i);
    expect(copy.description).toMatch(/outside LocalFi vault protection/i);
    expect(copy.description).toMatch(/not a restorable vault backup/i);
  });

  it("identifies a database copy as encrypted but sensitive", () => {
    const copy = exportDisclosureCopy("database");
    expect(`${copy.title} ${copy.description}`).toMatch(/encrypted/i);
    expect(copy.description).toMatch(/sensitive financial data/i);
  });
});

describe("export confirmation gate", () => {
  it("invokes a confirmed builder exactly once while it is active", async () => {
    let release: (() => void) | undefined;
    const builder = vi.fn(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const confirm = createExportConfirmationGate();

    const first = confirm(builder);
    const second = confirm(builder);
    await vi.waitFor(() => expect(builder).toHaveBeenCalledOnce());
    release?.();
    await Promise.all([first, second]);
    expect(builder).toHaveBeenCalledOnce();
  });

  it("permits a new confirmation after the previous one settles", async () => {
    const builder = vi.fn(async () => undefined);
    const confirm = createExportConfirmationGate();

    await confirm(builder);
    await confirm(builder);
    expect(builder).toHaveBeenCalledTimes(2);
  });
});

describe("reports export wiring", () => {
  it("routes all three exports through the reusable accessible disclosure", () => {
    const card = readFileSync(path.join(ROOT, "components/reports/export-card.tsx"), "utf8");
    const dialog = readFileSync(path.join(ROOT, "components/exports/export-disclosure.tsx"), "utf8");

    expect(card.match(/<ExportDisclosure format=/g)).toHaveLength(3);
    expect(card).toContain('format="csv" onConfirm={handleCsv}');
    expect(card).toContain('format="json" onConfirm={handleJson}');
    expect(card).toContain('format="database" onConfirm={handleDatabase}');
    expect(card).not.toMatch(/<Button[^>]+onClick=\{handle(?:Csv|Json|Database)\}/);

    expect(dialog).toContain("AlertDialogTrigger asChild");
    expect(dialog).toContain("<AlertDialogTitle>");
    expect(dialog).toContain("<AlertDialogDescription>");
    expect(dialog).toContain("<AlertDialogCancel");
    expect(dialog).toContain("<AlertDialogAction");
    expect(dialog).not.toMatch(/localStorage|sessionStorage|do not ask/i);

    for (const [handler, builder] of [
      ["handleCsv", "exportTransactionsCsv"],
      ["handleJson", "exportJsonBackup"],
      ["handleDatabase", "exportDatabaseFile"],
    ]) {
      const start = card.indexOf(`const ${handler} = async`);
      const end = card.indexOf("\n  };", start);
      const body = card.slice(start, end);
      expect(body.indexOf(builder)).toBeGreaterThan(0);
      expect(body.indexOf("new Blob")).toBeGreaterThan(body.indexOf(builder));
    }
  });
});
