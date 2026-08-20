"use client";

import { useState } from "react";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  Camera,
  Info,
  LineChart,
  Loader2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import {
  recordNetWorthToday,
  type AccountWithBalance,
  type NetWorthView,
} from "@/app/actions/accounts";
import { describeBalance } from "@/components/accounts/account-form-logic";
import { formatCurrencyTotals } from "@/components/assets/currency-totals";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fromDateKey, isDateKey } from "@/lib/dates";
import { absCents, formatMoney, tryParseAmount } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  buildNetWorthSeries,
  describeSnapshotDrift,
  liabilitiesForDisplay,
  netWorthChangeVsLastMonth,
  netWorthDomain,
  type NetWorthSnapshotRow,
} from "./net-worth-series";

type NetWorthSectionProps = {

  netWorth: NetWorthView;

  accounts: AccountWithBalance[];

  history: readonly NetWorthSnapshotRow[];

  onRecorded: () => void | Promise<void>;
};

function formatDateKey(key: string): string {
  return isDateKey(key) ? fromDateKey(key).toLocaleDateString() : key;
}

const chartConfig = {
  netWorth: { label: "Net worth", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

type BucketMoneyField =
  | "totalAssetsCents"
  | "totalLiabilitiesCents"
  | "netWorthCents"
  | "standaloneAssetsCents";

function bucketLabel(netWorth: NetWorthView, field: BucketMoneyField): string {
  return formatCurrencyTotals(
    netWorth.currencyTotals.map((total) => ({
      currency: total.currency,
      totalCents: total[field],
      count: 1,
    })),
  );
}

function BucketValues({
  netWorth,
  field,
  className,
}: {
  netWorth: NetWorthView;
  field: BucketMoneyField;
  className: string;
}) {
  return (
    <div className="space-y-0.5">
      {netWorth.currencyTotals.map((total) => (
        <div
          key={total.currency}
          className={cn(className, field === "netWorthCents" && total[field] < 0 && "text-red-600 dark:text-red-400")}
        >
          {formatMoney(total[field], total.currency)}
        </div>
      ))}
    </div>
  );
}

export function NetWorthSection({
  netWorth,
  accounts,
  history,
  onRecorded,
}: NetWorthSectionProps) {
  const [snapshotting, setSnapshotting] = useState(false);

  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotNote, setSnapshotNote] = useState<string | null>(null);

  const mixed = netWorth.aggregateCurrency === null;
  const currencies = netWorth.currencyTotals.map((total) => total.currency);
  const series = buildNetWorthSeries(history, netWorth.aggregateCurrency ?? undefined);
  const chartCurrency = series.currency ?? netWorth.aggregateCurrency ?? "USD";
  const change =
    netWorth.aggregate === null
      ? null
      : netWorthChangeVsLastMonth(
          history,
          netWorth.aggregate.netWorthCents,
          new Date(),
          netWorth.aggregate.currency,
        );
  const drift =
    netWorth.aggregate === null
      ? null
      : describeSnapshotDrift(netWorth.aggregate.netWorthCents, series.latest, chartCurrency);
  const domain = netWorthDomain(series.points);

  const liabilities = liabilitiesForDisplay(accounts);

  const handleSnapshot = async () => {
    setSnapshotError(null);
    setSnapshotNote(null);
    setSnapshotting(true);
    try {
      const result = await recordNetWorthToday();

      if (result && "error" in result) {
        setSnapshotError(result.error || "Failed to record net worth.");
        return;
      }
      setSnapshotNote(
        `Recorded ${formatMoney(result.data.netWorthCents, result.data.currency)} for ` +
          `${formatDateKey(result.data.date)}. ${result.data.priceSummary}`,
      );
      await onRecorded();
    } catch (error) {
      console.error("Failed to snapshot net worth:", error);
      setSnapshotError(error instanceof Error ? error.message : "Failed to record net worth.");
    } finally {
      setSnapshotting(false);
    }
  };

  const NetWorthTooltip = ({ active, payload }: { active?: boolean; payload?: any[] }) => {
    if (!active || !payload?.length) return null;
    const point = payload[0]?.payload;
    if (!point) return null;
    return (
      <div className="rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
        <div className="mb-1.5 font-medium">
          {formatDateKey(point.dateKey)}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
          <span>Assets</span>
          <span className="text-right font-mono text-foreground">
            {formatMoney(point.totalAssetsCents, point.currency)}
          </span>
          <span>Liabilities</span>
          <span className="text-right font-mono text-foreground">
            {formatMoney(point.totalLiabilitiesCents, point.currency)}
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-4 border-t pt-1.5 font-medium">
          <span>Net worth</span>
          <span className="font-mono">{formatMoney(point.netWorthCents, point.currency)}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Net worth</h2>
          <p className="text-sm text-muted-foreground">
            Everything you hold minus everything you owe, as of {formatDateKey(netWorth.dateKey)}.
            Same figures as the Accounts page.
          </p>
        </div>
        <Button variant="outline" onClick={handleSnapshot} disabled={snapshotting}>
          {snapshotting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Camera className="mr-2 h-4 w-4" />
          )}
          Record today
        </Button>
      </div>

      {snapshotError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{snapshotError}</span>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-6">
            <div className="text-sm text-muted-foreground">Total assets</div>
            <BucketValues netWorth={netWorth} field="totalAssetsCents" className="mt-1 text-2xl font-bold" />
            <div className="mt-1 text-xs text-muted-foreground">
              Account balances (opening balance included), plus standalone assets (
              {bucketLabel(netWorth, "standaloneAssetsCents")})
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm text-muted-foreground">Total liabilities</div>
            <BucketValues netWorth={netWorth} field="totalLiabilitiesCents" className="mt-1 text-2xl font-bold" />
            <div className="mt-1 text-xs text-muted-foreground">
              What you owe, shown as a positive amount; it reduces net worth
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm text-muted-foreground">Net worth</div>
            <BucketValues netWorth={netWorth} field="netWorthCents" className="mt-1 text-3xl font-bold" />
            {}
            {change ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={cn(
                    "font-medium",
                    change.changeCents >= 0 ? "text-green-600" : "text-red-600",
                  )}
                >
                  {change.changeCents >= 0 ? "+" : "−"}
                  {formatMoney(absCents(change.changeCents), chartCurrency)}
                </span>
                {change.changePercent !== null && (
                  <span
                    className={cn(
                      "flex items-center",
                      change.changeCents >= 0 ? "text-green-600" : "text-red-600",
                    )}
                  >
                    {change.changeCents >= 0 ? (
                      <TrendingUp className="mr-1 h-3 w-3" />
                    ) : (
                      <TrendingDown className="mr-1 h-3 w-3" />
                    )}
                    {Math.abs(change.changePercent).toFixed(1)}%
                  </span>
                )}
                <span className="text-muted-foreground">
                  since {formatDateKey(change.baselineDateKey)}
                </span>
              </div>
            ) : (
              <div className="mt-1 text-xs text-muted-foreground">
                Assets minus liabilities
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {liabilities.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Liabilities counted above
            </div>
            <ul className="divide-y">
              {liabilities.map((account) => {
                const display = describeBalance(account);
                return (
                  <li
                    key={account.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{account.name}</span>
                      <span className="text-xs text-muted-foreground">{account.type}</span>
                      {account.archived && (
                        <span className="text-xs text-muted-foreground">(archived)</span>
                      )}
                    </span>
                    <span
                      className={cn(
                        "font-mono",
                        display.tone === "negative" && "text-red-600 dark:text-red-400",
                      )}
                    >
                      {display.amountLabel}
                      {display.note && (
                        <span className="ml-1 font-sans text-xs text-muted-foreground">
                          {display.note}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="rounded-lg border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">Net worth over time</h3>
          {series.status === "ready" && series.spanChangeCents !== null && series.first && (
            <span className="text-xs text-muted-foreground">
              {series.points.length} recorded days ·{" "}
              <span
                className={cn(
                  "font-medium",
                  series.spanChangeCents >= 0 ? "text-green-600" : "text-red-600",
                )}
              >
                {series.spanChangeCents >= 0 ? "+" : "−"}
                {formatMoney(absCents(series.spanChangeCents), chartCurrency)}
              </span>{" "}
              since {formatDateKey(series.first.dateKey)}
            </span>
          )}
        </div>

        {series.status === "ready" ? (


          <div className="h-72">
            <ChartContainer config={chartConfig} className="h-full w-full">
              <AreaChart
                data={series.points}
                margin={{ top: 10, right: 10, left: 10, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="netWorthFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
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
                  domain={domain}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                  tickFormatter={(value) => {

                    const cents = tryParseAmount(Number(value));
                    return cents === null ? "" : formatMoney(cents, chartCurrency);
                  }}
                />
                <RechartsTooltip content={<NetWorthTooltip />} cursor={false} />
                {domain[0] < 0 && (
                  <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                )}
                <Area
                  type="monotone"
                  dataKey="netWorth"
                  stroke="hsl(var(--chart-1))"
                  strokeWidth={2}
                  fill="url(#netWorthFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ChartContainer>
          </div>
        ) : (
          <div className="flex h-72 flex-col items-center justify-center gap-3 text-center">
            <LineChart className="h-10 w-10 text-muted-foreground" />
            {}
            <p className="max-w-md text-sm text-muted-foreground">{series.message}</p>
            {series.status === "single" && series.latest && (
              <p className="text-sm font-medium">
                {formatMoney(series.latest.netWorthCents, series.latest.currency)} on{" "}
                {formatDateKey(series.latest.dateKey)}
              </p>
            )}
            <Button variant="outline" size="sm" onClick={handleSnapshot} disabled={snapshotting}>
              {snapshotting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Camera className="mr-2 h-4 w-4" />
              )}
              Record a snapshot
            </Button>
          </div>
        )}

        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          {snapshotNote && (
            <p className="font-medium text-green-700 dark:text-green-400">{snapshotNote}</p>
          )}
          {drift && (
            <p className="flex items-start gap-2">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{drift}</span>
            </p>
          )}
          {series.droppedCount > 0 && (
            <p className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                {series.droppedCount} snapshot{series.droppedCount === 1 ? "" : "s"} could not be
                plotted because the stored date is not a calendar day.
              </span>
            </p>
          )}
          {netWorth.currencyTotals.some((total) => total.unassignedCents !== 0) && (
            <p className="flex items-start gap-2">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                {formatCurrencyTotals(
                  netWorth.currencyTotals
                    .filter((total) => total.unassignedCents !== 0)
                    .map((total) => ({
                      currency: total.currency,
                      totalCents: total.unassignedCents,
                      count: 1,
                    })),
                )} of the totals comes from transactions with no account.
              </span>
            </p>
          )}
          {mixed && (
            <Tooltip>
              <TooltipTrigger asChild>
                {}
                <p
                  tabIndex={0}
                  className="flex items-start gap-2 rounded-sm text-amber-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:text-amber-400"
                >
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    Net worth is shown as separate {currencies.join(", ")} buckets. No exchange
                    rates are applied, and no combined amount exists.
                  </span>
                </p>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                No exchange rates are applied. Each displayed amount contains one currency only.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
