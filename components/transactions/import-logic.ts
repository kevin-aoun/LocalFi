/**
 * Pure logic behind `import-dialog.tsx`: read a spreadsheet, turn its rows into
 * transactions, and decide what to skip. No React, no DOM, no server actions —
 * so every rule below is unit-testable, including under extreme timezones.
 *
 * ## Formats and trust boundary
 *
 * `.xlsx` is read by the maintained `read-excel-file` parser. CSV has a small
 * RFC-4180-style reader because `read-excel-file` intentionally only handles
 * xlsx. Both readers feed the same row conversion and parse/dedupe pipeline.
 * File bytes and data rows are bounded before anything can reach the server
 * action, and the server independently enforces the row bound.
 *
 * ## The three bugs this module exists to prevent
 *
 * 1. **Inverted signs.** A bank export writes an expense as `-45.00`. The old
 *    dialog stored that `-4500` verbatim while the transaction's DIRECTION came
 *    from `category.type`, so an Expense row of `-45.00` *increased* cash by
 *    $45. See `resolveAmount` for the rule that replaced it.
 *
 * 2. **Corrupted dates.** Spreadsheet date cells arrive from
 *    `read-excel-file` as UTC `Date`s and are immediately normalized to an ISO
 *    calendar-day string. Plain strings and unformatted serials continue
 *    through `parseFlexibleDate`, so timezone and date-order rules remain ours.
 *
 * 3. **Silent wrong-but-plausible days.** `parseFlexibleDate` defaults to US
 *    `MM/DD`, which misreads every EU/Lebanese export. So `dayFirst` is never
 *    left to a default: `detectDateOrder` looks for unambiguous evidence in the
 *    file itself, and the dialog exposes an explicit toggle seeded from it.
 *    A row whose date cannot be read is REPORTED, never silently replaced with
 *    today's date (which is what the old code did).
 */
import {
  parseFlexibleDate,
  toDateKey,
  type DateKey,
} from "@/lib/dates";
import { absCents, tryParseAmount, type Cents } from "@/lib/money";

export type SpreadsheetRow = Record<string, unknown>;

/** Hard bounds for untrusted import input. Keep the server row check in place. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
/** Upper bound for the sum of ZIP central-directory uncompressed entry sizes. */
export const MAX_IMPORT_EXPANDED_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5_000;
const MAX_IMPORT_COLUMNS = 100;

export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

export function assertImportFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ImportFileError("Could not determine the import file size.");
  }
  if (size > MAX_IMPORT_FILE_BYTES) {
    throw new ImportFileError(
      `The import file is too large. Maximum size is ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MiB.`,
    );
  }
}

function assertImportRowCount(count: number): void {
  if (count > MAX_IMPORT_ROWS) {
    throw new ImportFileError(
      `The import contains too many rows. Maximum is ${MAX_IMPORT_ROWS.toLocaleString("en-US")} data rows.`,
    );
  }
}

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

type SpreadsheetCell = string | number | boolean | Date | null;

function isoDayFromUtcDate(value: Date): string {
  return [
    String(value.getUTCFullYear()).padStart(4, "0"),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Header + cell matrix -> the object shape consumed by the review pipeline. */
export function spreadsheetMatrixToRows(
  matrix: readonly (readonly SpreadsheetCell[])[],
): SpreadsheetRow[] {
  if (matrix.length === 0) return [];
  const headers = matrix[0];
  if (headers.length > MAX_IMPORT_COLUMNS) {
    throw new ImportFileError(`The import has too many columns. Maximum is ${MAX_IMPORT_COLUMNS}.`);
  }
  const data = matrix.slice(1).filter((row) => row.some((cell) => cell !== null && cell !== ""));
  assertImportRowCount(data.length);

  return data.map((cells) => {
    if (cells.length > MAX_IMPORT_COLUMNS) {
      throw new ImportFileError(`The import has too many columns. Maximum is ${MAX_IMPORT_COLUMNS}.`);
    }
    const row: SpreadsheetRow = Object.create(null) as SpreadsheetRow;
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      if (header === null || String(header).trim() === "") continue;
      const cell = cells[index] ?? null;
      row[String(header)] = cell instanceof Date ? isoDayFromUtcDate(cell) : cell;
    }
    return row;
  });
}

const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP64_SENTINEL = 0xffffffff;

function findZipEnd(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_SIGNATURE) return offset;
  }
  throw new ImportFileError("The XLSX archive has no valid central directory.");
}

/**
 * Reject a ZIP bomb from declared central-directory metadata before any entry
 * is inflated by `read-excel-file`. ZIP64 and multi-disk inputs are refused
 * because this small browser-side gate cannot bound them safely.
 */
export function assertXlsxDeclaredExpandedSize(data: ArrayBuffer): void {
  const view = new DataView(data);
  const endOffset = findZipEnd(view);
  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entryCount === 0xffff ||
    centralSize === ZIP64_SENTINEL ||
    centralOffset === ZIP64_SENTINEL
  ) {
    throw new ImportFileError("ZIP64 or multi-disk XLSX archives are not supported.");
  }
  if (centralOffset + centralSize > view.byteLength || centralOffset + centralSize > endOffset) {
    throw new ImportFileError("The XLSX central directory is invalid.");
  }

  let offset = centralOffset;
  let totalExpandedBytes = 0;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_FILE_SIGNATURE) {
      throw new ImportFileError("The XLSX central directory is invalid.");
    }
    const expandedBytes = view.getUint32(offset + 24, true);
    if (expandedBytes === ZIP64_SENTINEL) {
      throw new ImportFileError("ZIP64 XLSX entries are not supported.");
    }
    totalExpandedBytes += expandedBytes;
    if (!Number.isSafeInteger(totalExpandedBytes) || totalExpandedBytes > MAX_IMPORT_EXPANDED_BYTES) {
      throw new ImportFileError(
        `The XLSX archive expands beyond the ${MAX_IMPORT_EXPANDED_BYTES / 1024 / 1024} MiB limit.`,
      );
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) {
    throw new ImportFileError("The XLSX central directory size is inconsistent.");
  }
}

