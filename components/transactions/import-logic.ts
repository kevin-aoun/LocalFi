/**
 * Pure logic behind `import-dialog.tsx`: read a spreadsheet, turn its rows into
 * transactions, and decide what to skip. No React, no DOM, no server actions —
 * so every rule below is unit-testable, including under extreme timezones.
 *
 * ## Formats
 *
 * `.xlsx`, `.xls` and `.csv`. All three go through the SAME reader
 * (`XLSX.read` with `READ_OPTIONS`), the same row conversion and the same
 * parse/dedupe pipeline — CSV is not a second parser, it is the same one fed
 * text instead of bytes. See `READ_OPTIONS` for why `raw: true` is what makes
 * that safe, and `import-csv.test.ts` for the assertions that hold the two
 * paths to identical results.
 *
 * ## The three bugs this module exists to prevent
 *
 * 1. **Inverted signs.** A bank export writes an expense as `-45.00`. The old
 *    dialog stored that `-4500` verbatim while the transaction's DIRECTION came
 *    from `category.type`, so an Expense row of `-45.00` *increased* cash by
 *    $45. See `resolveAmount` for the rule that replaced it.
 *
 * 2. **Corrupted dates.** The old code built the Excel epoch in local time and
 *    then called `toISOString()` (off by one east of UTC), and because SheetJS
 *    ran with `raw: false` most date cells arrived as *formatted strings* that
 *    went through `new Date(string)` — which reads `25/12/2026` as an invalid
 *    date and `03/12/2026` as **March 12th**. Now the sheet is read with
 *    `raw: true` so date cells stay Excel serials, and every value goes through
 *    `parseExcelSerial` / `parseFlexibleDate`.
 *
 * 3. **Silent wrong-but-plausible days.** `parseFlexibleDate` defaults to US
 *    `MM/DD`, which misreads every EU/Lebanese export. So `dayFirst` is never
 *    left to a default: `detectDateOrder` looks for unambiguous evidence in the
 *    file itself, and the dialog exposes an explicit toggle seeded from it.
 *    A row whose date cannot be read is REPORTED, never silently replaced with
 *    today's date (which is what the old code did).
 */
import * as XLSX from "xlsx";
import {
  parseFlexibleDate,
  toDateKey,
  type DateKey,
} from "@/lib/dates";
import { absCents, tryParseAmount, type Cents } from "@/lib/money";

export type SpreadsheetRow = Record<string, unknown>;

export type ImportCategory = {
  id: number;
  name: string;
  type: string;
};

export type CategoryType = "Income" | "Expense" | "Investment";

/** How `dayFirst` was decided for a given file. */
export type DateOrderEvidence =
  /** At least one value has a first component > 12, so it must be D/M. */
  | "day-first"
  /** At least one value has a second component > 12, so it must be M/D. */
  | "month-first"
  /** Both patterns appear — the file is internally inconsistent. */
  | "conflict"
  /** Every value is either unambiguous ISO or D/M-vs-M/D ambiguous. */
  | "none";

export type DateOrderDetection = {
  /** null = the file gives no evidence; the user must choose. */
  dayFirst: boolean | null;
  evidence: DateOrderEvidence;
  /** Number of `d/d/y`-style values inspected. */
  samples: number;
};

/** `D/M/Y`-ish, i.e. the only shape whose component order is ambiguous. */
const SLASHED_RE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/;

/**
 * Look for an unambiguous day in the file's own date column.
 *
 * A value like `25/12/2026` can only be D/M; `12/25/2026` can only be M/D.
 * If the file contains one of those, the order is a FACT, not a guess. If it
 * contains both, the file is inconsistent and we refuse to pick (the dialog
 * then forces the user to choose). If it contains neither, we return null so
 * the caller shows the toggle rather than silently assuming US order.
 */
export function detectDateOrder(values: readonly unknown[]): DateOrderDetection {
  let sawDayFirst = false;
  let sawMonthFirst = false;
  let samples = 0;

  for (const value of values) {
    if (typeof value !== "string") continue;
    const m = SLASHED_RE.exec(value.trim());
    if (!m) continue;
    samples += 1;
    const first = Number(m[1]);
    const second = Number(m[2]);
    if (first > 12 && second <= 12) sawDayFirst = true;
    else if (second > 12 && first <= 12) sawMonthFirst = true;
  }

  if (sawDayFirst && sawMonthFirst) return { dayFirst: null, evidence: "conflict", samples };
  if (sawDayFirst) return { dayFirst: true, evidence: "day-first", samples };
  if (sawMonthFirst) return { dayFirst: false, evidence: "month-first", samples };
  return { dayFirst: null, evidence: "none", samples };
}

