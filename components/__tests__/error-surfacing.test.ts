/**
 * Guard for item 5: every dialog reported success on failure.
 *
 * The server actions in this app never throw on a rejected write — they RETURN
 * `{ error: "..." }`. Each dialog called the action, ignored the return value,
 * and then ran `onSuccess(); onOpenChange(false)`, so a duplicate category name,
 * a refused Cash asset or a failed live-price fetch was indistinguishable from a
 * successful save.
 *
 * A unit test cannot render these components (there is no jsdom in this repo), so
 * this file asserts the *shape* of the code instead: every call site must inspect
 * the result, and every component must be able to render it. That is a cheap,
 * durable guard against the exact regression — the same technique
 * app/actions/__tests__/money-boundaries.test.ts uses for money.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(PROJECT_ROOT, rel), "utf-8");

/** Files that call a server action and must surface its `{ error }`. */
const ERROR_AWARE = [
  "components/transactions/transaction-dialog.tsx",
  "components/transactions/import-dialog.tsx",
  "components/assets/asset-dialog.tsx",
  "components/budgets/budget-dialog.tsx",
  "components/settings/quick-commands-manager.tsx",
  "app/(dashboard)/page.tsx",
  "app/(dashboard)/budgets/budgets-client.tsx",
  "app/(dashboard)/transactions/page.tsx",
  "app/(dashboard)/settings/page.tsx",
];

describe("every dialog inspects the action result", () => {
  for (const file of ERROR_AWARE) {
    it(`${file} checks for an error in the returned value`, () => {
      const source = read(file);
      expect(source).toMatch(/"error"\s+in\s+\w+/);
    });

    it(`${file} keeps the failure in component state`, () => {
      const source = source_of(file);
      expect(source).toMatch(/set(Delete|Action)?Error\(/);
    });

    it(`${file} renders the failure`, () => {
      const source = source_of(file);
      // An accessible alert region carrying the message.
      expect(source).toMatch(/role="alert"/);
    });
  }
});

function source_of(file: string) {
  return read(file);
}

/** Remove /* … *​/ and // comments so prose about a removed idiom is not a hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
}

describe("no dialog closes unconditionally after a write", () => {
  const CLOSERS: Array<[string, RegExp]> = [
    ["components/transactions/transaction-dialog.tsx", /createTransaction|updateTransaction/],
    ["components/assets/asset-dialog.tsx", /createAsset|updateAsset/],
    ["components/budgets/budget-dialog.tsx", /createCategory|updateCategory/],
  ];

  for (const [file, action] of CLOSERS) {
    it(`${file} returns early instead of calling onSuccess() on failure`, () => {
      const source = read(file);
      expect(source).toMatch(action);
      // The early return must appear BEFORE onSuccess() in the submit handler.
      const guard = source.indexOf('"error" in result');
      const success = source.indexOf("onSuccess();");
      expect(guard).toBeGreaterThan(-1);
      expect(success).toBeGreaterThan(guard);
    });
  }
});

describe("the Add Asset dialog cannot default to a category the server rejects", () => {
  const source = read("components/assets/asset-dialog.tsx");

  it("does not offer Cash at all — it is derived from the ledger", () => {
    const list = /const ASSET_TYPES = \[([^\]]*)\]/.exec(source);
    expect(list).not.toBeNull();
    expect(list![1]).not.toMatch(/"Cash"/);
  });

  it("defaults to a category the server accepts", () => {
    expect(source).toMatch(/const DEFAULT_ASSET_TYPE = "Savings"/);
    expect(source).toMatch(/category: DEFAULT_ASSET_TYPE/);
    // The old default was the one value createAsset ALWAYS rejects.
    expect(source).not.toMatch(/category:\s*"Cash"/);
  });
});

describe("the import dialog no longer writes one row at a time", () => {
  const source = read("components/transactions/import-dialog.tsx");

  it("calls the batch action, not the single-row one", () => {
    expect(source).toMatch(/importTransactions/);
    expect(source).not.toMatch(/createTransaction/);
  });

  it("does not build a date with toISOString()", () => {
    expect(source).not.toMatch(/toISOString\(\)/);
  });

  it("exposes an explicit day-first control", () => {
    expect(source).toMatch(/Day first \(DD\/MM\/YYYY\)/);
    expect(source).toMatch(/detectDateOrder/);
  });
});

describe("no calendar day is serialized through UTC", () => {
  const DATE_WRITERS = [
    "components/transactions/transaction-dialog.tsx",
    "components/transactions/import-dialog.tsx",
    "components/transactions/import-logic.ts",
    "components/dashboard/cash-series.ts",
    "app/(dashboard)/page.tsx",
  ];

  for (const file of DATE_WRITERS) {
    it(`${file} contains no toISOString() outside comments`, () => {
      // The comments in these files deliberately NAME the removed idiom to
      // explain the bug, so they are stripped before matching.
      expect(stripComments(read(file))).not.toMatch(/toISOString\(\)/);
    });
  }

  it("the transaction dialog serializes the date through lib/dates", () => {
    const source = read("components/transactions/transaction-dialog.tsx");
    expect(source).toMatch(/toTransactionFormData/);
  });
});
