"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { deleteAsset, getAssets, setAssetArchived } from "@/app/actions/assets";
import { getCategories } from "@/app/actions/categories";
import { getSettings } from "@/app/actions/settings";
import {
  getAccountBalances,
  getLedgerCashMovements,
  getNetWorth,
  getNetWorthHistory,
  type AccountWithBalance,
  type NetWorthView,
} from "@/app/actions/accounts";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, ArchiveRestore, EyeOff, TrendingUp, TrendingDown, Plus, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Tooltip as RechartsTooltip } from "recharts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { AssetDialog } from "@/components/assets/asset-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useDashboardStore } from "@/lib/stores/dashboard-store";
import { deriveCashBalancesByCurrency } from "@/lib/cash-balance";
import { absCents, centsToDecimal, formatMoney, tryParseAmount, type Cents } from "@/lib/money";
import {
  buildCashCandles,
  computeCashGrowth,
  formatPeriodLabel,
  localDayFromKey,
  type ChartPeriod,
} from "@/components/dashboard/cash-series";
import { NetWorthSection } from "@/components/dashboard/net-worth-section";
import type { NetWorthSnapshotRow } from "@/components/dashboard/net-worth-series";
import { barWidth, formatShare } from "@/components/assets/currency-totals";
import {
  assetCategoryColor,
  buildAssetTable,
  withHidden,
} from "@/components/dashboard/asset-table";
import { AssetFilterNotice, AssetTable } from "@/components/dashboard/asset-table-card";
import { fromDateKey, todayKey } from "@/lib/dates";

