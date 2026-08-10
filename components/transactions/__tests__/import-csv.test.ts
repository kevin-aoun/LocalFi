/**
 * CSV import — held to EXACTLY the same rules as the .xlsx path.
 *
 * Import used to accept Excel only. Adding .csv is only safe if it goes
 * through the same pipeline, because the three bugs that pipeline exists to
 * prevent (see import-logic.ts) are all easy to reintroduce with a second
 * parser:
 *
 *   1. **Sign inversion** — a bank CSV writes an expense as `-45.00`. The stored
 *      amount must be the MAGNITUDE; the category decides the direction.
 *   2. **Ambiguous dates** — `01/02/2026` is 1 February in Beirut and 2 January
 *      in Boston. The explicit `dayFirst` toggle must decide, never the parser.
 *   3. **Duplicate rows** — re-importing the same file must not double the ledger.
 *
 * CSV cells stay as text so no parser can commit to a date order before the
 * explicit `dayFirst` review setting is applied.
 *
 * Must pass under `bun run test:tz` (UTC+14 and UTC-11).
 */
import { describe, expect, it } from "vitest";
import {
  collectDateValues,
  dedupeKey,
  detectDateOrder,
  isCsvFilename,
  parseImportRows,
  planImport,
  readCsvRows,
  type ImportCategory,
} from "../import-logic";

const CATEGORIES: ImportCategory[] = [
  { id: 1, name: "Groceries", type: "Expense" },
  { id: 2, name: "Salary", type: "Income" },
  { id: 3, name: "Brokerage", type: "Investment" },
];

/** Build CSV text from a header row and data rows. */
function csv(header: readonly string[], rows: ReadonlyArray<readonly (string | number)[]>): string {
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
}

/** A signed bank export: expenses negative, income positive. */
const SIGNED_CSV = csv(
  ["Date", "Category", "Amount", "Description"],
  [
    ["2026-07-28", "Groceries", "-45.00", "Spinneys"],
    ["2026-07-29", "Salary", "1200.00", "July pay"],
    ["2026-07-30", "Brokerage", "-250.50", "Monthly buy"],
  ],
);

describe("isCsvFilename", () => {
  it("recognises .csv regardless of case or path", () => {
    expect(isCsvFilename("export.csv")).toBe(true);
    expect(isCsvFilename("EXPORT.CSV")).toBe(true);
    expect(isCsvFilename("statement 2026.csv")).toBe(true);
  });

  it("does not claim spreadsheets or look-alikes", () => {
    expect(isCsvFilename("export.xlsx")).toBe(false);
    expect(isCsvFilename("export.xls")).toBe(false);
    expect(isCsvFilename("csv")).toBe(false);
    expect(isCsvFilename("notes.csv.xlsx")).toBe(false);
    expect(isCsvFilename("")).toBe(false);
  });
});

describe("readCsvRows keeps cells raw, so our date/amount rules stay in charge", () => {
  it("does not pre-parse an ambiguous date into a serial", () => {
    const rows = readCsvRows(csv(["Date", "Category", "Amount"], [["01/02/2026", "Groceries", "1"]]));
    expect(rows[0].Date).toBe("01/02/2026");
    expect(typeof rows[0].Date).toBe("string");
  });

  it("does not attach a spurious time-of-day to an ISO date", () => {
    // Without raw, ISO dates come back as fractional serials (e.g. 46085.0833),
    // which floor to the PREVIOUS day in some timezones.
    const text = csv(["Date", "Category", "Amount"], [["2026-03-04", "Groceries", "1"]]);
    expect(readCsvRows(text)[0].Date).toBe("2026-03-04");
    const value = readCsvRows(text)[0].Date;
    expect(typeof value === "number" && !Number.isInteger(value)).toBe(false);
  });

  it("keeps the amount as written so parseAmount, not the parser, reads it", () => {
    const rows = readCsvRows(csv(["Date", "Category", "Amount"], [["2026-07-28", "Groceries", "-45.00"]]));
    expect(rows[0].Amount).toBe("-45.00");
  });
});

