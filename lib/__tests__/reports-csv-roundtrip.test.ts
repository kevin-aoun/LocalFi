/**
 * CSV export -> the app's OWN importer -> back to transactions.
 *
 * WHY THIS TEST IS THE POINT OF THE EXPORT: an export that the app cannot read
 * back is not a backup, it is a screenshot. So this does not check the CSV
 * against a hand-written expectation — it feeds the exported bytes through
 * `components/transactions/import-logic.ts` (the real import path, SheetJS and
 * all) and asserts that the DATE, the CATEGORY and the AMOUNT come back exactly.
 *
 * Timezone safety: every date is a literal 'YYYY-MM-DD' key on both sides, and
 * SheetJS's date cells go through `parseFlexibleDate` / `parseExcelSerial`, which
 * build local dates. Nothing here touches `toISOString()`, so this passes at
 * UTC+14 and UTC-11.
 */
import { describe, expect, it } from "vitest";

import {
  collectDateValues,
  detectDateOrder,
  isCsvFilename,
  isImportable,
  parseImportRows,
  readCsvRows,
  readSpreadsheetRows,
  type ImportCategory,
} from "@/components/transactions/import-logic";
import { parseAmount } from "@/lib/money";
import {
  buildTransactionsCsv,
  centsToDecimalString,
  type CsvTransactionRow,
} from "@/lib/reports";

const CATEGORIES: ImportCategory[] = [
  { id: 1, name: "Salary", type: "Income" },
  { id: 2, name: "Groceries", type: "Expense" },
  { id: 3, name: "Rent", type: "Expense" },
  { id: 4, name: "Brokerage", type: "Investment" },
];

/** Deliberately awkward amounts: sub-cent boundaries, grouping, a big number. */
const EXPORTED: CsvTransactionRow[] = [
  {
    dateKey: "2026-01-31",
    categoryName: "Salary",
    categoryType: "Income",
    amountCents: 512_345,
    description: "January pay",
    accountName: "Checking",
    pending: false,
    transferAccountName: null,
    currency: "USD",
  },
  {
    dateKey: "2026-02-01",
    categoryName: "Groceries",
    categoryType: "Expense",
    amountCents: 4_550,
    description: 'Coffee, "black"',
    accountName: "Checking",
    pending: false,
    transferAccountName: null,
    currency: "USD",
  },
  {
    dateKey: "2026-02-28",
    categoryName: "Rent",
    categoryType: "Expense",
    amountCents: 150_000,
    description: "",
    accountName: "Checking",
    pending: false,
    transferAccountName: null,
    currency: "USD",
  },
  {
    dateKey: "2026-12-25",
    categoryName: "Groceries",
    categoryType: "Expense",
    amountCents: 1,
    description: "One cent",
    accountName: "Checking",
    pending: false,
    transferAccountName: null,
    currency: "USD",
  },
  {
    dateKey: "2024-02-29",
    categoryName: "Brokerage",
    categoryType: "Investment",
    amountCents: 1_234_567_89,
    description: "Leap-day top-up",
    accountName: "Checking",
    pending: false,
    transferAccountName: null,
    currency: "USD",
  },
];

/**
 * The EXACT path the import dialog takes for a `.csv` file: `readCsvRows` on the
 * decoded text (which strips our BOM), then the same `parseImportRows` every
 * other format goes through.
 */
function importBack(csv: string) {
  const rows = readCsvRows(csv);
  const detection = detectDateOrder(collectDateValues(rows));
  // Exported dates are ISO, i.e. never ambiguous — so the importer has nothing to
  // guess and `dayFirst` cannot change the outcome. Asserted below.
  return { rows, detection, parsed: parseImportRows(rows, CATEGORIES, { dayFirst: false }) };
}

describe("CSV export -> import round-trip", () => {
  const csv = buildTransactionsCsv(EXPORTED);

  it("SheetJS reads the exported file at all", () => {
    const { rows } = importBack(csv);
    expect(rows).toHaveLength(EXPORTED.length);
  });

  it("every exported row is importable — no unknown category, no unreadable date", () => {
    const { parsed } = importBack(csv);
    for (const row of parsed) {
      expect(row.problems).toEqual([]);
      expect(isImportable(row)).toBe(true);
    }
  });

  it("preserves the DATE exactly", () => {
    const { parsed } = importBack(csv);
    expect(parsed.map((r) => r.date)).toEqual(EXPORTED.map((r) => r.dateKey));
  });

  it("preserves the CATEGORY exactly", () => {
    const { parsed } = importBack(csv);
    expect(parsed.map((r) => r.categoryId)).toEqual([1, 2, 3, 2, 4]);
    expect(parsed.map((r) => r.categoryName)).toEqual(EXPORTED.map((r) => r.categoryName));
    expect(parsed.map((r) => r.suggestedType)).toEqual(EXPORTED.map((r) => r.categoryType));
  });

  it("preserves the AMOUNT exactly, to the cent", () => {
    const { parsed } = importBack(csv);
    expect(parsed.map((r) => r.amountCents)).toEqual(EXPORTED.map((r) => r.amountCents));
  });

  it("preserves a description containing a comma and a quote", () => {
    const { parsed } = importBack(csv);
    expect(parsed[1].comment).toBe('Coffee, "black"');
  });

  it("exports unambiguous dates, so the importer never has to guess D/M vs M/D", () => {
    const { detection, parsed } = importBack(csv);
    expect(detection.evidence).not.toBe("conflict");
    // Flipping the toggle must not move a single day.
    const dayFirst = parseImportRows(readCsvRows(csv), CATEGORIES, { dayFirst: true });
    expect(dayFirst.map((r) => r.date)).toEqual(parsed.map((r) => r.date));
  });

  it("the exported filename is recognised as CSV by the dialog", () => {
    expect(isCsvFilename("budget-transactions-2026-01-01_2026-12-31.csv")).toBe(true);
  });

  it("also survives the binary sniffing reader, in case the file is dropped as bytes", () => {
    const parsed = parseImportRows(
      readSpreadsheetRows(Buffer.from(csv, "utf-8")),
      CATEGORIES,
      { dayFirst: false },
    );
    expect(parsed.map((r) => r.date)).toEqual(EXPORTED.map((r) => r.dateKey));
    expect(parsed.map((r) => r.amountCents)).toEqual(EXPORTED.map((r) => r.amountCents));
  });

  it("round-trips the decimal string through parseAmount with no drift", () => {
    for (const row of EXPORTED) {
      expect(parseAmount(centsToDecimalString(row.amountCents))).toBe(row.amountCents);
    }
    // The classic float traps, both directions.
    for (const cents of [1, 5, 10, 267, 268, 4_550, 100_500, 999_999_999]) {
      expect(parseAmount(centsToDecimalString(cents))).toBe(cents);
    }
  });

  it("survives a second round-trip (export -> import -> export)", () => {
    const { parsed } = importBack(csv);
    const again = buildTransactionsCsv(
      parsed.map((row, i) => ({
        dateKey: row.date as string,
        categoryName: row.categoryName,
        categoryType: row.suggestedType,
        amountCents: row.amountCents,
        description: row.comment,
        accountName: EXPORTED[i].accountName,
        pending: false,
        transferAccountName: null,
        currency: "USD",
      })),
    );
    expect(again).toBe(csv);
  });
});
