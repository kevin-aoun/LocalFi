"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney, negateCents, sumCents } from "@/lib/money";
import { formatSavingsRate, savingsRate, type CashFlowRow, type ReportPeriod } from "@/lib/reports";
import { periodLabel } from "@/components/reports/report-view-logic";
import { cn } from "@/lib/utils";

type CashFlowTableProps = {
  rows: readonly CashFlowRow[];
  period: ReportPeriod;
  currency: string;
};

export function CashFlowTable({ rows, period, currency }: CashFlowTableProps) {
  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No periods in this range.</p>;
  }

  const incomeCents = sumCents(rows.map((r) => r.incomeCents));
  const expenseCents = sumCents(rows.map((r) => r.expenseCents));
  const netCents = sumCents([incomeCents, negateCents(expenseCents)]);
  const totalRate = savingsRate({ incomeCents, expenseCents });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Period</TableHead>
          <TableHead className="text-right">Money in</TableHead>
          <TableHead className="text-right">Money out</TableHead>
          <TableHead className="text-right">Net</TableHead>
          <TableHead className="text-right">Savings rate</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell className="font-medium">{periodLabel(row.key, period)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums text-green-600">
              {formatMoney(row.incomeCents, currency)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums text-red-600">
              {formatMoney(row.expenseCents, currency)}
            </TableCell>
            <TableCell
              className={cn(
                "text-right font-mono tabular-nums font-medium",
                row.netCents >= 0 ? "text-green-600" : "text-red-600",
              )}
            >
              {formatMoney(row.netCents, currency)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
              {formatSavingsRate(row.savingsRate)}
            </TableCell>
          </TableRow>
        ))}
        <TableRow className="border-t-2 bg-muted/40 hover:bg-muted/40">
          <TableCell className="font-semibold">Total</TableCell>
          <TableCell className="text-right font-mono tabular-nums font-semibold text-green-600">
            {formatMoney(incomeCents, currency)}
          </TableCell>
          <TableCell className="text-right font-mono tabular-nums font-semibold text-red-600">
            {formatMoney(expenseCents, currency)}
          </TableCell>
          <TableCell
            className={cn(
              "text-right font-mono tabular-nums font-semibold",
              netCents >= 0 ? "text-green-600" : "text-red-600",
            )}
          >
            {formatMoney(netCents, currency)}
          </TableCell>
          <TableCell className="text-right font-mono tabular-nums font-semibold">
            {formatSavingsRate(totalRate)}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
