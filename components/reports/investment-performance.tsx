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
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePrivacyMode } from "@/components/shared/privacy-provider";
import { formatMoney, tryParseAmount, type Cents } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { DateKey } from "@/lib/dates";
import {
  TOTAL_KEY,
  buildInvestmentHistory,
  isolateLine,
  summarizeTotals,
  type InvestmentHistoryInput,
  type InvestmentLine,
  type InvestmentSeries,
} from "./investment-history";

type Props = {
  rows: readonly InvestmentHistoryInput[];
  range: { startKey: DateKey; endKey: DateKey };
};

function gainTone(cents: number) {
  return cents > 0 ? "text-emerald-700 dark:text-emerald-400" : cents < 0 ? "text-destructive" : undefined;
}

function SignedMoney({ cents, currency }: { cents: number; currency: string }) {
  return <>{cents > 0 ? "+" : ""}{formatMoney(cents, currency)}</>;
}

const UNKNOWN_COST = "Opened without a cash purchase, so its cost is unknown.";

function MoneyCell({ cents, currency, signed, className }: { cents: Cents | null | undefined; currency: string; signed?: boolean; className?: string }) {
  if (cents === undefined) return <TableCell />;
  if (cents === null) return <TableCell className="text-right text-muted-foreground" title={UNKNOWN_COST}>Unknown</TableCell>;
  return (
    <TableCell className={cn("text-right", signed && gainTone(cents), className)}>
      {signed ? <SignedMoney cents={cents} currency={currency} /> : formatMoney(cents, currency)}
    </TableCell>
  );
}