/**
 * The ONE set of options every format is read with, and the reason for each.
 *
 * `cellDates: false` keeps date cells as Excel serial NUMBERS, which
 * `parseExcelSerial` converts without ever touching UTC. Letting SheetJS build
 * the `Date` (or, worse, format it to a locale string) is exactly how the day
 * used to shift.
 *
 * `raw: true` is what makes CSV safe. SheetJS's CSV reader runs its own
 * cell-type guessing, and it guesses in US order: without `raw` it converts
 * `01/02/2026` into the serial 46024 — 2 January 2026 — *before* our code sees
 * the cell, so the explicit `dayFirst` toggle has nothing left to decide and is
 * silently ignored. Worse, that conversion goes via the local timezone and comes
 * back FRACTIONAL away from UTC (46023.9997 at UTC+14), so flooring it lands on
 * 1 January: wrong day/month order AND off by one. It also turns `-45.00` into
 * the number -45 before `parseAmount` can see the text.
 * With `raw: true` every cell arrives as written and OUR rules decide.
 *
 * For .xlsx/.xls `raw` at read time is a no-op (dates are already serials in the
 * file), which is why one option set can serve both formats — verified by the
 * "CSV and XLSX produce the same transactions" tests.
 */
const READ_OPTIONS = { cellDates: false, raw: true } as const;

/** First sheet of a parsed workbook -> raw rows. The single conversion point. */
function firstSheetRows(workbook: XLSX.WorkBook): SpreadsheetRow[] {
  const name = workbook.SheetNames[0];
  if (!name) return [];
  const sheet = workbook.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { raw: true, defval: null }) as SpreadsheetRow[];
}

/** Read a BINARY spreadsheet (.xlsx / .xls) into raw rows. */
export function readSpreadsheetRows(data: ArrayBuffer | Uint8Array): SpreadsheetRow[] {
  return firstSheetRows(XLSX.read(data, READ_OPTIONS));
}

/**
 * Read CSV TEXT into raw rows — the same reader, the same options, the same
 * row conversion as .xlsx, so every rule downstream (sign, `dayFirst`, dedupe)
 * is not merely "kept in sync" but is literally the same code.
 *
 * Only two things are CSV-specific:
 *   - the bytes are decoded to text by the caller (SheetJS sniffs a binary
 *     buffer, and a CSV that happens to start with odd bytes can be
 *     mis-sniffed);
 *   - a UTF-8 BOM is stripped, because it would otherwise become part of the
 *     first column's NAME and `pickColumn` would stop finding "Date".
 *
 * The delimiter (`,`, `;`, tab) is detected by SheetJS, so a European export
 * works without a setting.
 */
export function readCsvRows(text: string): SpreadsheetRow[] {
  if (typeof text !== "string") return [];
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (withoutBom.trim() === "") return [];
  return firstSheetRows(XLSX.read(withoutBom, { ...READ_OPTIONS, type: "string" }));
}

/** Extensions the import dialog accepts, for the file input and the copy. */
export const IMPORT_ACCEPT = ".xlsx,.xls,.csv" as const;

/** True for a `.csv` filename — the only case that needs the text reader. */
export function isCsvFilename(name: string): boolean {
  return typeof name === "string" && /\.csv$/i.test(name.trim());
}

/** Case-/space-insensitive column lookup: "Amount", "amount", " AMOUNT " all match. */
export function pickColumn(row: SpreadsheetRow, names: readonly string[]): unknown {
  const wanted = new Set(names.map((n) => n.trim().toLowerCase()));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(key.trim().toLowerCase()) && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

const DATE_COLUMNS = ["date", "transaction date", "value date", "posted"] as const;
const AMOUNT_COLUMNS = ["amount", "value", "sum"] as const;
const CATEGORY_COLUMNS = ["category"] as const;
const TYPE_COLUMNS = ["type"] as const;
const COMMENT_COLUMNS = ["description", "comment", "details", "narrative", "memo"] as const;

/** Every date-ish cell in the sheet, for `detectDateOrder`. */
export function collectDateValues(rows: readonly SpreadsheetRow[]): unknown[] {
  return rows.map((row) => pickColumn(row, DATE_COLUMNS));
}

function normalizeType(value: unknown): CategoryType | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "income":
      return "Income";
    case "expense":
      return "Expense";
    case "investment":
      return "Investment";
    default:
      return null;
  }
}