async function readXlsxRows(data: File | Blob | ArrayBuffer): Promise<SpreadsheetRow[]> {
  const buffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  assertXlsxDeclaredExpandedSize(buffer);
  // Dynamic so the server action can reuse pure `dedupeKey` without evaluating
  // browser-only file APIs. This function is called only by the client dialog.
  const { readSheet } = await import("read-excel-file/browser");
  const matrix = await readSheet(buffer);
  return spreadsheetMatrixToRows(matrix as unknown as readonly (readonly SpreadsheetCell[])[]);
}

/**
 * Read the first sheet of a maintained-parser `.xlsx` input.
 *
 * The Buffer overload preserves one legacy report round-trip that feeds CSV
 * bytes through this function. New UI code routes CSV text to `readCsvRows`.
 */
export function readSpreadsheetRows(data: Buffer): SpreadsheetRow[];
export function readSpreadsheetRows(
  data: File | Blob | ArrayBuffer | Uint8Array,
): Promise<SpreadsheetRow[]>;
export function readSpreadsheetRows(
  data: File | Blob | ArrayBuffer | Uint8Array,
): SpreadsheetRow[] | Promise<SpreadsheetRow[]> {
  if (data instanceof Uint8Array) {
    assertImportFileSize(data.byteLength);
    const isZip = data[0] === 0x50 && data[1] === 0x4b;
    if (!isZip) return readCsvRows(new TextDecoder().decode(data));
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    return readXlsxRows(buffer);
  }
  if (data instanceof ArrayBuffer) assertImportFileSize(data.byteLength);
  else assertImportFileSize(data.size);
  return readXlsxRows(data);
}

function delimiterFor(text: string): "," | ";" | "\t" {
  const counts = new Map<"," | ";" | "\t", number>([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && (char === "\n" || char === "\r")) {
      break;
    } else if (!quoted && counts.has(char as "," | ";" | "\t")) {
      const delimiter = char as "," | ";" | "\t";
      counts.set(delimiter, counts.get(delimiter)! + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function csvMatrix(text: string): SpreadsheetCell[][] {
  const delimiter = delimiterFor(text);
  const rows: SpreadsheetCell[][] = [];
  let row: SpreadsheetCell[] = [];
  let cell = "";
  let quoted = false;

  const finishCell = () => {
    row.push(cell);
    cell = "";
    if (row.length > MAX_IMPORT_COLUMNS) {
      throw new ImportFileError(`The import has too many columns. Maximum is ${MAX_IMPORT_COLUMNS}.`);
    }
  };
  const finishRow = () => {
    finishCell();
    if (row.some((value) => value !== "")) rows.push(row);
    row = [];
    if (rows.length > MAX_IMPORT_ROWS + 1) assertImportRowCount(rows.length - 1);
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      finishCell();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      finishRow();
    } else {
      cell += char;
    }
  }
  if (quoted) throw new ImportFileError("The CSV contains an unterminated quoted field.");
  if (cell !== "" || row.length > 0) finishRow();
  return rows;
}

/** Read bounded CSV text without guessing cell types or date order. */
export function readCsvRows(text: string): SpreadsheetRow[] {
  if (typeof text !== "string") return [];
  assertImportFileSize(new TextEncoder().encode(text).byteLength);
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (withoutBom.trim() === "") return [];
  return spreadsheetMatrixToRows(csvMatrix(withoutBom));
}

/** Extensions the import dialog accepts. Legacy binary `.xls` is unsupported. */
export const IMPORT_ACCEPT = ".xlsx,.csv" as const;

/** True for a `.csv` filename — the only case that needs the text reader. */
export function isCsvFilename(name: string): boolean {
  return typeof name === "string" && /\.csv$/i.test(name.trim());
}

export function isSupportedImportFilename(name: string): boolean {
  return typeof name === "string" && /\.(?:xlsx|csv)$/i.test(name.trim());
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
  accountId?: number | null;
  currency?: string | null;
  direction?: "inflow" | "outflow" | "transfer";
  comment: string | null | undefined;
};

/**
 * Identity of a transaction for duplicate detection: same calendar day,
 * magnitude, category, account, denomination, stored direction, and comment.
 * Optional compatibility defaults model an unassigned USD row; server callers
 * always pass all three historical/file-location fields. Comments are compared case- and
 * whitespace-insensitively because spreadsheets re-export with cosmetic
 * differences ("Coffee  shop" vs "coffee shop").
 */
export function dedupeKey(tx: DedupeKeyInput): string {
  const comment = (tx.comment ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const account = tx.accountId ?? "unassigned";
  const currency = (tx.currency ?? "USD").trim().toUpperCase();
  const direction = tx.direction ?? "legacy";
  return `${tx.date}|${tx.amountCents}|${tx.categoryId ?? "none"}|${account}|${currency}|${direction}|${comment}`;
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
