
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

function importBack(csv: string) {
  const rows = readCsvRows(csv);
  const detection = detectDateOrder(collectDateValues(rows));

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
