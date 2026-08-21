"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Database, Download, FileJson, FileSpreadsheet, Info, Loader2 } from "lucide-react";

import {
  describeDatabaseLocation,
  exportDatabaseFile,
  exportJsonBackup,
  exportTransactionsCsv,
  type DatabaseLocation,
} from "@/app/actions/export";
import { ExportDisclosure } from "@/components/exports/export-disclosure";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { formatRangeLabel } from "@/components/reports/report-view-logic";
import type { KeyRange } from "@/lib/reports";

type ExportCardProps = {
  range: KeyRange;

  currency: string | null;
  mixedCurrency: boolean;
};

function download(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {

    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}


function formatInstant(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function ExportCard({ range, currency, mixedCurrency }: ExportCardProps) {
  const [busy, setBusy] = useState<"csv" | "json" | "db" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [includePending, setIncludePending] = useState(false);
  const [includeTransfers, setIncludeTransfers] = useState(false);
  const [onlyThisCurrency, setOnlyThisCurrency] = useState(true);
  const [location, setLocation] = useState<DatabaseLocation | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);

  useEffect(() => {
    describeDatabaseLocation().then((result) => {
      if ("error" in result) setLocationError(result.error);
      else setLocation(result.data);
    });
  }, []);

  const handleCsv = async () => {
    setBusy("csv");
    setError(null);
    setNote(null);
    try {
      const result = await exportTransactionsCsv({
        fromKey: range.startKey,
        toKey: range.endKey,
        includePending,
        includeTransfers,
        currency: onlyThisCurrency && currency ? currency : undefined,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      const { fileName, csv, rowCount, skipped, currencies } = result.data;
      download(fileName, new Blob([csv], { type: "text/csv;charset=utf-8" }));

      const left = [
        skipped.pending > 0 ? `${skipped.pending} pending` : null,
        skipped.transfers > 0 ? `${skipped.transfers} transfer${skipped.transfers === 1 ? "" : "s"}` : null,
        skipped.otherCurrency > 0 ? `${skipped.otherCurrency} in another currency` : null,
      ].filter((part): part is string => part !== null);

      setNote(
        `${fileName}: ${rowCount} transaction${rowCount === 1 ? "" : "s"}` +
          (left.length > 0 ? `, left out ${left.join(", ")}` : "") +
          (currencies.length > 1 ? `. Contains ${currencies.join(", ")}, no rates applied.` : "."),
      );
    } catch (e) {
      setError((e as Error).message || "Failed to export the CSV.");
    } finally {
      setBusy(null);
    }
  };

  const handleJson = async () => {
    setBusy("json");
    setError(null);
    setNote(null);
    try {
      const result = await exportJsonBackup();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      const { fileName, json, byteLength, counts } = result.data;
      download(fileName, new Blob([json], { type: "application/json;charset=utf-8" }));
      setNote(
        `${fileName} (${formatBytes(byteLength)}): ` +
          `${counts.transactions} transactions, ${counts.accounts} accounts, ` +
          `${counts.categories} categories, ${counts.budgets} budgets, ` +
          `${counts.recurring} recurring, ${counts.assets} assets, ` +
          `${counts.netWorthSnapshots} snapshots.`,
      );
    } catch (e) {
      setError((e as Error).message || "Failed to build the JSON backup.");
    } finally {
      setBusy(null);
    }
  };

  const handleDatabase = async () => {
    setBusy("db");
    setError(null);
    setNote(null);
    try {
      const result = await exportDatabaseFile();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      const { fileName, base64, byteLength } = result.data;
      download(
        fileName,
        new Blob([base64ToBytes(base64) as unknown as BlobPart], {
          type: "application/octet-stream",
        }),
      );
      setNote(`${fileName} (${formatBytes(byteLength)}): encrypted vault generation downloaded.`);
    } catch (e) {
      setError((e as Error).message || "Failed to export the encrypted vault.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-5 w-5" />
          Export &amp; backup
        </CardTitle>
        <CardDescription>
          It is your data and your file. Take it with you.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {note && (
          <div className="flex items-start gap-2 rounded-md border border-green-600/40 bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{note}</span>
          </div>
        )}

        {}
        <div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 font-medium">
                <Database className="h-4 w-4" />
                Encrypted vault copy
              </h3>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                A portable encrypted generation of your complete LocalFi database. It remains
                sensitive, and restoring it requires the vault passphrase or recovery secret.
              </p>
            </div>
            <ExportDisclosure format="database" onConfirm={handleDatabase}>
              <Button disabled={busy !== null}>
                {busy === "db" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                Download encrypted vault
              </Button>
            </ExportDisclosure>
          </div>

          <div className="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {locationError ? (
              <span className="flex items-start gap-2 text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {locationError}
              </span>
            ) : location ? (
              <div className="space-y-1">
                <div>
                  Live file: <code className="font-mono text-foreground">{location.path}</code>
                  {location.exists
                    ? ` · ${formatBytes(location.byteLength)} · last saved ${formatInstant(location.savedAt)}`
                    : " · not created yet"}
                </div>
                <div>
                  Previous generation: <code className="font-mono">{location.backupPath}</code> : kept
                  automatically on every save, so a bad write is recoverable.
                </div>
                <div className="flex items-start gap-2 pt-1">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    The download is snapshotted while the database lock is held and is verified as a
                    complete LocalFi vault envelope. The live and previous generations shown above
                    are encrypted at rest.
                  </span>
                </div>
              </div>
            ) : (
              <span>Locating the database file…</span>
            )}
          </div>
        </div>

        <Separator />

        {}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 font-medium">
              <FileJson className="h-4 w-4" />
              Plaintext JSON data export
            </h3>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Selected portable records (accounts, categories, transactions, budgets, recurring
              templates, assets, net-worth snapshots and settings) as plaintext JSON outside vault
              protection. This omits canonical internal tables and is not a restorable vault backup.
              Amounts are written as decimals (<code className="font-mono">45.50</code>) in each
              row&apos;s own currency; no exchange rate is applied anywhere.
            </p>
          </div>
          <ExportDisclosure format="json" onConfirm={handleJson}>
            <Button variant="outline" disabled={busy !== null}>
              {busy === "json" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              Download JSON
            </Button>
          </ExportDisclosure>
        </div>

        <Separator />

        {}
        <div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 font-medium">
                <FileSpreadsheet className="h-4 w-4" />
                Transactions as CSV
              </h3>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                {formatRangeLabel(range)}. This plaintext, Excel-readable file is outside vault
                protection. The header row is the one this app&apos;s own importer
                reads, so the file round-trips: Date, Category, Amount, Description.
              </p>
            </div>
            <ExportDisclosure format="csv" onConfirm={handleCsv}>
              <Button variant="outline" disabled={busy !== null}>
                {busy === "csv" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                Download CSV
              </Button>
            </ExportDisclosure>
          </div>

          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="csv-pending"
                checked={includePending}
                onCheckedChange={(next) => setIncludePending(next === true)}
              />
              <Label htmlFor="csv-pending" className="text-sm font-normal">
                Include pending transactions
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="csv-transfers"
                checked={includeTransfers}
                onCheckedChange={(next) => setIncludeTransfers(next === true)}
              />
              <Label htmlFor="csv-transfers" className="text-sm font-normal">
                Include transfers
              </Label>
            </div>
            {mixedCurrency && currency && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="csv-currency"
                  checked={onlyThisCurrency}
                  onCheckedChange={(next) => setOnlyThisCurrency(next === true)}
                />
                <Label htmlFor="csv-currency" className="text-sm font-normal">
                  {currency} accounts only
                </Label>
              </div>
            )}
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            Pending rows are off by default, matching how every figure on this page treats them.
            Transfers are off by default because a transfer has no category, so those lines cannot be
            re-imported: they are for the record, not for a round-trip.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