export type ResolvedAmount = {
  /** Magnitude in integer cents; ALWAYS >= 0. Direction lives in the category. */
  amountCents: Cents;
  /** The sign as it appeared in the file: -1, 0 or +1. */
  sign: -1 | 0 | 1;
  /** Type inferred from the sign, used only when the file names no category/type. */
  inferredType: CategoryType;
  /** True when the cell could not be parsed at all. */
  invalid: boolean;
};

/**
 * ## THE SIGN RULE (documented once, here)
 *
 * A transaction's stored `amountCents` is a **magnitude**; whether it adds to or
 * subtracts from cash is decided *entirely* by its category's `type`
 * (see lib/cash-balance.ts). Therefore:
 *
 *   - the imported amount is always `absCents(parsed)` — a bank export's
 *     `-45.00` for groceries becomes `4500` against an Expense category, so
 *     cash goes DOWN by $45 (it used to go UP);
 *   - the sign is used for exactly one thing: **inferring the type** when the
 *     row names no category and no type. Negative -> Expense, positive/zero ->
 *     Income. It never flips the direction of a row that has a category.
 *
 * Consequence, on purpose: a signed export and the same export with the signs
 * stripped import identically. Both are common in the wild and neither is
 * ambiguous once the category decides the direction.
 */
export function resolveAmount(raw: unknown): ResolvedAmount {
  const parsed =
    typeof raw === "number" || typeof raw === "string" ? tryParseAmount(raw) : null;
  if (parsed === null) {
    return { amountCents: 0, sign: 0, inferredType: "Expense", invalid: true };
  }
  const sign = parsed < 0 ? -1 : parsed > 0 ? 1 : 0;
  return {
    amountCents: absCents(parsed),
    sign,
    inferredType: sign < 0 ? "Expense" : "Income",
    invalid: false,
  };
}

export type ParsedImportRow = {
  /** Source row number as the user sees it in the spreadsheet (1-based, header = 1). */
  rowNumber: number;
  /** 'YYYY-MM-DD', or null when the cell could not be read. */
  date: DateKey | null;
  /** The date cell as it appeared, for the error message. */
  rawDate: string;
  categoryId: number;
  categoryName: string;
  /** Magnitude in cents (see `resolveAmount`). */
  amountCents: Cents;
  /** Sign as it appeared in the file (for display only). */
  sign: -1 | 0 | 1;
  comment: string;
  /** Type named by the file, or inferred from the sign when it names none. */
  suggestedType: CategoryType;
  /** Non-empty means the row cannot be imported as-is. */
  problems: string[];
};

export type ParseOptions = {
  /** Required: never let `parseFlexibleDate` fall back to its US default. */
  dayFirst: boolean;
};

/** Turn raw spreadsheet rows into reviewable transactions. */
export function parseImportRows(
  rows: readonly SpreadsheetRow[],
  categories: readonly ImportCategory[],
  options: ParseOptions,
): ParsedImportRow[] {
  return rows.map((row, index) => {
    const rawDate = pickColumn(row, DATE_COLUMNS);
    const rawAmount = pickColumn(row, AMOUNT_COLUMNS);
    const rawCategory = pickColumn(row, CATEGORY_COLUMNS);
    const rawType = pickColumn(row, TYPE_COLUMNS);
    const rawComment = pickColumn(row, COMMENT_COLUMNS);

    const problems: string[] = [];

    let date: DateKey | null = null;
    if (rawDate === undefined || rawDate === null || rawDate === "") {
      problems.push("missing date");
    } else if (
      typeof rawDate === "string" ||
      typeof rawDate === "number" ||
      rawDate instanceof Date
    ) {
      const parsed = parseFlexibleDate(rawDate, { dayFirst: options.dayFirst });
      if (parsed) date = toDateKey(parsed);
      else problems.push(`unreadable date ${JSON.stringify(String(rawDate))}`);
    } else {
      problems.push("unreadable date");
    }

    const amount = resolveAmount(rawAmount);
    if (amount.invalid) {
      problems.push(
        rawAmount === undefined ? "missing amount" : `unreadable amount ${JSON.stringify(String(rawAmount))}`,
      );
    }

    const categoryName = typeof rawCategory === "string" ? rawCategory.trim() : "";
    const category = categoryName
      ? categories.find((c) => c.name.trim().toLowerCase() === categoryName.toLowerCase())
      : undefined;

    // Type precedence: the matched category wins, then an explicit Type column,
    // then — and only then — the sign of the amount.
    const suggestedType: CategoryType =
      (category ? normalizeType(category.type) : null) ??
      normalizeType(rawType) ??
      amount.inferredType;

    if (!category) problems.push(categoryName ? `unknown category "${categoryName}"` : "missing category");

    return {
      rowNumber: index + 2, // +1 for zero-based, +1 for the header row
      date,
      rawDate: rawDate === undefined || rawDate === null ? "" : String(rawDate),
      categoryId: category?.id ?? 0,
      categoryName,
      amountCents: amount.amountCents,
      sign: amount.sign,
      comment: typeof rawComment === "string" ? rawComment.trim() : rawComment == null ? "" : String(rawComment),
      suggestedType,
      problems,
    };
  });
}

