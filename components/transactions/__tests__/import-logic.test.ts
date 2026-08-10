/**
 * Regression tests for the Excel import (items 2, 3 and the dedupe half of 4).
 *
 * The date tests must pass under `bun run test:tz` (UTC+14 and UTC-11), so they
 * parse a real .xlsx fixture and assert on the resulting calendar day.
 */
import { describe, expect, it } from "vitest";
import {
  assertImportFileSize,
  assertXlsxDeclaredExpandedSize,
  collectDateValues,
  dedupeKey,
  describeImportResult,
  detectDateOrder,
  isImportable,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_EXPANDED_BYTES,
  MAX_IMPORT_ROWS,
  missingCategories,
  parseImportRows,
  pickColumn,
  planImport,
  readSpreadsheetRows,
  resolveAmount,
  spreadsheetMatrixToRows,
  type ImportCategory,
} from "../import-logic";

const CATEGORIES: ImportCategory[] = [
  { id: 1, name: "Groceries", type: "Expense" },
  { id: 2, name: "Salary", type: "Income" },
  { id: 3, name: "Brokerage", type: "Investment" },
];

/** Real OOXML workbook: headers plus date-formatted, text-date and amount cells. */
const XLSX_FIXTURE_BASE64 =
  "UEsDBBQAAAAIAPytB112qvOvCQEAAKcCAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbK2SzU7DMBCEX8XytYrdckAIJemBnyNwKA+wOJvEiv/kdUvy9jhp4YAKvfRk2Tsz32jlcjtaww4YSXtX8Y1Yc4ZO+Ua7ruLvu+fijjNK4Bow3mHFJyS+rcvdFJBY9jqqeJ9SuJeSVI8WSPiALk9aHy2kfI2dDKAG6FDerNe3UnmX0KUizRm8Lh+xhb1J7GnMz8ceEQ1x9nAUzqyKQwhGK0h5Lg+u+UUpTgSRnYuGeh1olQVcniXMk78BJ99rXkzUDbI3iOkFbFbJ0chPH4cP7wfxf8iZlr5ttcLGq73NFkEhIjTUIyZrxHIKC9qtLvMXMcnl2Fy5yE/+hR6UJoN07S0sod9kuXy0+gtQSwMEFAAAAAgA/K0HXZja64uuAAAAJwEAAAsAAABfcmVscy8ucmVsc43PwQ6CMAwG4FdZepeBB2MMg4sx4WrwAeZWBgHWZZsKb++OYjx4bPr3+9OyXuaJPdGHgayAIsuBoVWkB2sE3NrL7ggsRGm1nMiigBUD1FV5xUnGdBL6wQWWDBsE9DG6E+dB9TjLkJFDmzYd+VnGNHrDnVSjNMj3eX7g/tOArckaLcA3ugDWrg7/sanrBoVnUo8ZbfxR8ZVIsvQGo4Bl4i/y451ozBIKvCr55sHqDVBLAwQUAAAACAD8rQddnWxDvbkAAAAbAQAADwAAAHhsL3dvcmtib29rLnhtbI1PS67CMAy8SuQ9pGWBnqq2bBASa+AAoXFpRGNXdvi82xN+e1Yz1mjGM/XqHkdzRdHA1EA5L8AgdewDnRo47DezPzCaHHk3MmED/6iwausby/nIfDbZTtrAkNJUWavdgNHpnCekrPQs0aV8ysnqJOi8DogpjnZRFEsbXSB4J1TySwb3fehwzd0lIqV3iODoUi6vQ5gU2vr1QT9oyMVcevfkZR7yxK3PO8FIFTKRrS/BtrX92ux3WfsAUEsDBBQAAAAIAPytB12rISxuwgAAAKcBAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHOtkM0KAjEMhF+l5O5mdw8iYvUiglfRByjd7A/utqWJP/v2FkVR8ODBU5iEfDPMYnUdenWmyJ13GoosB0XO+qpzjYbDfjOZgWIxrjK9d6RhJIbVcrGj3kh64bYLrBLDsYZWJMwR2bY0GM58IJcutY+DkSRjg8HYo2kIyzyfYnxnwCdTbSsNcVsVoPZjoF/Yvq47S2tvTwM5+WKBFx+P3BJJgprYkGh4rRjvo8gSFfB7mPKfYVjGPnX5SvLQT3v8KHh5A1BLAwQUAAAACAD8rQddX8gOAt0AAAB8AQAADQAAAHhsL3N0eWxlcy54bWxdkMFuwyAMhl8F+d6SVtM0TUBvkXrZpZu0Kw1OEwkMAjI1bz9IOy3t0f/3YWyLw9VZ9oMxjZ4k7LYNMKTOm5EuEr4+280bsJQ1GW09oYQZExyUSHm2eBoQMysNKEkYcg7vnKduQKfT1gekQnofnc6ljBeeQkRtUn3kLN83zSt3eiRQoveUE+v8RLnMcA+4EnwBpRytfeQlWHgFSpx9NGWFtXGLqnOHSnRo7anO/d0/qNe+amt6c1faftEYTa51+WgkNMCfkt0LMB2CnT8md8bYLovXD/6aL335/+HUL1BLAwQUAAAACAD8rQddwdsAQFQBAADDAwAAGAAAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbH2T327CIBTG7/cUDfcVSqtbForxT7bbJW4PQOpZJbbQAOr69sO61GnAu3J6vo/vxwE2/2mb5AjGSq1KlE0ISkBVeitVXaKvz7f0BSXWCbUVjVZQoh4smnN20mZvdwAu8XplS7RzrnvF2FY7aIWd6A6U//OtTSucX5oa286A2A6itsGUkBluhVSIs6G2Fk7wJ2b0KTE+iC9X549FhhJXIqkaqWDjjK9Ly5njvh8Ydpzh8xpXf/3LWP/K99fa9AHNKqZZtPqgXECxjqYCWxnZOX+atzLswa54dMSj/ngvuEdezGieMXz8j0MjG70bXYGRYEM8dLBLi+mt2TpmtumkUtDbR5HzMXIecSEZJtQPls5Cc4mpNqIR4ankA0Xmb8odRszqQ/SPCIqRoIgYnLOn5DnNSYggploavQcj6tB1XBWXUdApmdxPI+p3CGPg6ztheHyA/BdQSwECFAMUAAAACAD8rQdddqrzrwkBAACnAgAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAPytB12Y2uuLrgAAACcBAAALAAAAAAAAAAAAAACAAToBAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAPytB12dbEO9uQAAABsBAAAPAAAAAAAAAAAAAACAARECAAB4bC93b3JrYm9vay54bWxQSwECFAMUAAAACAD8rQddqyEsbsIAAACnAQAAGgAAAAAAAAAAAAAAgAH3AgAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHNQSwECFAMUAAAACAD8rQddX8gOAt0AAAB8AQAADQAAAAAAAAAAAAAAgAHxAwAAeGwvc3R5bGVzLnhtbFBLAQIUAxQAAAAIAPytB13B2wBAVAEAAMMDAAAYAAAAAAAAAAAAAACAAfkEAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwUGAAAAAAYABgCAAQAAgwYAAAAA";

