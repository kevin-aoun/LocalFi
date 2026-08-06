"use client";

/**
 * The Reports page.
 *
 * Everything on screen is derived by `lib/reports.ts` from the ledger the server
 * handed over, which in turn composes `lib/cash-balance.ts` (what counts as income
 * and expense), `lib/budgets.ts` (where a period starts and ends) and
 * `lib/dates.ts` (calendar days). Nothing is re-derived here — that is what keeps
 * this page from contradicting the dashboard and the budgets page.
 *
 * The arithmetic lives in tested pure functions; this file only chooses ranges,
 * catches a bad custom date, and lays the results out.
 */
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  CalendarRange,
  Coins,
  Info,
  PieChart as PieChartIcon,
} from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CashFlowChart, IncomeVsExpenseChart } from "@/components/reports/cash-flow-chart";
import { CashFlowTable } from "@/components/reports/cash-flow-table";
import { CategoryBreakdown } from "@/components/reports/category-breakdown";
import { CategoryPie } from "@/components/reports/category-pie";
import {
  buildCategoryPie,
  isCategoryView,
  type CategoryView,
} from "@/components/reports/category-chart";
import { ComparisonCard } from "@/components/reports/comparison-card";
import { ExportCard } from "@/components/reports/export-card";
import { ReportSummary } from "@/components/reports/report-summary";
import { InvestmentPerformance } from "@/components/reports/investment-performance";
import type { InvestmentHistoryInput } from "@/components/reports/investment-history";
import {
  COMPARISON_MODES,
  COMPARISON_MODE_LABELS,
  RANGE_PRESETS,
  RANGE_PRESET_LABELS,
  comparisonRange,
  describeCurrencyCaveat,
  describeExclusions,
  describeUnassigned,
  formatRangeLabel,
  rangeForPreset,
  suggestPeriod,
  toCashFlowChartRows,
  type ComparisonMode,
  type LedgerBounds,
  type RangePreset,
} from "@/components/reports/report-view-logic";
import { isDateKey, type DateKey } from "@/lib/dates";
import {
  cashFlowByPeriod,
  categoryBreakdown,
  compareFlows,
  currencyScope,
  filterByCurrency,
  flowInRange,
  type BreakdownDirection,
  type ReportPeriod,
  type ReportTransaction,
} from "@/lib/reports";

type ReportsClientProps = {
  todayKey: DateKey;
  transactions: ReportTransaction[];
  categories: Array<{ id: number; name: string; type: string; color: string }>;
  accounts: Array<{ id: number; name: string; currency: string }>;
  bounds: LedgerBounds;
  investmentHistory: InvestmentHistoryInput[];
};

const PERIODS: Array<{ value: ReportPeriod; label: string }> = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

const DIRECTIONS: Array<{ value: BreakdownDirection; label: string }> = [
  { value: "expense", label: "Money out" },
  { value: "income", label: "Money in" },
  { value: "all", label: "Everything" },
];

