"use client";

/**
 * Where the money went (or came from) over the selected range.
 *
 * Shares are a fraction of that DIRECTION's total — a share of money out, never a
 * share of (income + expenses), which is not a quantity. A row whose category was
 * deleted is shown explicitly as uncategorized instead of being dropped: the money
 * is real even when the label is gone.
 */
import { AlertTriangle } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMoney } from "@/lib/money";
import { formatPercent, type CategoryBreakdownRow } from "@/lib/reports";
import { categorySwatch, type CategoryColors } from "@/components/reports/category-chart";
import { cn } from "@/lib/utils";

type CategoryBreakdownProps = {
  rows: readonly CategoryBreakdownRow[];
  /** Category id -> colour. Resolved via `categorySwatch` so the pie matches. */
  colors: CategoryColors;
  currency: string;
};

/** Bar width as a percentage, clamped to something visible and to 100. */
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
                {/*
                  NOT an ordinary hint. This says the owner's money is sitting in
                  a row that no budget, no category total and no report will ever
                  count — and the only thing on screen without hovering is the
                  three words "counts towards nothing".

                  Converted from `title=` so it at least renders consistently and
                  is reachable by keyboard (`tabIndex={0}`, because a bare span is
                  not focusable and Radix only opens on hover or focus). It is
                  still hover-only for a mouse user and still invisible on touch,
                  where tooltips never fire at all. Flagged for the owner: this
                  sentence probably wants to be visible text or a banner, not a
                  tooltip.
                */}
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