function xlsxFixture(): ArrayBuffer {
  const bytes = Buffer.from(XLSX_FIXTURE_BASE64, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * The Excel serial for a calendar day, computed in UTC so the FIXTURE is not
 * itself timezone-dependent.
 *
 * This keeps the direct serial fixtures independent of the process timezone.
 */
function excelSerial(year: number, month1: number, day: number): number {
  return (Date.UTC(year, month1 - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

// ---------------------------------------------------------------------------
// Item 2: signed exports must not invert the direction of the transaction
// ---------------------------------------------------------------------------

describe("the sign rule", () => {
  it("stores a magnitude, so a bank export's -45.00 expense still reduces cash", () => {
    // THE BUG: the dialog stored -4500 while the direction came from
    // category.type === "Expense", so cash went UP by $45.
    const resolved = resolveAmount("-45.00");
    expect(resolved.amountCents).toBe(4500);
    expect(resolved.sign).toBe(-1);
  });

  it("treats a signed and an unsigned export as identical", () => {
    const signed = parseImportRows(
      [{ Date: "2026-07-28", Category: "Groceries", Amount: "-45.00", Description: "Spinneys" }],
      CATEGORIES,
      { dayFirst: false },
    );
    const unsigned = parseImportRows(
      [{ Date: "2026-07-28", Category: "Groceries", Amount: "45.00", Description: "Spinneys" }],
      CATEGORIES,
      { dayFirst: false },
    );
    expect(signed[0].amountCents).toBe(4500);
    expect(unsigned[0].amountCents).toBe(4500);
    expect(signed[0].categoryId).toBe(1);
    expect(signed[0].suggestedType).toBe("Expense");
  });

  it("handles accounting parentheses and currency decoration", () => {
    expect(resolveAmount("(45.00)").amountCents).toBe(4500);
    expect(resolveAmount("$1,234.56").amountCents).toBe(123456);
    expect(resolveAmount("-$45.50").amountCents).toBe(4550);
    expect(resolveAmount(120.5).amountCents).toBe(12050);
  });

  it("keeps a positive income row positive", () => {
    const rows = parseImportRows(
      [{ Date: "2026-07-01", Category: "Salary", Amount: "5,000.00" }],
      CATEGORIES,
      { dayFirst: false },
    );
    expect(rows[0].amountCents).toBe(500000);
    expect(rows[0].suggestedType).toBe("Income");
  });

  it("uses the sign ONLY to infer a type when the file names no category", () => {
    const [expense] = parseImportRows([{ Date: "2026-07-28", Amount: "-45.00" }], [], {
      dayFirst: false,
    });
    const [income] = parseImportRows([{ Date: "2026-07-28", Amount: "45.00" }], [], {
      dayFirst: false,
    });
    expect(expense.suggestedType).toBe("Expense");
    expect(income.suggestedType).toBe("Income");
    // Neither is importable: no category means no direction.
    expect(isImportable(expense)).toBe(false);
    expect(isImportable(income)).toBe(false);
  });

  it("prefers the matched category's type over the sign", () => {
    // An Income category with a negative amount is still Income.
    const [row] = parseImportRows(
      [{ Date: "2026-07-01", Category: "Salary", Amount: "-5000", Type: "Expense" }],
      CATEGORIES,
      { dayFirst: false },
    );
    expect(row.suggestedType).toBe("Income");
    expect(row.amountCents).toBe(500000);
  });

  it("falls back to an explicit Type column before the sign", () => {
    const [row] = parseImportRows(
      [{ Date: "2026-07-01", Category: "New Thing", Amount: "-100", Type: "Investment" }],
      CATEGORIES,
      { dayFirst: false },
    );
    expect(row.suggestedType).toBe("Investment");
    expect(missingCategories([row])).toEqual([{ name: "New Thing", type: "Investment" }]);
  });

  it("flags an unreadable amount instead of importing it as 0", () => {
    const [row] = parseImportRows(
      [{ Date: "2026-07-28", Category: "Groceries", Amount: "n/a" }],
      CATEGORIES,
      { dayFirst: false },
    );
    expect(row.problems.join(" ")).toMatch(/unreadable amount/);
    expect(isImportable(row)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Item 3: dates
// ---------------------------------------------------------------------------

describe("dates survive the spreadsheet round trip in every timezone", () => {
  it("reads a real xlsx date cell with the maintained parser", async () => {
    const rows = await readSpreadsheetRows(xlsxFixture());
    const parsed = parseImportRows(rows, CATEGORIES, { dayFirst: false });
    expect(parsed[0].date).toBe("2026-07-28");
    expect(parsed[0]).toMatchObject({ amountCents: 4500, categoryId: 1, comment: "Spinneys" });
  });

  it("reads a whole month of date cells without drifting a day", () => {
    const days = Array.from({ length: 31 }, (_, i) => ({
      Date: excelSerial(2026, 1, i + 1),
      Category: "Groceries",
      Amount: 1,
    }));
    const parsed = parseImportRows(days, CATEGORIES, {
      dayFirst: false,
    });
    parsed.forEach((row, i) => {
      expect(row.date).toBe(`2026-01-${String(i + 1).padStart(2, "0")}`);
    });
  });

  it("reads ISO date strings written as text, in any timezone", () => {
    const rows = [
      { Date: "2026-01-01", Category: "Groceries", Amount: 1 },
      { Date: "2025-12-31", Category: "Groceries", Amount: 1 },
      { Date: "2026-07-28", Category: "Groceries", Amount: 1 },
    ];
    const parsed = parseImportRows(rows, CATEGORIES, { dayFirst: false });
    expect(parsed.map((r) => r.date)).toEqual(["2026-01-01", "2025-12-31", "2026-07-28"]);
  });

  it("reads an Excel serial number the same way in any timezone", () => {
    // 46231 = 2026-07-28. The old excelDateToJSDate built the epoch locally and
    // then called toISOString(), so east of UTC it returned 2026-07-27.
    const [row] = parseImportRows([{ Date: 46231, Category: "Groceries", Amount: 45 }], CATEGORIES, {
      dayFirst: false,
    });
    expect(row.date).toBe("2026-07-28");
  });

  it("reads DD/MM/YYYY as day-first when told to", () => {
    const [row] = parseImportRows(
      [{ Date: "03/12/2026", Category: "Groceries", Amount: 45 }],
      CATEGORIES,
      { dayFirst: true },
    );
    expect(row.date).toBe("2026-12-03");
  });

  it("reads the same string as month-first when told to", () => {
    const [row] = parseImportRows(
      [{ Date: "03/12/2026", Category: "Groceries", Amount: 45 }],
      CATEGORIES,
      { dayFirst: false },
    );
    expect(row.date).toBe("2026-03-12");
  });

  it("gets an unambiguous DD/MM right regardless of the flag", () => {
    for (const dayFirst of [true, false]) {
      const [row] = parseImportRows(
        [{ Date: "25/12/2026", Category: "Groceries", Amount: 45 }],
        CATEGORIES,
        { dayFirst },
      );
      expect(row.date).toBe("2026-12-25");
    }
  });

  it("reports an unreadable date instead of silently substituting today", () => {
    // THE BUG: the old parseDate returned `new Date().toISOString()` for
    // anything it could not read, inventing a transaction date out of thin air.
    const [row] = parseImportRows(
      [{ Date: "28 Jul 2026", Category: "Groceries", Amount: 45 }],
      CATEGORIES,
      { dayFirst: true },
    );
    expect(row.date).toBeNull();
    expect(row.problems.join(" ")).toMatch(/unreadable date/);
    expect(isImportable(row)).toBe(false);
  });

  it("reports a missing date rather than defaulting it", () => {
    const [row] = parseImportRows([{ Category: "Groceries", Amount: 45 }], CATEGORIES, {
      dayFirst: true,
    });
    expect(row.date).toBeNull();
    expect(row.problems).toContain("missing date");
  });
});

describe("untrusted import bounds", () => {
  it("rejects files larger than the byte limit", () => {
    expect(() => assertImportFileSize(MAX_IMPORT_FILE_BYTES + 1)).toThrow(/too large/i);
    expect(() => assertImportFileSize(MAX_IMPORT_FILE_BYTES)).not.toThrow();
  });

  it("rejects more than the maximum number of data rows", () => {
    const matrix = [
      ["Date", "Category", "Amount"],
      ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => ["2026-01-01", "Groceries", 1]),
    ];
    expect(() => spreadsheetMatrixToRows(matrix)).toThrow(/too many rows/i);
  });

  it("rejects an XLSX whose declared expanded size is excessive before parsing", async () => {
    const archive = xlsxFixture().slice(0);
    const view = new DataView(archive);
    let centralEntry = -1;
    for (let offset = 0; offset <= view.byteLength - 4; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        centralEntry = offset;
        break;
      }
    }
    expect(centralEntry).toBeGreaterThanOrEqual(0);
    view.setUint32(centralEntry + 24, MAX_IMPORT_EXPANDED_BYTES + 1, true);

    expect(() => assertXlsxDeclaredExpandedSize(archive)).toThrow(/expands beyond/i);
    await expect(readSpreadsheetRows(archive)).rejects.toThrow(/expands beyond/i);
  });

  it("normalizes maintained-parser UTC dates before timezone-sensitive parsing", () => {
    const rows = spreadsheetMatrixToRows([
      ["Date", "Category", "Amount"],
      [new Date("2026-07-28T00:00:00.000Z"), "Groceries", -45],
    ]);
    expect(rows[0].Date).toBe("2026-07-28");
  });
});

describe("detectDateOrder seeds the day-first toggle from the file itself", () => {
  it("detects day-first from an unambiguous day > 12", () => {
    expect(detectDateOrder(["03/12/2026", "25/12/2026"])).toEqual({
      dayFirst: true,
      evidence: "day-first",
      samples: 2,
    });
  });

  it("detects month-first from an unambiguous second component > 12", () => {
    expect(detectDateOrder(["03/12/2026", "12/25/2026"]).dayFirst).toBe(false);
    expect(detectDateOrder(["12/25/2026"]).evidence).toBe("month-first");
  });

  it("refuses to guess when the file contains both patterns", () => {
    const detection = detectDateOrder(["25/12/2026", "12/25/2026"]);
    expect(detection.dayFirst).toBeNull();
    expect(detection.evidence).toBe("conflict");
  });

  it("returns null (not a US default) when every value is ambiguous", () => {
    expect(detectDateOrder(["03/12/2026", "01/02/2026"])).toEqual({
      dayFirst: null,
      evidence: "none",
      samples: 2,
    });
  });

  it("ignores ISO dates and serials, which are never ambiguous", () => {
    expect(detectDateOrder(["2026-07-28", 46231, null]).samples).toBe(0);
  });

  it("collects the date column out of real rows", () => {
    const rows = [{ Date: "25/12/2026" }, { date: "01/01/2026" }, { Amount: 1 }];
    expect(collectDateValues(rows)).toEqual(["25/12/2026", "01/01/2026", undefined]);
  });
});

describe("column lookup", () => {
  it("matches headings case- and whitespace-insensitively", () => {
    expect(pickColumn({ " AMOUNT ": 45 }, ["amount"])).toBe(45);
    expect(pickColumn({ Description: "x" }, ["description", "comment"])).toBe("x");
    expect(pickColumn({ Comment: "x" }, ["description", "comment"])).toBe("x");
    expect(pickColumn({ Amount: "" }, ["amount"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Item 4: de-duplication
// ---------------------------------------------------------------------------

describe("duplicate detection", () => {
  const row = {
    date: "2026-07-28",
    amountCents: 4500,
    categoryId: 1,
    comment: "Spinneys",
  };

  it("keys on account, currency, direction, and the original row identity", () => {
    const complete = {
      ...row,
      accountId: 7,
      currency: "eur",
      direction: "outflow" as const,
    };
    expect(dedupeKey(complete)).toBe("2026-07-28|4500|1|7|EUR|outflow|spinneys");
    expect(dedupeKey({ ...complete, accountId: 8 })).not.toBe(dedupeKey(complete));
    expect(dedupeKey({ ...complete, currency: "USD" })).not.toBe(dedupeKey(complete));
    expect(dedupeKey({ ...complete, direction: "inflow" })).not.toBe(dedupeKey(complete));
  });

  it("ignores cosmetic comment differences a re-export introduces", () => {
    expect(dedupeKey({ ...row, comment: "  Spinneys  " })).toBe(dedupeKey(row));
    expect(dedupeKey({ ...row, comment: "spinneys" })).toBe(dedupeKey(row));
    expect(dedupeKey({ ...row, comment: "Spin  neys" })).not.toBe(dedupeKey(row));
  });

  it("treats a null and an empty comment as the same row", () => {
    expect(dedupeKey({ ...row, comment: null })).toBe(dedupeKey({ ...row, comment: "" }));
  });

  it("skips rows that already exist and rows repeated inside the file", () => {
    const parsed = parseImportRows(
      [
        { Date: "2026-07-28", Category: "Groceries", Amount: -45, Description: "Spinneys" },
        { Date: "2026-07-28", Category: "Groceries", Amount: -45, Description: "spinneys" },
        { Date: "2026-07-29", Category: "Groceries", Amount: -12, Description: "Coffee" },
        { Date: "bad", Category: "Groceries", Amount: -1 },
      ],
      CATEGORIES,
      { dayFirst: false },
    );

    const plan = planImport(parsed, [
      dedupeKey({ date: "2026-07-29", amountCents: 1200, categoryId: 1, comment: "Coffee" }),
    ]);

    expect(plan.toImport.map((r) => r.rowNumber)).toEqual([2]);
    expect(plan.duplicates.map((r) => r.rowNumber)).toEqual([3, 4]); // in-file repeat + existing
    expect(plan.unusable.map((r) => r.rowNumber)).toEqual([5]);
  });

  it("re-importing the same file a second time inserts nothing", () => {
    const parsed = parseImportRows(
      [
        { Date: "2026-07-28", Category: "Groceries", Amount: -45, Description: "Spinneys" },
        { Date: "2026-07-29", Category: "Salary", Amount: 5000, Description: "July" },
      ],
      CATEGORIES,
      { dayFirst: false },
    );

    const first = planImport(parsed, []);
    expect(first.toImport).toHaveLength(2);

    const keys = first.toImport.map((r) =>
      dedupeKey({
        date: r.date!,
        amountCents: r.amountCents,
        categoryId: r.categoryId,
        comment: r.comment,
      }),
    );
    const second = planImport(parsed, keys);
    expect(second.toImport).toHaveLength(0);
    expect(second.duplicates).toHaveLength(2);
  });
});

describe("describeImportResult", () => {
  it("reports what was skipped", () => {
    expect(describeImportResult({ inserted: 3, duplicates: 0, unusable: 0 })).toBe(
      "Imported 3 transactions.",
    );
    expect(describeImportResult({ inserted: 1, duplicates: 2, unusable: 1 })).toBe(
      "Imported 1 transaction, skipped 2 duplicates, skipped 1 unusable row.",
    );
  });
});