export default function ReportsClient({
  todayKey,
  transactions,
  categories,
  accounts,
  bounds,
  investmentHistory,
}: ReportsClientProps) {
  const [reportView, setReportView] = useState<"cash-flow" | "investments">("cash-flow");
  const [preset, setPreset] = useState<RangePreset>("last-12-months");
  const [customFrom, setCustomFrom] = useState<string>(
    rangeForPreset("year-to-date", todayKey)?.startKey ?? todayKey,
  );
  const [customTo, setCustomTo] = useState<string>(todayKey);
  /** null = follow the range's own suggestion. */
  const [periodOverride, setPeriodOverride] = useState<ReportPeriod | null>(null);
  const [comparison, setComparison] = useState<ComparisonMode>("year-over-year");
  const [direction, setDirection] = useState<BreakdownDirection>("expense");
  /** Bar table or pie — the same rows, drawn two ways. Not persisted. */
  const [categoryView, setCategoryView] = useState<CategoryView>("bar");
  /** null = the dominant currency of the range. */
  const [currencyOverride, setCurrencyOverride] = useState<string | null>(null);

  const colors = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c.color])),
    [categories],
  );

  const report = useMemo(() => {
    try {
      const range =
        preset === "custom"
          ? { startKey: customFrom, endKey: customTo }
          : rangeForPreset(preset, todayKey, bounds);
      if (!range) throw new Error("Pick a start and an end date.");
      if (!isDateKey(range.startKey)) throw new Error("The start date is not a valid calendar day.");
      if (!isDateKey(range.endKey)) throw new Error("The end date is not a valid calendar day.");
      if (range.startKey > range.endKey) {
        throw new Error("The start date is after the end date.");
      }

      const period = periodOverride ?? suggestPeriod(range);

      // Which currencies this range actually touches. There is NO FX in this app,
      // so a mixed range is reported one currency at a time rather than summed.
      const inRange = transactions.filter(
        (tx) => tx.dateKey >= range.startKey && tx.dateKey <= range.endKey,
      );
      const scope = currencyScope(inRange, accounts);
      const currency = currencyOverride ?? scope.primary;
      const scoped = scope.mixed
        ? filterByCurrency(transactions, accounts, currency, {
            // Account-less rows have no currency; they join the dominant view only,
            // so they are never counted in two currencies at once.
            includeUnassigned: currency === scope.primary,
          })
        : transactions;

      const totals = flowInRange(scoped, categories, range.startKey, range.endKey);
      const flows = cashFlowByPeriod({
        transactions: scoped,
        categories,
        period,
        fromKey: range.startKey,
        toKey: range.endKey,
      });
      const baselineRange = comparisonRange(comparison, range, period);
      const baselineTotals = flowInRange(
        scoped,
        categories,
        baselineRange.startKey,
        baselineRange.endKey,
      );
      const breakdown = categoryBreakdown({
        transactions: scoped,
        categories,
        startKey: range.startKey,
        endKey: range.endKey,
        direction,
      });

      return {
        ok: true as const,
        range,
        period,
        scope,
        currency,
        totals,
        flows,
        baselineRange,
        baselineTotals,
        comparison: compareFlows(totals, baselineTotals),
        breakdown,
      };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message || "That range cannot be read." };
    }
  }, [
    accounts,
    bounds,
    categories,
    comparison,
    currencyOverride,
    customFrom,
    customTo,
    direction,
    periodOverride,
    preset,
    todayKey,
    transactions,
  ]);

  // Derived from the SAME `report.breakdown` the table renders, so the two views
  // cannot disagree about a figure. Computed unconditionally (hooks may not be
  // called behind a branch); an unreadable range yields an empty pie that is
  // never rendered, because the error state replaces the card entirely.
  const categoryPie = useMemo(
    () => buildCategoryPie(report.ok ? report.breakdown : [], colors),
    [report, colors],
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <BarChart3 className="h-7 w-7" />
          Reports
        </h1>
        <p className="text-muted-foreground">
          Cash flow, spending, and the daily value of your investments.
        </p>
      </div>

      <Tabs
        value={reportView}
        onValueChange={(value) =>
          setReportView(value === "investments" ? "investments" : "cash-flow")
        }
      >
        <TabsList>
          <TabsTrigger value="cash-flow">Cash flow</TabsTrigger>
          <TabsTrigger value="investments">Investments</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Controls ---------------------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 p-5">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarRange className="h-3.5 w-3.5" />
              Range
            </Label>
            <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_PRESETS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {RANGE_PRESET_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {preset === "custom" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="range-from" className="text-xs text-muted-foreground">
                  From
                </Label>
                {/* type="date" yields 'YYYY-MM-DD' directly: a calendar day, with no
                    Date object and therefore no timezone to shift it. */}
                <Input
                  id="range-from"
                  type="date"
                  className="w-[160px]"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="range-to" className="text-xs text-muted-foreground">
                  To
                </Label>
                <Input
                  id="range-to"
                  type="date"
                  className="w-[160px]"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </div>
            </>
          )}

          {reportView === "cash-flow" && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Group by</Label>
              <Select
                value={report.ok ? report.period : "monthly"}
                onValueChange={(v) => setPeriodOverride(v as ReportPeriod)}
              >
                <SelectTrigger className="w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERIODS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {reportView === "cash-flow" && report.ok && report.scope.mixed && (
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Coins className="h-3.5 w-3.5" />
                Currency
              </Label>
              <Select value={report.currency} onValueChange={(v) => setCurrencyOverride(v)}>
                <SelectTrigger className="w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {report.scope.currencies.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {report.ok && (
            <div className="ml-auto text-sm text-muted-foreground">
              {formatRangeLabel(report.range)}
            </div>
          )}
        </CardContent>
      </Card>

      {!report.ok ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{report.error}</span>
        </div>
      ) : reportView === "investments" ? (
        <InvestmentPerformance rows={investmentHistory} range={report.range} />
      ) : (
        <>
          {/* No FX, stated rather than fudged. */}
          {describeCurrencyCaveat(report.scope) && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {describeCurrencyCaveat(report.scope)} Showing{" "}
                <strong>{report.currency}</strong>.
              </span>
            </div>
          )}

          <ReportSummary totals={report.totals} currency={report.currency} />

          {/* What was left out, said out loud. */}
          {(describeExclusions(report.totals).length > 0 || describeUnassigned(report.scope)) && (
            <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {describeExclusions(report.totals).map((note) => (
                <div key={note} className="flex items-start gap-2">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{note}</span>
                </div>
              ))}
              {describeUnassigned(report.scope) && (
                <div className="flex items-start gap-2">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{describeUnassigned(report.scope)}</span>
                </div>
              )}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Cash flow</CardTitle>
                <CardDescription>
                  Money in above the line, money out below it, net as the line itself.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CashFlowChart
                  rows={toCashFlowChartRows(report.flows, report.period)}
                  currency={report.currency}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Income vs expense</CardTitle>
                <CardDescription>The whole range, side by side.</CardDescription>
              </CardHeader>
              <CardContent>
                <IncomeVsExpenseChart
                  incomeCents={report.totals.incomeCents}
                  expenseCents={report.totals.expenseCents}
                  currency={report.currency}
                />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Cash flow statement</CardTitle>
              <CardDescription>
                One row per {report.period.replace(/ly$/, "")} period. The total is the exact sum of
                the rows above it.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0 sm:px-6 sm:pb-6">
              <CashFlowTable
                rows={report.flows}
                period={report.period}
                currency={report.currency}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              {/*
                `space-y-1.5` is on CardHeader, but overriding `flex-col` with
                `flex-row` above turns it into horizontal spacing between this
                block and the tabs — so the title/description pair loses the gap
                every other card has. Restate it here rather than on the header.
              */}
              <div className="space-y-1.5">
                <CardTitle>Comparison</CardTitle>
                <CardDescription>
                  How this range compares with the one before it, or with the same range a year ago.
                </CardDescription>
              </div>
              <Tabs value={comparison} onValueChange={(v) => setComparison(v as ComparisonMode)}>
                <TabsList>
                  {COMPARISON_MODES.map((mode) => (
                    <TabsTrigger key={mode} value={mode}>
                      {COMPARISON_MODE_LABELS[mode]}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </CardHeader>
            <CardContent>
              <ComparisonCard
                comparison={report.comparison}
                current={report.totals}
                previous={report.baselineTotals}
                currentRange={report.range}
                baselineRange={report.baselineRange}
                currency={report.currency}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              {/* Same flex-row/space-y-1.5 interaction as the Comparison card above. */}
              <div className="space-y-1.5">
                <CardTitle>By category</CardTitle>
                <CardDescription>{formatRangeLabel(report.range)}</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Tabs value={direction} onValueChange={(v) => setDirection(v as BreakdownDirection)}>
                  <TabsList>
                    {DIRECTIONS.map((option) => (
                      <TabsTrigger key={option.value} value={option.value}>
                        {option.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                {/*
                  Bar vs pie is a presentation choice over identical numbers, so
                  it is view state only — nothing here reaches a server action.
                */}
                <Tabs
                  value={categoryView}
                  onValueChange={(v) => isCategoryView(v) && setCategoryView(v)}
                >
                  <TabsList>
                    <TabsTrigger value="bar" aria-label="Show as a table with share bars">
                      <BarChart3 className="h-4 w-4" />
                    </TabsTrigger>
                    <TabsTrigger value="pie" aria-label="Show as a pie chart">
                      <PieChartIcon className="h-4 w-4" />
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            </CardHeader>
            <CardContent
              className={categoryView === "bar" ? "p-0 sm:px-6 sm:pb-6" : "px-4 pb-6 sm:px-6"}
            >
              {categoryView === "bar" ? (
                <CategoryBreakdown
                  rows={report.breakdown}
                  colors={colors}
                  currency={report.currency}
                />
              ) : (
                <CategoryPie model={categoryPie} currency={report.currency} />
              )}
            </CardContent>
          </Card>

          <ExportCard
            range={report.range}
            currency={report.scope.mixed ? report.currency : null}
            mixedCurrency={report.scope.mixed}
          />
        </>
      )}
    </div>
  );
}
