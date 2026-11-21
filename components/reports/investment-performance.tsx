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
import { usePrivacyMode } from "@/components/shared/privacy-provider";
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
  const { enabled: privacyEnabled } = usePrivacyMode();
  const model = useMemo(() => buildInvestmentHistory(rows, range), [rows, range]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const byKey = useMemo(() => new Map(model.series.flatMap((item) => [[item.key, item], [item.costKey, item]] as const)), [model.series]);
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
              <div key={String(entry.dataKey)} className="flex items-center justify-between gap-5">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                  {item.label}{entry.dataKey === item.costKey ? " · net cash invested" : " · value"}
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

  if (privacyEnabled) return <Card><CardHeader><CardTitle>Investment performance</CardTitle><CardDescription>Investment values and returns are hidden in privacy mode.</CardDescription></CardHeader></Card>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Investment performance</CardTitle>
        <CardDescription>
          Solid lines show holding value; matching dashed lines show cash paid, including fees, minus net sale proceeds.
          Above the dashed line means net positive. Click a holding to show or hide both lines.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {model.summaries.length > 0 && (
          <div className="mb-6 divide-y rounded-md border px-4" data-private-value>
            {model.summaries.map((item) => (
              <div key={item.key} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3 text-sm">
                <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} /><span className="font-medium">{item.label}</span></div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 tabular-nums">
                  <span>{formatMoney(item.valueCents, item.currency)} <span className="text-muted-foreground">value</span></span>
                  <span className="text-muted-foreground">{item.costBasisCents === null ? "Purchase cost unavailable" : `${formatMoney(item.costBasisCents, item.currency)} net cash invested`}</span>
                  {item.realizedGainCents !== null && <span className="text-muted-foreground">{formatMoney(item.realizedGainCents, item.currency)} realized</span>}
                  {item.profitLossCents !== null && <span className={item.profitLossCents > 0 ? "font-medium text-emerald-700 dark:text-emerald-400" : item.profitLossCents < 0 ? "font-medium text-destructive" : "font-medium"}>{item.profitLossCents > 0 ? "+" : ""}{formatMoney(item.profitLossCents, item.currency)} · {item.profitLossCents > 0 ? "Net positive" : item.profitLossCents < 0 ? "Net negative" : "Break-even"}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        {model.mixedCurrency && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Lines use {model.currencies.join(", ")} without exchange-rate conversion. Compare
              their shapes, not their vertical totals.
            </span>
          </div>
        )}

        {model.series.length === 0 || model.points.length === 0 ? (
          <div className="flex h-72 flex-col items-center justify-center gap-3 text-center">
            <ChartNoAxesCombined className="h-10 w-10 text-muted-foreground" />
            <p className="max-w-lg text-sm text-muted-foreground">
              {rows.length === 0
                ? "Record a purchase in Transactions to compare its value with what you paid."
                : "No investment history is available in this range. Choose a wider range."}
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
                  {model.series.flatMap((item: InvestmentSeries) => [
                    <Line
                      key={item.key}
                      type="linear"
                      dataKey={item.key}
                      name={item.label}
                      stroke={item.color}
                      strokeWidth={2}
                      dot={model.points.length === 1}
                      connectNulls={false}
                      hide={hidden.has(item.key)}
                      isAnimationActive={false}
                    />,
                    <Line key={item.costKey} type="stepAfter" dataKey={item.costKey} name={`${item.label} · cash invested`} stroke={item.color} strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls={false} hide={hidden.has(item.key)} isAnimationActive={false} />,
                  ])}
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