export function InvestmentPerformance({ rows, range }: Props) {
  const { enabled: privacyEnabled } = usePrivacyMode();
  const model = useMemo(() => buildInvestmentHistory(rows, range), [rows, range]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  const totals = useMemo(() => summarizeTotals(model.summaries), [model.summaries]);
  const lines = useMemo<InvestmentLine[]>(
    () => (model.total ? [model.total, ...model.series] : model.series),
    [model.total, model.series],
  );
  const byKey = useMemo(
    () => new Map<string, InvestmentLine>([
      ...lines.map((item) => [item.key, item] as const),
      ...model.series.map((item) => [item.costKey, item] as const),
    ]),
    [lines, model.series],
  );
  const chartConfig = useMemo(
    () =>
      Object.fromEntries(
        lines.map((item) => [item.key, { label: item.label, color: item.color }]),
      ) satisfies ChartConfig,
    [lines],
  );
  const visibleCount = lines.filter((item) => !hidden.has(item.key)).length;

  const toggle = (key: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isolate = (key: string) => {
    setHidden((current) => isolateLine(lines.map((item) => item.key), current, key));
  };

  const InvestmentTooltip = ({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) => {
    // Only the line under the pointer, with its cost basis when it has one.
    const entries = (payload ?? []).filter((entry) => byKey.get(String(entry.dataKey))?.key === hovered);
    if (!active || entries.length === 0) return null;
    return (
      <div className="min-w-44 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground">
        <div className="mb-1.5 font-medium">{label}</div>
        <div className="space-y-1">
          {entries.map((entry) => {
            const item = byKey.get(String(entry.dataKey));
            const cents = tryParseAmount(entry.value);
            if (!item || cents === null) return null;
            return (
              <div key={String(entry.dataKey)} className="flex items-center justify-between gap-5">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                  {item.label}{item.key === TOTAL_KEY ? "" : entry.dataKey === item.key ? " · value" : " · cost basis"}
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
          Solid lines show market value; matching dashed lines show what the units still held cost, at average price including fees.
          The gap is the unrealized gain. Sales move gains into realized; total return adds both. Hover a line for its values. Click a legend entry to show or hide it; double-click to show only that line.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {model.summaries.length > 0 && (
          <div className="mb-6 rounded-md border" data-private-value>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Holding</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">Cost basis</TableHead>
                  <TableHead className="text-right">Unrealized</TableHead>
                  <TableHead className="text-right">Realized</TableHead>
                  <TableHead className="text-right">Total return</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="tabular-nums">
                {model.summaries.map((item) => (
                  <TableRow key={item.key}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                        <span className="font-medium">{item.label}</span>
                        {item.closed && <span className="text-xs text-muted-foreground">Sold</span>}
                      </span>
                    </TableCell>
                    <MoneyCell cents={item.closed ? undefined : item.valueCents} currency={item.currency} />
                    <MoneyCell cents={item.closed ? undefined : item.costBasisCents} currency={item.currency} className="text-muted-foreground" />
                    <MoneyCell cents={item.closed ? undefined : item.unrealizedGainCents} currency={item.currency} signed />
                    <MoneyCell cents={item.realizedGainCents} currency={item.currency} signed />
                    <MoneyCell cents={item.totalReturnCents} currency={item.currency} signed className="font-medium" />
                  </TableRow>
                ))}
              </TableBody>
              {totals && model.summaries.length > 1 && (
                <TableFooter className="tabular-nums">
                  <TableRow>
                    <TableCell className="font-medium">Total portfolio</TableCell>
                    <MoneyCell cents={totals.valueCents} currency={totals.currency} className="font-medium" />
                    <MoneyCell cents={totals.costBasisCents} currency={totals.currency} className="text-muted-foreground" />
                    <MoneyCell cents={totals.unrealizedGainCents} currency={totals.currency} signed />
                    <MoneyCell cents={totals.realizedGainCents} currency={totals.currency} signed />
                    <MoneyCell cents={totals.totalReturnCents} currency={totals.currency} signed className="font-medium" />
                  </TableRow>
                </TableFooter>
              )}
            </Table>
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
              {lines.map((item) => {
                const shown = !hidden.has(item.key);
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-pressed={shown}
                    title="Click to show or hide. Double-click to show only this line."
                    onClick={() => toggle(item.key)}
                    onDoubleClick={() => isolate(item.key)}
                    className={cn(
                      "flex select-none items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
                      activeDot={hovered === item.key}
                      connectNulls={false}
                      hide={hidden.has(item.key)}
                      isAnimationActive={false}
                    />,
                    <Line key={item.costKey} type="stepAfter" dataKey={item.costKey} name={`${item.label} · cost basis`} stroke={item.color} strokeWidth={2} strokeDasharray="6 4" dot={false} activeDot={hovered === item.key} connectNulls={false} hide={hidden.has(item.key)} isAnimationActive={false} />,
                  ])}
                  {model.total && (
                    <Line
                      key={TOTAL_KEY}
                      type="linear"
                      dataKey={TOTAL_KEY}
                      name={model.total.label}
                      stroke={model.total.color}
                      strokeWidth={2.5}
                      dot={model.points.length === 1}
                      activeDot={hovered === TOTAL_KEY}
                      hide={hidden.has(TOTAL_KEY)}
                      isAnimationActive={false}
                    />
                  )}
                  {/* Invisible wide strokes on top make thin lines easy to hover. */}
                  {[
                    ...model.series.flatMap((item) => [
                      { dataKey: item.key, owner: item.key, type: "linear" as const },
                      { dataKey: item.costKey, owner: item.key, type: "stepAfter" as const },
                    ]),
                    ...(model.total ? [{ dataKey: TOTAL_KEY, owner: TOTAL_KEY, type: "linear" as const }] : []),
                  ].map((hit) => (
                    <Line
                      key={`hit_${hit.dataKey}`}
                      type={hit.type}
                      dataKey={hit.dataKey}
                      stroke="transparent"
                      strokeWidth={14}
                      dot={false}
                      activeDot={false}
                      legendType="none"
                      tooltipType="none"
                      connectNulls={false}
                      hide={hidden.has(hit.owner)}
                      isAnimationActive={false}
                      onMouseEnter={() => setHovered(hit.owner)}
                      onMouseLeave={() => setHovered(null)}
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