export default function DashboardPage() {
  const {
    assets,
    setAssets,
    dialogOpen,
    setDialogOpen,
    deleteDialogOpen,
    setDeleteDialogOpen,
    selectedAsset,
    assetToDelete,
    openAddDialog,
    openEditDialog,
    openDeleteDialog,
  } = useDashboardStore();

  const [transactions, setTransactions] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [userName, setUserName] = useState<string>("");
  const [chartPeriod, setChartPeriod] = useState<ChartPeriod>("monthly");
  const [cashCurrency, setCashCurrency] = useState("USD");

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [assetActionError, setAssetActionError] = useState<string | null>(null);

  const [netWorth, setNetWorth] = useState<NetWorthView | null>(null);
  const [accountRows, setAccountRows] = useState<AccountWithBalance[]>([]);

  const [history, setHistory] = useState<NetWorthSnapshotRow[]>([]);

  const [hiddenHoldings, setHiddenHoldings] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const hideHoldings = (keys: string[]) =>
    setHiddenHoldings((current) => withHidden(current, keys, true));
  const showHoldings = (keys: string[]) =>
    setHiddenHoldings((current) => withHidden(current, keys, false));
  const showAllHoldings = () => setHiddenHoldings(new Set<string>());

  const loadData = useCallback(async () => {
    const [
      assetsData,
      transactionsData,
      categoriesData,
      settingsData,
      netWorthData,
      accountsData,
      historyData,
    ] = await Promise.all([
      getAssets({ includeArchived: true }),
      getLedgerCashMovements(),
      getCategories(),
      getSettings(),
      getNetWorth(),

      getAccountBalances({ includeArchived: true }),
      getNetWorthHistory(),
    ]);
    setAssets(assetsData);
    setTransactions(transactionsData);
    setCategories(categoriesData);
    setUserName(settingsData.userName || "");
    setNetWorth(netWorthData);
    setAccountRows(accountsData);
    setHistory(historyData);
  }, [setAssets]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const loadAssets = async () => {
    const data = await getAssets({ includeArchived: true });
    setAssets(data);
  };

  const handleDelete = async () => {
    if (!assetToDelete) return;

    const result = await deleteAsset(assetToDelete, { confirmed: true });

    if (result && "error" in result && result.error) {
      setDeleteError(result.error);
      return;
    }

    setDeleteError(null);
    await loadData();
    setDeleteDialogOpen(false);
  };

  const handleAssetArchived = async (assetId: number, archived: boolean) => {
    setAssetActionError(null);
    const result = await setAssetArchived(assetId, archived);
    if ("error" in result) {
      setAssetActionError(result.error || "Failed to update the holding.");
      return;
    }
    await loadData();
  };

  const cashBalances = deriveCashBalancesByCurrency(transactions, categories);
  const cashCurrencies = cashBalances.map((balance) => balance.currency);
  const selectedCashCurrency = cashCurrencies.includes(cashCurrency)
    ? cashCurrency
    : cashCurrencies[0] ?? "USD";
  const cashBalanceCents =
    cashBalances.find((balance) => balance.currency === selectedCashCurrency)?.balanceCents ?? 0;

  const assetView = buildAssetTable({
    assets,

    accounts: accountRows,
    hidden: hiddenHoldings,
  });
  const mixedCurrency = assetView.mixed;

  const hasDerivedCashAsset = assetView.derivedCashCount > 0;

  const { growthAmountCents, growthPercent, baselineCents } = computeCashGrowth(
    transactions,
    categories,
    fromDateKey(todayKey()),
    selectedCashCurrency,
  );

  const candlestickData = buildCashCandles(
    transactions,
    categories,
    chartPeriod,
    selectedCashCurrency,
  ).map((candle) => ({
    ...candle,
    formattedPeriod: formatPeriodLabel(candle.period, chartPeriod),

    bodyRange: [
      centsToDecimal(Math.min(candle.openCents, candle.closeCents)),
      centsToDecimal(Math.max(candle.openCents, candle.closeCents)),
    ] as [number, number],
  }));

  const yDomain = candlestickData.length > 0
    ? [
        centsToDecimal(Math.min(...candlestickData.map((d) => d.lowCents))) * 0.95,
        centsToDecimal(Math.max(...candlestickData.map((d) => d.highCents))) * 1.05,
      ]
    : [0, 100];

  const chartConfig = {
    bodyRange: {
      label: "Balance",
    },
  } satisfies ChartConfig;

  const CandlestickShape = (props: any) => {
    const { x, y, width, height, payload } = props;
    if (!payload) return null;
    const open = centsToDecimal(payload.openCents);
    const close = centsToDecimal(payload.closeCents);
    const high = centsToDecimal(payload.highCents);
    const low = centsToDecimal(payload.lowCents);
    const isGreen = close >= open;
    const color = isGreen ? "#22c55e" : "#ef4444";

    const bodyMin = Math.min(open, close);
    const bodyMax = Math.max(open, close);
    const bodySpan = bodyMax - bodyMin;

    let wickHighY = y;
    let wickLowY = y + Math.abs(height);

    if (bodySpan > 0 && height !== 0) {
      const scale = Math.abs(height) / bodySpan;
      wickHighY = y - (high - bodyMax) * scale;
      wickLowY = y + Math.abs(height) + (bodyMin - low) * scale;
    } else {

      const midY = y + Math.abs(height) / 2;
      const totalRange = high - low;
      if (totalRange > 0) {
        wickHighY = midY - 20;
        wickLowY = midY + 20;
      }
    }

    const wickX = x + width / 2;
    const bodyY = Math.min(y, y + height);
    const bodyH = Math.max(Math.abs(height), 2);

    return (
      <g>
        <line
          x1={wickX}
          y1={wickHighY}
          x2={wickX}
          y2={wickLowY}
          stroke={color}
          strokeWidth={1.5}
        />
        <rect
          x={x}
          y={bodyY}
          width={width}
          height={bodyH}
          fill={color}
          rx={2}
        />
      </g>
    );
  };

  const CandlestickTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const data = payload[0]?.payload;
    if (!data) return null;

    const isGreen = data.closeCents >= data.openCents;
    const changeCents: Cents = data.closeCents - data.openCents;

    let label = data.formattedPeriod;
    if (chartPeriod === "daily") {
      const d = localDayFromKey(data.period);
      label = d.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" });
    } else if (chartPeriod === "weekly") {
      const start = localDayFromKey(data.period);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      label = `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    } else {
      const [yr, mo] = data.period.split("-");
      label = new Date(Number(yr), Number(mo) - 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    }

    return (
      <div className="rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
        <div className="mb-1.5 font-medium">{label}</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
          <span>Open</span><span className="text-right font-mono text-foreground">{formatMoney(data.openCents, selectedCashCurrency)}</span>
          <span>Close</span><span className="text-right font-mono text-foreground">{formatMoney(data.closeCents, selectedCashCurrency)}</span>
          <span>High</span><span className="text-right font-mono text-foreground">{formatMoney(data.highCents, selectedCashCurrency)}</span>
          <span>Low</span><span className="text-right font-mono text-foreground">{formatMoney(data.lowCents, selectedCashCurrency)}</span>
        </div>
        <div className={cn("mt-1.5 pt-1.5 border-t font-medium", isGreen ? "text-green-500" : "text-red-500")}>
          {changeCents >= 0 ? "+" : ""}{formatMoney(changeCents, selectedCashCurrency)}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Welcome back{userName ? `, ${userName}` : ""}
          </h1>
          <p className="text-muted-foreground">Here&apos;s what&apos;s happening with your finances</p>
        </div>
        <Button onClick={openAddDialog}>
          <Plus className="mr-2 h-4 w-4" />
          New
        </Button>
      </div>

      {}
      {netWorth && (
        <NetWorthSection
          netWorth={netWorth}
          accounts={accountRows}
          history={history}
          onRecorded={loadData}
        />
      )}

      <div>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              Cash from transactions
            </h2>
            <Select value={selectedCashCurrency} onValueChange={setCashCurrency}>
              <SelectTrigger className="h-8 w-[92px]" aria-label="Cash history currency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(cashCurrencies.length > 0 ? cashCurrencies : ["USD"]).map((currency) => (
                  <SelectItem key={currency} value={currency}>
                    {currency}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={chartPeriod} onValueChange={(v) => setChartPeriod(v as "daily" | "weekly" | "monthly")}>
              <SelectTrigger className="w-[100px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mb-2">
          <div className="text-3xl font-bold">
            {formatMoney(cashBalanceCents, selectedCashCurrency)}
          </div>
          {}
          <p className="mt-1 text-xs text-muted-foreground">
            Income minus expenses and investments across your logged transactions.
            Opening balances and liabilities are not part of this figure; see net
            worth above.
          </p>
          {}
          {(growthAmountCents !== 0 || baselineCents !== 0) && (
            <div className="mt-1 flex items-center gap-2 text-sm">
              <span
                className={cn(
                  "font-medium",
                  growthAmountCents >= 0 ? "text-green-600" : "text-red-600",
                )}
              >
                {growthAmountCents >= 0 ? "+" : "−"}
                {formatMoney(absCents(growthAmountCents), selectedCashCurrency)}
              </span>
              {growthPercent !== null && (
                <span
                  className={cn(
                    "flex items-center",
                    growthAmountCents >= 0 ? "text-green-600" : "text-red-600",
                  )}
                >
                  {growthAmountCents >= 0 ? (
                    <TrendingUp className="h-3 w-3 mr-1" />
                  ) : (
                    <TrendingDown className="h-3 w-3 mr-1" />
                  )}
                  {Math.abs(growthPercent).toFixed(1)}%
                </span>
              )}
              <span className="text-muted-foreground">vs. last month</span>
            </div>
          )}
        </div>

        <div className="h-80 rounded-lg border bg-card p-4">
          {candlestickData.length > 0 ? (
            <ChartContainer config={chartConfig} className="h-full w-full">
              <BarChart
                data={candlestickData}
                margin={{ top: 10, right: 10, left: 10, bottom: 0 }}
                barCategoryGap="20%"
              >
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" opacity={0.3} />
                <XAxis
                  dataKey="formattedPeriod"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  domain={yDomain}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                  tickFormatter={(value) => {

                    const cents = tryParseAmount(Number(value));
                    return cents === null ? "" : formatMoney(cents, selectedCashCurrency);
                  }}
                />
                <RechartsTooltip content={<CandlestickTooltip />} cursor={false} />
                <Bar
                  dataKey="bodyRange"
                  shape={<CandlestickShape />}
                  isAnimationActive={false}
                />
              </BarChart>
            </ChartContainer>
          ) : (
            <div className="h-full w-full flex items-center justify-center text-muted-foreground">
              No transaction data available
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="mb-4">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            <span>Assets{!assetView.isEmpty && ` · ${assetView.visibleTotalsLabel}`}</span>
            {}
            {assetView.filter.active && (
              <span className="flex items-center gap-1 rounded-md border-2 border-amber-500/70 bg-amber-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <EyeOff className="h-3 w-3" />
                Filtered · {assetView.filter.badgeLabel}
              </span>
            )}
            {mixedCurrency && (
              <Tooltip>
                <TooltipTrigger asChild>
                  {}
                  <span
                    tabIndex={0}
                    className="flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-50 px-2 py-0.5 text-xs font-normal text-amber-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:bg-amber-950 dark:text-amber-300"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    Mixed currencies: not converted
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  No exchange rates are applied. Currencies are subtotalled separately and
                  percentages are shares within each currency.
                </TooltipContent>
              </Tooltip>
            )}
          </h2>
          {}
          {hasDerivedCashAsset && assetView.cashAccountCount > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Cash is listed from your {assetView.cashAccountCount === 1 ? "account" : "accounts"},
              which is where the net worth above counts it. Your auto-derived Cash row
              {assetView.derivedCashLabel ? ` (${assetView.derivedCashLabel})` : ""} is built from
              the same transactions, so it is not listed a second time.
            </p>
          )}
          {hasDerivedCashAsset && assetView.cashAccountCount === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Your derived Cash row
              {assetView.derivedCashLabel ? ` (${assetView.derivedCashLabel})` : ""} is not listed:
              it is derived from your transactions, and cash reaches your net worth through your
              accounts. Add an account on{" "}
              <Link href="/accounts" className="underline">
                Accounts
              </Link>{" "}
              to see it here.
            </p>
          )}
        </div>

        {}
        <AssetFilterNotice
          filter={assetView.filter}
          onShow={showHoldings}
          onShowAll={showAllHoldings}
        />

        {assetActionError && (
          <div role="alert" className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {assetActionError}
          </div>
        )}

        {assetView.isEmpty ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Wallet className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No assets yet</h3>
              <p className="text-sm text-muted-foreground mb-4 text-center max-w-sm">
                Start by adding your first asset to track your net worth and financial progress
              </p>
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add Your First Asset
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {}
            <div className="mb-6 space-y-5">
              {assetView.currencyTotals.map((total) => {
                const rows = assetView.allocations.filter((a) => a.currency === total.currency);
                return (
                  <div key={total.currency}>
                    {mixedCurrency && (
                      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                        <span className="font-medium">{total.currency}</span>
                        <span>{formatMoney(total.totalCents, total.currency)}</span>
                      </div>
                    )}
                    <div className="flex h-3 w-full overflow-hidden rounded-full">
                      {rows.map((allocation) => (
                        <div
                          key={`${allocation.type}-${allocation.currency}`}
                          style={{
                            width: `${barWidth(allocation.percentage)}%`,
                            backgroundColor: assetCategoryColor(allocation.type),
                          }}
                          className="first:rounded-l-full last:rounded-r-full"
                        />
                      ))}
                    </div>

                    <div className="mt-4 flex flex-wrap gap-4">
                      {rows.map((allocation) => (
                        <div
                          key={`${allocation.type}-${allocation.currency}`}
                          className="flex items-center gap-2 text-sm"
                        >
                          <div
                            className="h-3 w-3 rounded-full"
                            style={{ backgroundColor: assetCategoryColor(allocation.type) }}
                          />
                          <span className="text-muted-foreground">{allocation.type}</span>
                          <span className="font-medium">{formatShare(allocation.percentage)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {}
            <AssetTable
              view={assetView}
              onEdit={openEditDialog}
              onArchive={(assetId) => void handleAssetArchived(assetId, true)}
              onDelete={openDeleteDialog}
              onHide={hideHoldings}
              onShowAll={showAllHoldings}
            />
          </>
        )}

        {assets.some((asset) => (asset as { archived?: boolean }).archived === true) && (
          <Card className="mt-6">
            <CardContent className="p-4">
              <h3 className="text-sm font-medium">Archived holdings</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Hidden from current totals. Daily history is retained until permanent delete.
              </p>
              <div className="mt-3 space-y-2">
                {assets
                  .filter((asset) => (asset as { archived?: boolean }).archived === true)
                  .map((asset) => (
                    <div key={asset.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                      <span>{asset.notes?.trim() || `${asset.category} holding`}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleAssetArchived(asset.id, false)}
                      >
                        <ArchiveRestore className="mr-2 h-4 w-4" />
                        Restore
                      </Button>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <AssetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        asset={selectedAsset}
        onSuccess={loadAssets}
      />

      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={(next) => {
          if (!next) setDeleteError(null);
          setDeleteDialogOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Asset</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete this holding and every daily history row attached to it? This
              action cannot be undone. Archive it from the table instead if you want to retain
              history.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {deleteError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{deleteError}</span>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {

                event.preventDefault();
                void handleDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
