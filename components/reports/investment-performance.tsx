"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, ChartNoAxesCombined } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { formatMoney, tryParseAmount } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { DateKey } from "@/lib/dates";
import {
  buildInvestmentHistory,
  type InvestmentHistoryInput,
  type InvestmentSeries,
} from "./investment-history";

type Props = {
  rows: readonly InvestmentHistoryInput[];
  range: { startKey: DateKey; endKey: DateKey };
};

export function InvestmentPerformance({ rows, range }: Props) {
  const model = useMemo(() => buildInvestmentHistory(rows, range), [rows, range]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const byKey = useMemo(() => new Map(model.series.map((item) => [item.key, item])), [model.series]);
  const chartConfig = useMemo(
    () =>
      Object.fromEntries(
        model.series.map((item) => [item.key, { label: item.label, color: item.color }]),
      ) satisfies ChartConfig,
    [model.series],
  );
  const visibleCount = model.series.filter((item) => !hidden.has(item.key)).length;

  const toggle = (key: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const InvestmentTooltip = ({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="min-w-44 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground">
        <div className="mb-1.5 font-medium">{label}</div>
        <div className="space-y-1">
          {payload.map((entry) => {
            const item = byKey.get(String(entry.dataKey));
            const cents = tryParseAmount(entry.value);
            if (!item || cents === null) return null;
            return (
              <div key={item.key} className="flex items-center justify-between gap-5">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                  {item.label}
                </span>
                <span className="font-mono font-medium">
                  {formatMoney(cents, item.currency)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Investment performance</CardTitle>
        <CardDescription>
          Daily holding values from the same ledger that produces net worth. Click a holding to
          show or hide its line.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {model.mixedCurrency && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Lines use {model.currencies.join(", ")} without exchange-rate conversion. Compare
              their shapes, not their vertical totals.
            </span>
          </div>
        )}

        {model.series.length === 0 || model.points.length < 2 ? (
          <div className="flex h-72 flex-col items-center justify-center gap-3 text-center">
            <ChartNoAxesCombined className="h-10 w-10 text-muted-foreground" />
            <p className="max-w-lg text-sm text-muted-foreground">
              {rows.length === 0
                ? "No daily investment history has been recorded yet. Run the history backfill, or record net worth on two different days, to start this chart."
                : "This range has fewer than two days of investment history. Choose a wider range."}
            </p>
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Investment lines">
              {model.series.map((item) => {
                const shown = !hidden.has(item.key);
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-pressed={shown}
                    onClick={() => toggle(item.key)}
                    className={cn(
                      "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      !shown && "opacity-40",
                    )}
                  >
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                    {item.label}
                  </button>
                );
              })}
              {visibleCount === 0 && (
                <span className="self-center text-xs text-muted-foreground">All lines hidden</span>
              )}
            </div>

            <div className="h-[28rem]">
              <ChartContainer config={chartConfig} className="h-full w-full">
                <LineChart data={model.points} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    width={82}
                    tickFormatter={(value) => {
                      const cents = tryParseAmount(value);
                      return cents === null
                        ? ""
                        : formatMoney(cents, model.mixedCurrency ? "USD" : model.currencies[0] ?? "USD");
                    }}
                  />
                  <RechartsTooltip content={<InvestmentTooltip />} cursor={false} />
                  {model.series.map((item: InvestmentSeries) => (
                    <Line
                      key={item.key}
                      type="monotone"
                      dataKey={item.key}
                      name={item.label}
                      stroke={item.color}
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                      hide={hidden.has(item.key)}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ChartContainer>
            </div>
          </>
        )}

        {model.droppedCount > 0 && (
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
            {model.droppedCount} stored row{model.droppedCount === 1 ? "" : "s"} had an invalid
            calendar day and could not be plotted.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
