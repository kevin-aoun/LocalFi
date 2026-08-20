"use client";

import { AlertTriangle } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMoney } from "@/lib/money";
import { formatPercent, type CategoryBreakdownRow } from "@/lib/reports";
import { categorySwatch, type CategoryColors } from "@/components/reports/category-chart";
import { cn } from "@/lib/utils";

type CategoryBreakdownProps = {
  rows: readonly CategoryBreakdownRow[];

  colors: CategoryColors;
  currency: string;
};

function barWidth(share: number | null): number {
  if (share === null || !Number.isFinite(share)) return 0;
  return Math.max(0, Math.min(100, share * 100));
}

export function CategoryBreakdown({ rows, colors, currency }: CategoryBreakdownProps) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Nothing in this range for the selected direction.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Category</TableHead>
          <TableHead className="w-[40%]">Share</TableHead>
          <TableHead className="text-right">Transactions</TableHead>
          <TableHead className="text-right">Total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.categoryId ?? "none"}-${row.type}`}>
            <TableCell>
              <div className="flex items-center gap-2">
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: categorySwatch(row, colors) }}
                />
                <span className={cn("font-medium", row.uncategorized && "text-muted-foreground")}>
                  {row.name}
                </span>
                {}
                {row.uncategorized && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={0}
                        className="flex items-center gap-1 rounded-sm text-xs font-normal text-amber-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:text-amber-400"
                      >
                        <AlertTriangle className="h-3 w-3" />
                        counts towards nothing
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      This transaction&apos;s category no longer exists, so it counts towards no
                      total anywhere in the app.
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${barWidth(row.share)}%`,
                      backgroundColor: categorySwatch(row, colors),
                    }}
                  />
                </div>
                <span className="w-14 text-right text-sm tabular-nums text-muted-foreground">
                  {formatPercent(row.share)}
                </span>
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">{row.count}</TableCell>
            <TableCell className="text-right font-mono tabular-nums font-medium">
              {formatMoney(row.totalCents, currency)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