describe("CSV reads as tolerantly as a real bank export requires", () => {
  it("handles CRLF line endings", () => {
    const rows = readCsvRows("Date,Category,Amount\r\n2026-07-28,Groceries,-45.00\r\n");
    expect(rows).toHaveLength(1);
    expect(rows[0].Category).toBe("Groceries");
  });

  it("strips a UTF-8 BOM instead of corrupting the first column name", () => {
    const rows = readCsvRows("﻿Date,Category,Amount\n2026-07-28,Groceries,-45.00\n");
    const parsed = parseImportRows(rows, CATEGORIES, { dayFirst: false });
    // If the BOM survived, the Date column would not be found at all.
    expect(parsed[0].date).toBe("2026-07-28");
    expect(parsed[0].problems).toEqual([]);
  });

  it("handles a semicolon-delimited export", () => {
    const rows = readCsvRows("Date;Category;Amount;Description\n2026-07-28;Groceries;-45.00;Spinneys\n");
    expect(rows[0].Category).toBe("Groceries");
    expect(rows[0].Amount).toBe("-45.00");
  });

  it("handles quoted fields containing the delimiter", () => {
    const rows = readCsvRows('Date,Category,Amount,Description\n2026-07-28,Groceries,-45.00,"Spinneys, Achrafieh"\n');
    expect(rows[0].Description).toBe("Spinneys, Achrafieh");
  });

  it("returns no rows for an empty or header-only file", () => {
    expect(readCsvRows("")).toEqual([]);
    expect(readCsvRows("Date,Category,Amount\n")).toEqual([]);
  });
});

describe("THE SIGN RULE is identical for CSV", () => {
  it("stores magnitudes, so a signed export does not invert the ledger", () => {
    const rows = parseImportRows(readCsvRows(SIGNED_CSV), CATEGORIES, { dayFirst: false });
    expect(rows.map((r) => r.amountCents)).toEqual([4500, 120_000, 25_050]);
    // The sign is preserved for display only.
    expect(rows.map((r) => r.sign)).toEqual([-1, 1, -1]);
    // Direction comes from the category, never from the sign.
    expect(rows.map((r) => r.suggestedType)).toEqual(["Expense", "Income", "Investment"]);
    expect(rows.every((r) => r.problems.length === 0)).toBe(true);
  });

  it("imports a signed CSV and its sign-stripped twin identically", () => {
    const unsigned = csv(
      ["Date", "Category", "Amount", "Description"],
      [
        ["2026-07-28", "Groceries", "45.00", "Spinneys"],
        ["2026-07-29", "Salary", "1200.00", "July pay"],
        ["2026-07-30", "Brokerage", "250.50", "Monthly buy"],
      ],
    );
    const a = parseImportRows(readCsvRows(SIGNED_CSV), CATEGORIES, { dayFirst: false });
    const b = parseImportRows(readCsvRows(unsigned), CATEGORIES, { dayFirst: false });
    expect(a.map((r) => r.amountCents)).toEqual(b.map((r) => r.amountCents));
    expect(a.map((r) => r.categoryId)).toEqual(b.map((r) => r.categoryId));
    expect(a.map((r) => r.date)).toEqual(b.map((r) => r.date));
  });

  it("treats a 0.00 amount as a real row, not a missing one", () => {
    const rows = parseImportRows(
      readCsvRows(csv(["Date", "Category", "Amount"], [["2026-07-28", "Groceries", "0.00"]])),
      CATEGORIES,
      { dayFirst: false },
    );
    expect(rows[0].amountCents).toBe(0);
    expect(rows[0].sign).toBe(0);
    expect(rows[0].problems).toEqual([]);
  });
});

