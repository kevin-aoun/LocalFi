/**
 * CSV import — held to EXACTLY the same rules as the .xlsx path.
 *
 * Import used to accept .xlsx/.xls only. Adding .csv is only safe if it goes
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
 * THE BUG THIS FILE PINS DOWN: `XLSX.read` on CSV text *without* `raw: true`
 * runs SheetJS's own cell-type guessing, which converts `01/02/2026` to the
 * Excel serial 46024 — 2 January 2026, US order — before our code ever sees it.
 * The `dayFirst` toggle then has NOTHING to act on and is silently ignored. It
 * also emits fractional serials (a spurious time-of-day) for ISO dates, which
 * floor to the previous day in some timezones. Both are asserted below.
 *
 * Must pass under `npm run test:tz` (UTC+14 and UTC-11).
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseFlexibleDate, toDateKey } from "@/lib/dates";
import {
  collectDateValues,
  dedupeKey,
  detectDateOrder,
  isCsvFilename,
  parseImportRows,
  planImport,
  readCsvRows,
  readSpreadsheetRows,
  type ImportCategory,
} from "../import-logic";

const CATEGORIES: ImportCategory[] = [
  { id: 1, name: "Groceries", type: "Expense" },
  { id: 2, name: "Salary", type: "Income" },
  { id: 3, name: "Brokerage", type: "Investment" },
];

/** Build real .xlsx bytes from row objects — the reference path. */
function xlsxBytes(rows: Array<Record<string, unknown>>): Uint8Array {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
  return XLSX.write(book, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

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

describe("readCsvRows keeps cells RAW, so our date/amount rules stay in charge", () => {
  it("does not let SheetJS pre-parse an ambiguous date into a serial", () => {
    const rows = readCsvRows(csv(["Date", "Category", "Amount"], [["01/02/2026", "Groceries", "1"]]));
    expect(rows[0].Date).toBe("01/02/2026");
    expect(typeof rows[0].Date).toBe("string");
  });

  it("reproduces the old bug so the regression is unmistakable", () => {
    // What XLSX.read does to the same text WITHOUT raw: true.
    const text = csv(["Date", "Category", "Amount"], [["01/02/2026", "Groceries", "1"]]);
    const guessed = XLSX.utils.sheet_to_json(
      XLSX.read(text, { type: "string", cellDates: false }).Sheets.Sheet1,
      { raw: true, defval: null },
    ) as Array<Record<string, unknown>>;

    // The cell is no longer text: SheetJS has already committed to a day, in US
    // order, before our code sees it. (46024 is 2 January 2026; the value is
    // fractional and slightly LOWER away from UTC — 46023.9997 at UTC+14 — so it
    // even floors to 1 January there. Wrong order AND off by one.)
    const value = guessed[0].Date;
    expect(typeof value).toBe("number");
    expect(Math.floor(value as number)).toBeGreaterThanOrEqual(46023);
    expect(Math.floor(value as number)).toBeLessThanOrEqual(46024);

    // The damage: `dayFirst` has nothing left to act on, so the toggle the whole
    // import UI is built around becomes a no-op...
    const asDayFirst = parseFlexibleDate(value as number, { dayFirst: true });
    const asMonthFirst = parseFlexibleDate(value as number, { dayFirst: false });
    expect(asDayFirst && toDateKey(asDayFirst)).toBe(asMonthFirst && toDateKey(asMonthFirst));
    // ...and the day the user asked for (1 February) is unreachable.
    expect(asDayFirst && toDateKey(asDayFirst)).not.toBe("2026-02-01");

    // Our reader keeps the text, so parseFlexibleDate + dayFirst decide.
    expect(readCsvRows(text)[0].Date).toBe("01/02/2026");
    const rows = parseImportRows(readCsvRows(text), CATEGORIES, { dayFirst: true });
    expect(rows[0].date).toBe("2026-02-01");
  });

  it("does not let SheetJS attach a spurious time-of-day to an ISO date", () => {
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

describe("CSV and XLSX produce the same transactions", () => {
  it("agrees row-for-row on dates, magnitudes, categories and comments", () => {
    const data = [
      { Date: "2026-07-28", Category: "Groceries", Amount: "-45.00", Description: "Spinneys" },
      { Date: "01/02/2026", Category: "Salary", Amount: "1200.00", Description: "Pay" },
      { Date: "2026-07-30", Category: "Brokerage", Amount: "-250.50", Description: "Buy" },
    ];

    const fromXlsx = parseImportRows(readSpreadsheetRows(xlsxBytes(data)), CATEGORIES, {
      dayFirst: true,
    });
    const fromCsv = parseImportRows(
      readCsvRows(
        csv(
          ["Date", "Category", "Amount", "Description"],
          data.map((d) => [d.Date, d.Category, d.Amount, d.Description]),
        ),
      ),
      CATEGORIES,
      { dayFirst: true },
    );

    const shape = (r: (typeof fromCsv)[number]) => ({
      date: r.date,
      amountCents: r.amountCents,
      sign: r.sign,
      categoryId: r.categoryId,
      comment: r.comment,
      suggestedType: r.suggestedType,
      problems: r.problems,
    });
    expect(fromCsv.map(shape)).toEqual(fromXlsx.map(shape));
    // The ambiguous row landed on 1 February in BOTH paths.
    expect(fromCsv[1].date).toBe("2026-02-01");
  });

  it("produces identical dedupe keys from either format", () => {
    const data = [{ Date: "2026-07-28", Category: "Groceries", Amount: "-45.00", Description: "Spinneys" }];
    const keyOf = (rows: ReturnType<typeof parseImportRows>) =>
      rows.map((r) =>
        dedupeKey({
          date: r.date as string,
          amountCents: r.amountCents,
          categoryId: r.categoryId,
          comment: r.comment,
        }),
      );

    expect(
      keyOf(parseImportRows(readCsvRows(csv(["Date", "Category", "Amount", "Description"], [[data[0].Date, data[0].Category, data[0].Amount, data[0].Description]])), CATEGORIES, { dayFirst: false })),
    ).toEqual(keyOf(parseImportRows(readSpreadsheetRows(xlsxBytes(data)), CATEGORIES, { dayFirst: false })));
  });

  it("still reads an xlsx date SERIAL correctly (the xlsx path is untouched)", () => {
    // Serial computed in UTC so the fixture is not itself timezone-dependent.
    const serial = (Date.UTC(2026, 6, 28) - Date.UTC(1899, 11, 30)) / 86_400_000;
    const rows = parseImportRows(
      readSpreadsheetRows(xlsxBytes([{ Date: serial, Category: "Groceries", Amount: -45 }])),
      CATEGORIES,
      { dayFirst: true },
    );
    expect(rows[0].date).toBe("2026-07-28");
  });
});
