
import {
  parseFlexibleDate,
  toDateKey,
  type DateKey,
} from "@/lib/dates";
import { absCents, tryParseAmount, type Cents } from "@/lib/money";

export type SpreadsheetRow = Record<string, unknown>;

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

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


export type DateOrderEvidence =

  | "day-first"

  | "month-first"

  | "conflict"

  | "none";

export type DateOrderDetection = {

  dayFirst: boolean | null;
  evidence: DateOrderEvidence;

  samples: number;
};


const SLASHED_RE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/;


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


  const { readSheet } = await import("read-excel-file/browser");
  const matrix = await readSheet(buffer);
  return spreadsheetMatrixToRows(matrix as unknown as readonly (readonly SpreadsheetCell[])[]);
}


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


export function readCsvRows(text: string): SpreadsheetRow[] {
  if (typeof text !== "string") return [];
  assertImportFileSize(new TextEncoder().encode(text).byteLength);
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (withoutBom.trim() === "") return [];
  return spreadsheetMatrixToRows(csvMatrix(withoutBom));
}


export const IMPORT_ACCEPT = ".xlsx,.csv" as const;


export function isCsvFilename(name: string): boolean {
  return typeof name === "string" && /\.csv$/i.test(name.trim());
}

export function isSupportedImportFilename(name: string): boolean {
  return typeof name === "string" && /\.(?:xlsx|csv)$/i.test(name.trim());
}


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

  amountCents: Cents;

  sign: -1 | 0 | 1;

  inferredType: CategoryType;

  invalid: boolean;
};


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

  rowNumber: number;

  date: DateKey | null;

  rawDate: string;
  categoryId: number;
  categoryName: string;

  amountCents: Cents;

  sign: -1 | 0 | 1;
  comment: string;

  suggestedType: CategoryType;

  problems: string[];
};

export type ParseOptions = {

  dayFirst: boolean;
};


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



    const suggestedType: CategoryType =
      (category ? normalizeType(category.type) : null) ??
      normalizeType(rawType) ??
      amount.inferredType;

    if (!category) problems.push(categoryName ? `unknown category "${categoryName}"` : "missing category");

    return {
      rowNumber: index + 2,
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


export function isImportable(row: ParsedImportRow): boolean {
  return row.date !== null && row.categoryId !== 0 && row.problems.length === 0;
}

export type DedupeKeyInput = {
  date: DateKey;
  amountCents: Cents;

  categoryId: number | null;
  accountId?: number | null;
  currency?: string | null;
  direction?: "inflow" | "outflow" | "transfer";
  comment: string | null | undefined;
};


export function dedupeKey(tx: DedupeKeyInput): string {
  const comment = (tx.comment ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const account = tx.accountId ?? "unassigned";
  const currency = (tx.currency ?? "USD").trim().toUpperCase();
  const direction = tx.direction ?? "legacy";
  return `${tx.date}|${tx.amountCents}|${tx.categoryId ?? "none"}|${account}|${currency}|${direction}|${comment}`;
}

export type ImportPlan = {

  toImport: ParsedImportRow[];

  duplicates: ParsedImportRow[];

  unusable: ParsedImportRow[];
};


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
