"use client";

import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { importTransactions } from "@/app/actions/import";
import { createCategory } from "@/app/actions/categories";
import { Loader2, Upload, FileSpreadsheet, AlertCircle, AlertTriangle } from "lucide-react";
import { centsToDecimal, formatMoney } from "@/lib/money";
import {
  collectDateValues,
  detectDateOrder,
  describeImportResult,
  assertImportFileSize,
  isCsvFilename,
  isImportable,
  isSupportedImportFilename,
  missingCategories,
  parseImportRows,
  planImport,
  readCsvRows,
  readSpreadsheetRows,
  IMPORT_ACCEPT,
  type DateOrderDetection,
  type ParsedImportRow,
  type SpreadsheetRow,
} from "./import-logic";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Category = {
  id: number;
  name: string;
  type: string;
  color: string;
  icon: string;
};

type AccountOption = {
  id: number;
  name: string;
  type: string;
  archived?: boolean;
};

type ImportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: Category[];
  /** Accounts the imported rows can be filed against. Empty is fine. */
  accounts?: AccountOption[];
  /** `getDefaultAccountId()` — pre-selected target account. */
  defaultAccountId?: number | null;
  onSuccess: () => void;
};

/** What the user chose for ambiguous `d/m/y` values. "auto" = trust the file. */
type DateOrder = "auto" | "day-first" | "month-first";

