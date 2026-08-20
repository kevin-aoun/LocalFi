"use client";

import { ArrowDown, ArrowUp, Info, Minus } from "lucide-react";

import { formatMoney } from "@/lib/money";
import {
  formatPercent,
  formatSavingsRate,
  savingsRate,
  type FlowComparison,
  type FlowTotals,
  type KeyRange,
} from "@/lib/reports";
import {
  deltaTone,
  formatDelta,
  formatRangeLabel,
} from "@/components/reports/report-view-logic";
import { cn } from "@/lib/utils";

type ComparisonCardProps = {
  comparison: FlowComparison;
  current: FlowTotals;
  previous: FlowTotals;
  currentRange: KeyRange;
  baselineRange: KeyRange;
  currency: string;
};

const TONE_CLASS = {
  good: "text-green-600",
  bad: "text-red-600",
  neutral: "text-muted-foreground",
} as const;

function DeltaRow({
  label,
  metric,
  absoluteCents,
  ratio,
  currentCents,
  previousCents,
  currency,
  previousHasData,
}: {
  label: string;
  metric: "income" | "expense" | "net";
  absoluteCents: number;
  ratio: number | null;
  currentCents: number;
  previousCents: number;
  currency: string;
  previousHasData: boolean;
}) {
  const tone = deltaTone(metric, absoluteCents);
  const Icon = absoluteCents === 0 ? Minus : absoluteCents > 0 ? ArrowUp : ArrowDown;

  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-4 gap-y-1 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{formatMoney(currentCents, currency)}</span>
      <span className="font-mono tabular-nums text-muted-foreground">
        {previousHasData ? formatMoney(previousCents, currency) : "—"}
      </span>
      <span className={cn("flex items-center justify-end gap-1 font-mono tabular-nums", TONE_CLASS[tone])}>
        <Icon className="h-3 w-3" />
        {formatDelta(absoluteCents, currency)}
        <span className="w-16 text-right">{formatPercent(ratio)}</span>
      </span>
    </div>
  );
}

export function ComparisonCard({
  comparison,
  current,
  previous,
  currentRange,
  baselineRange,
  currency,
}: ComparisonCardProps) {
  const currentRate = savingsRate(current);
  const previousRate = savingsRate(previous);

  return (
    <div>
      {}
      <div className="mb-3 grid grid-cols-[1fr_auto_auto_auto] gap-x-4 text-xs uppercase tracking-wide text-muted-foreground">
        <span>Metric</span>
        <span className="text-right">{formatRangeLabel(currentRange)}</span>
        <span className="text-right">{formatRangeLabel(baselineRange)}</span>
        <span className="text-right">Change</span>
      </div>

      <div className="divide-y">
        <DeltaRow
          label="Money in"
          metric="income"
          absoluteCents={comparison.income.absoluteCents}
          ratio={comparison.income.ratio}
          currentCents={current.incomeCents}
          previousCents={previous.incomeCents}
          currency={currency}
          previousHasData={comparison.previousHasData}
        />
        <DeltaRow
          label="Money out"
          metric="expense"
          absoluteCents={comparison.expense.absoluteCents}
          ratio={comparison.expense.ratio}
          currentCents={current.expenseCents}
          previousCents={previous.expenseCents}
          currency={currency}
          previousHasData={comparison.previousHasData}
        />
        <DeltaRow
          label="Net"
          metric="net"
          absoluteCents={comparison.net.absoluteCents}
          ratio={comparison.net.ratio}
          currentCents={current.netCents}
          previousCents={previous.netCents}
          currency={currency}
          previousHasData={comparison.previousHasData}
        />

        <div className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-4 py-2 text-sm">
          <span className="text-muted-foreground">Savings rate</span>
          <span className="font-mono tabular-nums">{formatSavingsRate(currentRate)}</span>
          <span className="font-mono tabular-nums text-muted-foreground">
            {comparison.previousHasData ? formatSavingsRate(previousRate) : "—"}
          </span>
          <span
            className={cn(
              "text-right font-mono tabular-nums",
              comparison.savingsRatePoints === null
                ? "text-muted-foreground"
                : comparison.savingsRatePoints >= 0
                  ? "text-green-600"
                  : "text-red-600",
            )}
          >
            {comparison.savingsRatePoints === null
              ? "—"
              : `${comparison.savingsRatePoints >= 0 ? "+" : ""}${formatPercent(comparison.savingsRatePoints)} pts`}
          </span>
        </div>
      </div>

      {!comparison.previousHasData && (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            There are no counted transactions in {formatRangeLabel(baselineRange)}, so there is no
            percentage to state. The change column shows the current figures themselves.
          </span>
        </p>
      )}
    </div>
  );
}