describe("THE dayFirst RULE is identical for CSV", () => {
  const ambiguous = csv(
    ["Date", "Category", "Amount", "Description"],
    [["01/02/2026", "Groceries", "-45.00", "Ambiguous"]],
  );

  it("reads 01/02/2026 as 1 FEBRUARY when dayFirst is true", () => {
    const rows = parseImportRows(readCsvRows(ambiguous), CATEGORIES, { dayFirst: true });
    expect(rows[0].date).toBe("2026-02-01");
  });

  it("reads 01/02/2026 as 2 JANUARY when dayFirst is false", () => {
    const rows = parseImportRows(readCsvRows(ambiguous), CATEGORIES, { dayFirst: false });
    expect(rows[0].date).toBe("2026-01-02");
  });

  it("detects an unambiguous day-first file from the CSV itself", () => {
    const rows = readCsvRows(
      csv(["Date", "Category", "Amount"], [["25/12/2026", "Groceries", "-1"], ["01/02/2026", "Groceries", "-2"]]),
    );
    const detection = detectDateOrder(collectDateValues(rows));
    expect(detection).toMatchObject({ dayFirst: true, evidence: "day-first" });
    // ...and the ambiguous row in the same file then reads as 1 February.
    expect(parseImportRows(rows, CATEGORIES, { dayFirst: true })[1].date).toBe("2026-02-01");
  });

  it("detects an unambiguous month-first CSV", () => {
    const rows = readCsvRows(
      csv(["Date", "Category", "Amount"], [["12/25/2026", "Groceries", "-1"], ["01/02/2026", "Groceries", "-2"]]),
    );
    expect(detectDateOrder(collectDateValues(rows))).toMatchObject({
      dayFirst: false,
      evidence: "month-first",
    });
  });

  it("refuses to guess when the CSV gives no evidence", () => {
    const rows = readCsvRows(csv(["Date", "Category", "Amount"], [["01/02/2026", "Groceries", "-1"]]));
    expect(detectDateOrder(collectDateValues(rows))).toMatchObject({ dayFirst: null, evidence: "none" });
  });

  it("REPORTS an unreadable date instead of substituting today", () => {
    const rows = parseImportRows(
      readCsvRows(csv(["Date", "Category", "Amount"], [["not a date", "Groceries", "-1"]])),
      CATEGORIES,
      { dayFirst: true },
    );
    expect(rows[0].date).toBeNull();
    expect(rows[0].problems.join(" ")).toMatch(/unreadable date/);
  });
});

describe("THE DEDUPE RULE is identical for CSV", () => {
  it("skips a row that already exists on the ledger", () => {
    const rows = parseImportRows(readCsvRows(SIGNED_CSV), CATEGORIES, { dayFirst: false });
    const existing = [
      dedupeKey({ date: "2026-07-28", amountCents: 4500, categoryId: 1, comment: "spinneys" }),
    ];
    const plan = planImport(rows, existing);
    expect(plan.toImport).toHaveLength(2);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].comment).toBe("Spinneys");
  });

  it("collapses a line repeated inside the same CSV", () => {
    const repeated = csv(
      ["Date", "Category", "Amount", "Description"],
      [
        ["2026-07-28", "Groceries", "-45.00", "Spinneys"],
        ["2026-07-28", "Groceries", "-45.00", "Spinneys"],
      ],
    );
    const plan = planImport(parseImportRows(readCsvRows(repeated), CATEGORIES, { dayFirst: false }), []);
    expect(plan.toImport).toHaveLength(1);
    expect(plan.duplicates).toHaveLength(1);
  });

  it("importing the same CSV twice adds nothing the second time", () => {
    const rows = parseImportRows(readCsvRows(SIGNED_CSV), CATEGORIES, { dayFirst: false });
    const first = planImport(rows, []);
    const keys = first.toImport.map((r) =>
      dedupeKey({
        date: r.date as string,
        amountCents: r.amountCents,
        categoryId: r.categoryId,
        comment: r.comment,
      }),
    );
    const second = planImport(rows, keys);
    expect(second.toImport).toHaveLength(0);
    expect(second.duplicates).toHaveLength(3);
  });
});