export function ImportDialog({
  open,
  onOpenChange,
  categories,
  accounts = [],
  defaultAccountId = null,
  onSuccess,
}: ImportDialogProps) {
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"upload" | "review">("upload");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  /** Which account the batch is filed against. "" = leave them unassigned. */
  const [accountId, setAccountId] = useState<string>(
    defaultAccountId == null ? "" : String(defaultAccountId),
  );
  /** Name of the file being reviewed, so the review step says what it is reading. */
  const [fileName, setFileName] = useState<string>("");

  /** Raw sheet rows are kept so changing the date order can RE-PARSE the file. */
  const [rawRows, setRawRows] = useState<SpreadsheetRow[]>([]);
  const [detection, setDetection] = useState<DateOrderDetection | null>(null);
  const [dateOrder, setDateOrder] = useState<DateOrder>("auto");
  /** Row numbers the user removed in the review table. */
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  /** Category overrides keyed by row number. */
  const [overrides, setOverrides] = useState<Record<number, number>>({});
  const [showMissingDialog, setShowMissingDialog] = useState(false);
  const [localCategories, setLocalCategories] = useState<Category[]>(categories);

  const effectiveCategories = localCategories.length > 0 ? localCategories : categories;

  /**
   * `dayFirst` is NEVER a silent default. It comes from unambiguous evidence in
   * the file (`detectDateOrder`) unless the user overrides it with the toggle.
   * When the file gives no evidence we fall back to month-first ONLY because
   * something must be chosen — and the toggle is shown prominently so the user
   * can correct it before anything is written.
   */
  const dayFirst =
    dateOrder === "day-first" ? true : dateOrder === "month-first" ? false : detection?.dayFirst ?? false;

  const parsedRows = useMemo(
    () => parseImportRows(rawRows, effectiveCategories, { dayFirst }),
    [rawRows, effectiveCategories, dayFirst],
  );

  /** Apply the review table's edits on top of the parsed rows. */
  const reviewRows: ParsedImportRow[] = useMemo(
    () =>
      parsedRows
        .filter((row) => !removed.has(row.rowNumber))
        .map((row) => {
          const override = overrides[row.rowNumber];
          if (override === undefined || override === row.categoryId) return row;
          const category = effectiveCategories.find((c) => c.id === override);
          return {
            ...row,
            categoryId: override,
            categoryName: category?.name ?? row.categoryName,
            problems: row.problems.filter((p) => !p.startsWith("unknown category") && p !== "missing category"),
          };
        }),
    [parsedRows, removed, overrides, effectiveCategories],
  );

  const plan = useMemo(() => planImport(reviewRows, []), [reviewRows]);
  const pending = missingCategories(reviewRows);

  const resetAll = () => {
    setRawRows([]);
    setDetection(null);
    setDateOrder("auto");
    setRemoved(new Set());
    setOverrides({});
    setStep("upload");
    setError(null);
    setSummary(null);
    setFileName("");
    setLocalCategories(categories);
    setAccountId(defaultAccountId == null ? "" : String(defaultAccountId));
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;

    setError(null);
    setSummary(null);

    try {
      if (!isSupportedImportFilename(file.name)) {
        throw new Error("Choose an .xlsx or .csv file.");
      }
      assertImportFileSize(file.size);

      // The maintained xlsx reader and bounded CSV reader converge on the same
      // review/dedupe pipeline before any row is sent to the server.
      const rows = isCsvFilename(file.name)
        ? readCsvRows(await file.text())
        : await readSpreadsheetRows(file);

      if (rows.length === 0) {
        setError(
          isCsvFilename(file.name)
            ? "That CSV has no data rows (a header row alone is not enough)."
            : "That sheet has no data rows.",
        );
        return;
      }
      const detected = detectDateOrder(collectDateValues(rows));
      setRawRows(rows);
      setFileName(file.name);
      setDetection(detected);
      setDateOrder("auto");
      setRemoved(new Set());
      setOverrides({});
      setStep("review");
    } catch (err) {
      console.error("Failed to parse import file:", err);
      setError(
        err instanceof Error
          ? `Failed to read the file: ${err.message}`
          : "Failed to read the file. Please check the format.",
      );
    }
  };

  const handleCreateMissingCategories = async () => {
    setShowMissingDialog(false);
    setLoading(true);
    setError(null);

    try {
      const created: Category[] = [];
      for (const missing of pending) {
        const formData = new FormData();
        formData.append("name", missing.name);
        formData.append("type", missing.type);
        formData.append("icon", "Wallet");
        formData.append("color", "#10b981");

        const result = await createCategory(formData);
        if ("error" in result && result.error) {
          // Surface it: a rejected category means those rows cannot import.
          setError(`Could not create category "${missing.name}": ${result.error}`);
          return;
        }
        if (result.data) created.push(result.data as Category);
      }
      setLocalCategories([...effectiveCategories, ...created]);
      onSuccess();
    } catch (err) {
      console.error("Failed to create categories:", err);
      setError(err instanceof Error ? err.message : "Failed to create categories.");
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    setLoading(true);
    setError(null);
    setSummary(null);

    try {
      // ONE server action, ONE database write, all-or-nothing.
      const result = await importTransactions(
        plan.toImport.map((row) => ({
          date: row.date as string,
          categoryId: row.categoryId,
          // Decimal string; the action parses it back with tryParseAmount.
          amount: centsToDecimal(row.amountCents).toString(),
          comment: row.comment,
        })),
        // "" means "leave them unassigned" — the explicit bucket, not a guess.
        { accountId: accountId === "" ? null : Number(accountId) },
      );

      if ("error" in result) {
        setError(result.error);
        return;
      }

      setSummary(
        describeImportResult({
          inserted: result.inserted,
          duplicates: result.duplicates + result.repeated + plan.duplicates.length,
          unusable: plan.unusable.length,
        }),
      );
      onSuccess();
      resetAll();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to import transactions:", err);
      setError(err instanceof Error ? err.message : "Failed to import transactions.");
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    resetAll();
    onOpenChange(false);
  };

  const dateOrderHint = (() => {
    if (!detection) return null;
    switch (detection.evidence) {
      case "day-first":
        return "Detected day-first (DD/MM/YYYY) from an unambiguous day in this file.";
      case "month-first":
        return "Detected month-first (MM/DD/YYYY) from an unambiguous day in this file.";
      case "conflict":
        return "This file mixes DD/MM and MM/DD dates. Pick the order that matches your bank.";
      default:
        return detection.samples > 0
          ? "Dates like 03/12/2026 are ambiguous and this file gives no way to tell. Check the order below before importing."
          : null;
    }
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetAll();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[860px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Transactions</DialogTitle>
        </DialogHeader>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {summary && (
          <div className="rounded-md border border-green-600/40 bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-400">
            {summary}
          </div>
        )}

        {step === "upload" && (
          <div className="space-y-4">
            <div className="flex flex-col items-center justify-center py-12 border-2 border-dashed rounded-lg">
              <FileSpreadsheet className="h-12 w-12 text-muted-foreground mb-4" />
              <Label htmlFor="file-upload" className="cursor-pointer">
                <div className="text-center">
                  <span className="text-sm text-muted-foreground">
                    Click to upload or drag and drop
                  </span>
                  <p className="text-xs text-muted-foreground mt-1">
                    Excel or CSV file (.xlsx, .csv)
                  </p>
                </div>
              </Label>
              <Input
                id="file-upload"
                type="file"
                accept={IMPORT_ACCEPT}
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button variant="outline" className="mt-4" asChild>
                <label htmlFor="file-upload">
                  <Upload className="mr-2 h-4 w-4" />
                  Choose File
                </label>
              </Button>
            </div>

            <div className="text-sm text-muted-foreground space-y-2">
              <p className="font-medium">Expected columns:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Date (a real date cell, or YYYY-MM-DD)</li>
                <li>Type (Expense / Income / Investment): optional</li>
                <li>Category (category name)</li>
                <li>Amount (number; a minus sign is fine, the category sets the direction)</li>
                <li>Description (text)</li>
              </ul>
              <p className="text-xs">
                CSV files are read with the same rules as Excel: commas, semicolons and
                tabs are all detected, and ambiguous dates like 03/12/2026 are decided by
                the day/month order you confirm on the next step, never guessed.
              </p>
            </div>
          </div>
        )}

        {step === "review" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="text-sm text-muted-foreground">
                Review {reviewRows.length} row{reviewRows.length !== 1 ? "s" : ""} before importing
                {fileName && <span className="ml-1 font-medium text-foreground">({fileName})</span>}
              </div>

              {accounts.length > 0 && (
                <div className="space-y-1">
                  <Label htmlFor="import-account" className="text-xs">
                    File these into
                  </Label>
                  <Select value={accountId} onValueChange={setAccountId}>
                    <SelectTrigger id="import-account" className="h-8 w-[220px] text-xs">
                      <SelectValue placeholder="Leave unassigned" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts
                        .filter((account) => !account.archived)
                        .map((account) => (
                          <SelectItem key={account.id} value={account.id.toString()}>
                            {account.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-1">
                <Label htmlFor="date-order" className="text-xs">
                  Date order for values like 03/12/2026
                </Label>
                <Select value={dateOrder} onValueChange={(v) => setDateOrder(v as DateOrder)}>
                  <SelectTrigger id="date-order" className="h-8 w-[240px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      Auto{detection?.dayFirst === true
                        ? ": day first"
                        : detection?.dayFirst === false
                        ? ": month first"
                        : ": month first (no evidence)"}
                    </SelectItem>
                    <SelectItem value="day-first">Day first (DD/MM/YYYY)</SelectItem>
                    <SelectItem value="month-first">Month first (MM/DD/YYYY)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {dateOrderHint && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{dateOrderHint}</span>
              </div>
            )}

            {plan.unusable.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  <p className="font-medium">
                    {plan.unusable.length} row{plan.unusable.length !== 1 ? "s" : ""} will be skipped
                  </p>
                  <ul className="mt-1 list-disc list-inside">
                    {plan.unusable.slice(0, 5).map((row) => (
                      <li key={row.rowNumber}>
                        Row {row.rowNumber}: {row.problems.join("; ")}
                      </li>
                    ))}
                    {plan.unusable.length > 5 && <li>…and {plan.unusable.length - 5} more</li>}
                  </ul>
                </div>
              </div>
            )}

            {plan.duplicates.length > 0 && (
              <div className="rounded-md border border-muted bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {plan.duplicates.length} row{plan.duplicates.length !== 1 ? "s" : ""} repeat inside
                this file and will be imported once. Rows that already exist in your ledger are
                skipped automatically.
              </div>
            )}

            {pending.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {pending.length} categor{pending.length === 1 ? "y" : "ies"} in this file
                  {pending.length === 1 ? " does" : " do"} not exist yet:{" "}
                  {pending.map((c) => c.name).join(", ")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-xs"
                  onClick={() => setShowMissingDialog(true)}
                  disabled={loading}
                >
                  Create them
                </Button>
              </div>
            )}

            <div className="border rounded-lg max-h-96 overflow-y-auto">
              <table className="w-full">
                <thead className="bg-muted sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium">#</th>
                    <th className="px-3 py-2 text-left text-xs font-medium">Date</th>
                    <th className="px-3 py-2 text-left text-xs font-medium">Type</th>
                    <th className="px-3 py-2 text-left text-xs font-medium">Category</th>
                    <th className="px-3 py-2 text-right text-xs font-medium">Amount</th>
                    <th className="px-3 py-2 text-left text-xs font-medium">Description</th>
                    <th className="px-3 py-2 text-center text-xs font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewRows.map((row) => {
                    const category = effectiveCategories.find((c) => c.id === row.categoryId);
                    const usable = isImportable(row);
                    return (
                      <tr
                        key={row.rowNumber}
                        className={`border-t hover:bg-muted/50 ${usable ? "" : "bg-destructive/5"}`}
                      >
                        <td className="px-3 py-2 text-xs text-muted-foreground">{row.rowNumber}</td>
                        <td className="px-3 py-2 text-sm">
                          {row.date ?? (
                            <span className="text-destructive">
                              {row.rawDate === "" ? "missing" : `? ${row.rawDate}`}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`text-xs px-2 py-1 rounded border ${
                              row.suggestedType === "Income"
                                ? "border-green-600 text-green-600"
                                : row.suggestedType === "Expense"
                                ? "border-red-600 text-red-600"
                                : "border-blue-600 text-blue-600"
                            }`}
                          >
                            {category?.type ?? row.suggestedType}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <Select
                            value={row.categoryId === 0 ? "" : row.categoryId.toString()}
                            onValueChange={(value) =>
                              setOverrides((prev) => ({ ...prev, [row.rowNumber]: Number(value) }))
                            }
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue placeholder={row.categoryName || "Select…"} />
                            </SelectTrigger>
                            <SelectContent>
                              {effectiveCategories.map((cat) => (
                                <SelectItem key={cat.id} value={cat.id.toString()}>
                                  {cat.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-3 py-2 text-right text-sm font-medium">
                          {formatMoney(row.amountCents)}
                        </td>
                        <td className="px-3 py-2 text-sm" data-privacy-exempt>{row.comment}</td>
                        <td className="px-3 py-2 text-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setRemoved((prev) => new Set(prev).add(row.rowNumber))
                            }
                          >
                            Remove
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between gap-2 pt-4">
              <Button variant="outline" onClick={handleCancel} disabled={loading}>
                Cancel
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("upload")} disabled={loading}>
                  Back
                </Button>
                <Button onClick={handleImport} disabled={loading || plan.toImport.length === 0}>
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Import {plan.toImport.length} Transaction
                  {plan.toImport.length !== 1 ? "s" : ""}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>

      <AlertDialog open={showMissingDialog} onOpenChange={setShowMissingDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-yellow-600" />
              Missing Categories
            </AlertDialogTitle>
            <AlertDialogDescription>
              The following categories don&apos;t exist in your system and will be created:
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="max-h-48 overflow-y-auto">
            <ul className="space-y-2">
              {pending.map((cat) => (
                <li key={cat.name} className="flex items-center justify-between text-sm border-b pb-2">
                  <span className="font-medium">{cat.name}</span>
                  <span className={`text-xs px-2 py-1 rounded border ${
                    cat.type === "Income"
                      ? "border-green-600 text-green-600"
                      : cat.type === "Expense"
                      ? "border-red-600 text-red-600"
                      : "border-blue-600 text-blue-600"
                  }`}>
                    {cat.type}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleCreateMissingCategories} disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create &amp; Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