/** Categories named by the file that do not exist yet, de-duplicated by name. */
export function missingCategories(
  rows: readonly ParsedImportRow[],
): Array<{ name: string; type: CategoryType }> {
  const seen = new Map<string, { name: string; type: CategoryType }>();
  for (const row of rows) {
    if (row.categoryId !== 0 || !row.categoryName) continue;
    const key = row.categoryName.toLowerCase();
    if (!seen.has(key)) seen.set(key, { name: row.categoryName, type: row.suggestedType });
  }
  return [...seen.values()];
}

/** A row is importable only when nothing about it is unknown. */
export function isImportable(row: ParsedImportRow): boolean {
  return row.date !== null && row.categoryId !== 0 && row.problems.length === 0;
}

export type DedupeKeyInput = {
  date: DateKey;
  amountCents: Cents;
  /** null for a transfer or a row whose category was deleted. */
  categoryId: number | null;
  comment: string | null | undefined;
};

/**
 * Identity of a transaction for duplicate detection: same calendar day, same
 * magnitude, same category, same comment. Comments are compared case- and
 * whitespace-insensitively because spreadsheets re-export with cosmetic
 * differences ("Coffee  shop" vs "coffee shop").
 */
export function dedupeKey(tx: DedupeKeyInput): string {
  const comment = (tx.comment ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return `${tx.date}|${tx.amountCents}|${tx.categoryId ?? "none"}|${comment}`;
}

export type ImportPlan = {
  /** Rows that will be inserted, in file order. */
  toImport: ParsedImportRow[];
  /** Rows already present in the database (or repeated within the file). */
  duplicates: ParsedImportRow[];
  /** Rows that cannot be imported (bad date / unknown category / bad amount). */
  unusable: ParsedImportRow[];
};

/**
 * Split reviewed rows into insert / duplicate / unusable.
 *
 * `existingKeys` are the `dedupeKey`s already in the database. A row that
 * repeats within the same file is also treated as a duplicate, so importing a
 * file twice — or a file that itself contains a repeated line — never doubles
 * the ledger.
 */
export function planImport(
  rows: readonly ParsedImportRow[],
  existingKeys: Iterable<string>,
): ImportPlan {
  const seen = new Set(existingKeys);
  const plan: ImportPlan = { toImport: [], duplicates: [], unusable: [] };

  for (const row of rows) {
    if (!isImportable(row)) {
      plan.unusable.push(row);
      continue;
    }
    const key = dedupeKey({
      date: row.date as DateKey,
      amountCents: row.amountCents,
      categoryId: row.categoryId,
      comment: row.comment,
    });
    if (seen.has(key)) {
      plan.duplicates.push(row);
      continue;
    }
    seen.add(key);
    plan.toImport.push(row);
  }

  return plan;
}

/** One-line summary of an import, for the UI. */
export function describeImportResult(result: {
  inserted: number;
  duplicates: number;
  unusable: number;
}): string {
  const parts = [`Imported ${result.inserted} transaction${result.inserted === 1 ? "" : "s"}`];
  if (result.duplicates > 0) {
    parts.push(`skipped ${result.duplicates} duplicate${result.duplicates === 1 ? "" : "s"}`);
  }
  if (result.unusable > 0) {
    parts.push(`skipped ${result.unusable} unusable row${result.unusable === 1 ? "" : "s"}`);
  }
  return `${parts.join(", ")}.`;
}
