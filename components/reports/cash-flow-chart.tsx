"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { centsToDecimal, formatMoney, tryParseAmount, type Cents } from "@/lib/money";
import { formatSavingsRate } from "@/lib/reports";
import type { CashFlowChartRow } from "@/components/reports/report-view-logic";

const chartConfig = {
  income: { label: "Money in", color: "hsl(142 71% 45%)" },
  expense: { label: "Money out", color: "hsl(0 72% 51%)" },
  net: { label: "Net", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

type CashFlowChartProps = {
  rows: CashFlowChartRow[];
  currency: string;
};

function CashFlowTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ payload?: CashFlowChartRow }>;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  return (
    <div className="rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
      <div className="mb-1.5 font-medium">{row.label}</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
        <span>Money in</span>
        <span className="text-right font-mono text-green-600">
          {formatMoney(row.incomeCents, currency)}
        </span>
        <span>Money out</span>
        <span className="text-right font-mono text-red-600">
          {formatMoney(row.expenseCents, currency)}
        </span>
        <span>Net</span>
        <span className="text-right font-mono text-foreground">
          {formatMoney(row.netCents, currency)}
        </span>
        <span>Savings rate</span>
        <span className="text-right font-mono text-foreground">
          {formatSavingsRate(row.savingsRate)}
        </span>
      </div>
    </div>
  );
}

export function CashFlowChart({ rows, currency }: CashFlowChartProps) {
  if (rows.length === 0) {
    return (
      <div className="flex h-72 w-full items-center justify-center text-sm text-muted-foreground">
        No transactions in this range.
      </div>
    );
  }

  return (
    <ChartContainer config={chartConfig} className="h-72 w-full">
      <ComposedChart data={rows} margin={{ top: 10, right: 12, left: 12, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" opacity={0.3} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
          tickFormatter={(value) => {

            const cents = tryParseAmount(Number(value));
            return cents === null ? "" : formatMoney(cents, currency);
          }}
        />
        <ReferenceLine y={0} stroke="hsl(var(--border))" />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }}
          content={<CashFlowTooltip currency={currency} />}
        />
        <Bar dataKey="income" fill="var(--color-income)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="expense" fill="var(--color-expense)" radius={[0, 0, 3, 3]} isAnimationActive={false} />
        <Line
          type="monotone"
          dataKey="net"
          stroke="var(--color-net)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}

export function IncomeVsExpenseChart({
  incomeCents,
  expenseCents,
  currency,
}: {
  incomeCents: Cents;
  expenseCents: Cents;
  currency: string;
}) {

  const data = [
    { name: "Money in", value: centsToDecimal(incomeCents), cents: incomeCents, fill: "hsl(142 71% 45%)" },
    { name: "Money out", value: centsToDecimal(expenseCents), cents: expenseCents, fill: "hsl(0 72% 51%)" },
  ];

  return (
    <ChartContainer config={chartConfig} className="h-48 w-full">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
        <CartesianGrid horizontal={false} stroke="hsl(var(--border))" opacity={0.3} />
        <XAxis
          type="number"
          tickLine={false}
          axisLine={false}
          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
          tickFormatter={(value) => {
            const cents = tryParseAmount(Number(value));
            return cents === null ? "" : formatMoney(cents, currency);
          }}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={80}
          tickLine={false}
          axisLine={false}
          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
        />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0]?.payload as { name: string; cents: number } | undefined;
            if (!row) return null;
            return (
              <div className="rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
                <span className="text-muted-foreground">{row.name}: </span>
                <span className="font-mono">{formatMoney(row.cents, currency)}</span>
              </div>
            );
          }}
        />
        <Bar dataKey="value" radius={[0, 3, 3, 0]} isAnimationActive={false}>
          {data.map((row) => (
            <Cell key={row.name} fill={row.fill} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
