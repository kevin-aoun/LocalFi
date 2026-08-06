"use client";

/** Budget performance, history, one-off reallocations, and category management. */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import * as Icons from "lucide-react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeftRight,
  CalendarRange,
  CircleSlash,
  Loader2,
  Pencil,
  Plus,
  PiggyBank,
  Trash2,
  TrendingUp,
  Wallet as WalletIcon,
} from "lucide-react";

import {
  deleteBudgetReallocation,
  deleteBudget,
  getBudgetHistory,
  type BudgetReallocationView,
  type BudgetPerformanceRow,
} from "@/app/actions/budgets";
import { deleteCategory } from "@/app/actions/categories";
import { BudgetDialog } from "@/components/budgets/budget-dialog";
import { BudgetRuleDialog } from "@/components/budgets/budget-rule-dialog";
import { BudgetReallocationDialog } from "@/components/budgets/budget-reallocation-dialog";
import {
  budgetableCategories,
  classifyBudgetRow,
  describeRollover,
  formatPeriodRange,
  groupHistory,
  historyRange,
  historyVerdict,
  isIgnoredRow,
  periodLabel,
  periodUnitLabel,
  rowsForPeriodFilter,
  sortBudgetRows,
  strandedIncomeBudgets,
  summarizeBudgets,
  unbudgetedCategories,
  usagePercent,
  type BudgetRowView,
  type EditableBudget,
  type PeriodFilter,
} from "@/components/budgets/budget-view-logic";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  budgetPeriods,
  monthlyReallocationAdjustment,
  type BudgetPeriod,
} from "@/lib/budgets";
import type { DateKey } from "@/lib/dates";
import { formatMoney, type Cents } from "@/lib/money";
import { cn } from "@/lib/utils";

type Category = {
  id: number;
  name: string;
  type: string;
  color: string;
  icon: string;
};

/** A `budgets` row as it arrives from the server. */
type BudgetRecord = {
  id: number;
  categoryId: number;
  period: BudgetPeriod;
  limitCents: Cents;
  effectiveFrom: DateKey;
  effectiveTo: DateKey | null;
  rollover: boolean;
};

/** The little a delete confirmation needs; `BudgetRowView` satisfies it. */
type DeletableBudget = { budgetId: number; categoryName: string; period: BudgetPeriod };

type BudgetsClientProps = {
  /** Today as a LOCAL calendar day, resolved on the server. */
  todayKey: DateKey;
  initialCategories: Category[];
  initialBudgets: BudgetRecord[];
  initialCurrentPeriod: BudgetPerformanceRow[];
  initialHistory: BudgetPerformanceRow[];
  initialReallocations: BudgetReallocationView[];
  initialHistoryPeriods: number;
  monthlySpendByCategory: Record<number, Cents>;
  currentMonthLabel: string;
};

const HISTORY_LENGTHS = [3, 6, 12, 24];

export default function BudgetsClient({
  todayKey,
  initialCategories,
  initialBudgets,
  initialCurrentPeriod,
  initialHistory,
  initialReallocations,
  initialHistoryPeriods,
  monthlySpendByCategory,
  currentMonthLabel,
}: BudgetsClientProps) {
  const router = useRouter();

  // --- budget dialogs -------------------------------------------------------
  const [budgetDialogOpen, setBudgetDialogOpen] = useState(false);
  const [budgetBeingEdited, setBudgetBeingEdited] = useState<EditableBudget | null>(null);
  const [budgetDefaultCategoryId, setBudgetDefaultCategoryId] = useState<number | undefined>();
  // Only what the confirmation needs, so a stranded income row — which has no
  // BudgetRowView, because the engine refuses to measure it — can be deleted too.
  const [budgetToDelete, setBudgetToDelete] = useState<DeletableBudget | null>(null);
  const [budgetDeleteError, setBudgetDeleteError] = useState<string | null>(null);
  const [reallocationDialogOpen, setReallocationDialogOpen] = useState(false);
  const [reallocationDeleteId, setReallocationDeleteId] = useState<number | null>(null);
  const [reallocationError, setReallocationError] = useState<string | null>(null);

  // --- category dialogs (this page is still the category manager) -----------
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState<number | null>(null);
  /** Why the last delete was refused; null when there is nothing to report. */
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // --- current period -------------------------------------------------------
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("all");

  // --- history --------------------------------------------------------------
  const [historyPeriod, setHistoryPeriod] = useState<BudgetPeriod>("monthly");
  const [historyLength, setHistoryLength] = useState(initialHistoryPeriods);
  const [historyCategory, setHistoryCategory] = useState<string>("all");
  const [historyRows, setHistoryRows] = useState<BudgetPerformanceRow[]>(initialHistory);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  /**
   * The server already rendered ONE selection (monthly, `initialHistoryPeriods`,
   * every category). While that is what is on screen there is nothing to fetch;
   * any other selection is fetched, including again after a `router.refresh()` —
   * otherwise a save would silently replace a weekly view with monthly rows.
   */
  const isDefaultHistorySelection =
    historyPeriod === "monthly" &&
    historyLength === initialHistoryPeriods &&
    historyCategory === "all";

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const range = historyRange(historyPeriod, todayKey, historyLength);
      const rows = await getBudgetHistory({
        ...range,
        period: historyPeriod,
        categoryId: historyCategory === "all" ? undefined : Number(historyCategory),
      });
      setHistoryRows(rows);
    } catch (error) {
      console.error("Failed to load budget history:", error);
      setHistoryError(
        error instanceof Error ? error.message : "Failed to load budget history.",
      );
    } finally {
      setHistoryLoading(false);
    }
  }, [historyCategory, historyLength, historyPeriod, todayKey]);

  useEffect(() => {
    if (isDefaultHistorySelection) {
      setHistoryRows(initialHistory);
      setHistoryError(null);
      return;
    }
    void loadHistory();
  }, [initialHistory, isDefaultHistorySelection, loadHistory]);

  const currentRows: BudgetRowView[] = initialCurrentPeriod;
  const summary = summarizeBudgets(rowsForPeriodFilter(currentRows, periodFilter));
  // Belt and braces: the actions already drop income rows before the engine sees
  // them, so this filter should never remove anything — but if one does arrive it
  // is not rendered as a budget card.
  const visibleRows = sortBudgetRows(
    rowsForPeriodFilter(currentRows, periodFilter).filter((row) => !isIgnoredRow(row)),
  );
  const overRows = visibleRows.filter((row) => classifyBudgetRow(row) === "over");
  const missingBudgets = unbudgetedCategories(initialCategories, currentRows);
  /** Categories a budget may be created for — Income is not one of them. */
  const creatableCategories = budgetableCategories(initialCategories);
  /**
   * Budget rows sitting on an income category. `createBudget` refuses to make
   * one, so this is only ever non-empty for a row that predates the rule or was
   * written into the database by hand. They are reported, not silently obeyed.
   */
  const strandedBudgets = strandedIncomeBudgets(initialBudgets, initialCategories);

  const budgetsById = new Map(initialBudgets.map((budget) => [budget.id, budget]));

  const openCategoryDialog = (category: Category | null) => {
    setSelectedCategory(category);
    setCategoryDialogOpen(true);
  };

  const openNewBudget = (categoryId?: number) => {
    setBudgetBeingEdited(null);
    setBudgetDefaultCategoryId(categoryId);
    setBudgetDialogOpen(true);
  };

  const openEditBudget = (row: BudgetRowView) => {
    const record = budgetsById.get(row.budgetId);
    const reallocationCents =
      row.period === "monthly"
        ? monthlyReallocationAdjustment(initialReallocations, row.categoryId, row.periodKey)
        : 0;
    setBudgetBeingEdited({
      id: record?.id ?? row.budgetId,
      categoryId: record?.categoryId ?? row.categoryId,
      period: record?.period ?? row.period,
      // A synthetic legacy row has no record to read. Remove this month's
      // one-off adjustment so editing never turns it into a permanent change.
      limitCents: record?.limitCents ?? row.limitCents - reallocationCents,
      effectiveFrom: record?.effectiveFrom ?? row.effectiveFrom ?? row.startKey,
      effectiveTo: record?.effectiveTo ?? row.effectiveTo ?? null,
      rollover: record?.rollover ?? row.rollover,
    });
    setBudgetDefaultCategoryId(undefined);
    setBudgetDialogOpen(true);
  };

  const handleDeleteBudget = async () => {
    if (!budgetToDelete) return;
    const result = await deleteBudget(budgetToDelete.budgetId);
    // The action reports refusal by RETURNING { error }; keep the dialog open.
    if (result && "error" in result && result.error) {
      setBudgetDeleteError(result.error);
      return;
    }
    setBudgetDeleteError(null);
    setBudgetToDelete(null);
    router.refresh();
  };

  const handleDeleteCategory = async () => {
    if (!categoryToDelete) return;

    const result = await deleteCategory(categoryToDelete);

    // `deleteCategory` REFUSES when transactions still reference the category —
    // silently closing here is how a category used to disappear while its
    // transactions were left pointing at nothing.
    if (result && "error" in result && result.error) {
      setDeleteError(result.error);
      return;
    }

    setDeleteError(null);
    setDeleteDialogOpen(false);
    setCategoryToDelete(null);
    router.refresh();
  };

  const handleDeleteReallocation = async (id: number) => {
    setReallocationDeleteId(id);
    setReallocationError(null);
    const result = await deleteBudgetReallocation(id);
    if ("error" in result) {
      setReallocationError(result.error);
      setReallocationDeleteId(null);
      return;
    }
    setReallocationDeleteId(null);
    router.refresh();
  };

  const handleSuccess = () => {
    router.refresh();
  };

  const groupedCategories = {
    Income: initialCategories.filter((c) => c.type === "Income"),
    Expense: initialCategories.filter((c) => c.type === "Expense"),
    Investment: initialCategories.filter((c) => c.type === "Investment"),
  };

  const historyGroups = groupHistory(historyRows);
  const sortedReallocations = [...initialReallocations].sort(
    (a, b) => b.month.localeCompare(a.month) || b.id - a.id,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Categories &amp; Budgets</h1>
          <p className="text-muted-foreground">
            Weekly, monthly and yearly limits with history and carry-over, plus the
            categories they apply to
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => setReallocationDialogOpen(true)}
            disabled={creatableCategories.length < 2}
          >
            <ArrowLeftRight className="mr-2 h-4 w-4" />
            Reallocate
          </Button>
          <Button variant="outline" onClick={() => openCategoryDialog(null)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Category
          </Button>
          <Button onClick={() => openNewBudget()} disabled={creatableCategories.length === 0}>
            <Plus className="mr-2 h-4 w-4" />
            New Budget
          </Button>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Summary: the over-budget signal used to be a red card you had to  */}
      {/* find. It is now the first thing on the page.                     */}
      {/* ---------------------------------------------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className={summary.overCount > 0 ? "border-destructive" : undefined}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Over budget</CardTitle>
            <AlertTriangle
              className={cn(
                "h-4 w-4",
                summary.overCount > 0 ? "text-destructive" : "text-muted-foreground",
              )}
            />
          </CardHeader>
          <CardContent>
            <div
              className={cn(
                "text-2xl font-bold",
                summary.overCount > 0 && "text-destructive",
              )}
            >
              {summary.overCount}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              of {summary.trackedCount} {summary.trackedCount === 1 ? "budget" : "budgets"} in the
              period{periodFilter === "all" ? "" : ` (${periodLabel(periodFilter)})`}
            </p>
          </CardContent>
        </Card>

        <Card className={summary.nearCount > 0 ? "border-orange-500/60" : undefined}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Near limit</CardTitle>
            <TrendingUp
              className={cn(
                "h-4 w-4",
                summary.nearCount > 0 ? "text-orange-600" : "text-muted-foreground",
              )}
            />
          </CardHeader>
          <CardContent>
            <div className={cn("text-2xl font-bold", summary.nearCount > 0 && "text-orange-600")}>
              {summary.nearCount}
            </div>
            <p className="text-xs text-muted-foreground mt-1">at 80% of the available amount</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Spent against limits</CardTitle>
            <WalletIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatMoney(summary.totalSpentCents)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              of {formatMoney(summary.totalAvailableCents)} available
            </p>
            <Progress
              className="mt-3"
              value={Math.min(
                usagePercent(summary.totalSpentCents, summary.totalAvailableCents),
                100,
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Left to spend</CardTitle>
            <PiggyBank className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div
              className={cn(
                "text-2xl font-bold",
                summary.totalRemainingCents < 0 && "text-destructive",
              )}
            >
              {formatMoney(summary.totalRemainingCents)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              across {summary.trackedCount}{" "}
              {summary.trackedCount === 1 ? "budget" : "budgets"}, after{" "}
              {formatMoney(summary.totalLimitCents)} of limits
            </p>
          </CardContent>
        </Card>
      </div>

      {/* An income category cannot have a budget. One that predates the rule is
          named here and can be removed — never folded into the totals above. */}
      {strandedBudgets.length > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-start gap-2 rounded-md border border-orange-500/50 bg-orange-500/10 px-3 py-2 text-sm"
        >
          <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
          <span className="flex-1">
            <strong>
              {strandedBudgets.length}{" "}
              {strandedBudgets.length === 1 ? "budget sits" : "budgets sit"} on an income
              category
            </strong>{" "}
            and {strandedBudgets.length === 1 ? "is" : "are"} ignored: a budget is a
            spending limit, and a paycheque is not spending. Nothing above counts{" "}
            {strandedBudgets.length === 1 ? "it" : "them"}.
          </span>
          <span className="flex flex-wrap gap-2">
            {strandedBudgets.map((budget) => (
              <Button
                key={budget.id}
                variant="outline"
                size="sm"
                onClick={() => {
                  setBudgetDeleteError(null);
                  setBudgetToDelete({
                    budgetId: budget.id,
                    categoryName: budget.categoryName,
                    period: budget.period,
                  });
                }}
              >
                <Trash2 className="mr-2 h-3 w-3" />
                Delete {budget.categoryName}
              </Button>
            ))}
          </span>
        </div>
      )}

      {summary.overCount > 0 && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>
              {summary.overCount} {summary.overCount === 1 ? "category is" : "categories are"} over
              budget
            </strong>{" "}
            this period:{" "}
            {overRows
              .map(
                (row) =>
                  `${row.categoryName} (${formatMoney(-row.remainingCents)} over ${periodLabel(
                    row.period,
                  ).toLowerCase()})`,
              )
              .join(", ")}
          </span>
        </div>
      )}

      <Tabs defaultValue="current" className="space-y-4">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="current">This period</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="reallocations">Reallocations</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
        </TabsList>

        {/* ================= This period ================= */}
        <TabsContent value="current" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CalendarRange className="h-4 w-4 text-muted-foreground" />
              <Select
                value={periodFilter}
                onValueChange={(value) => setPeriodFilter(value as PeriodFilter)}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All periods</SelectItem>
                  {budgetPeriods.map((period) => (
                    <SelectItem key={period} value={period}>
                      {periodLabel(period)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {visibleRows.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16">
                <WalletIcon className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No budgets for this period</h3>
                <p className="text-sm text-muted-foreground mb-4 text-center max-w-sm">
                  Set a weekly, monthly or yearly spending limit on a category to track
                  it here.
                </p>
                <Button
                  onClick={() => openNewBudget()}
                  disabled={creatableCategories.length === 0}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Create a budget
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {visibleRows.map((row) => (
                <BudgetCard
                  key={`${row.budgetId}-${row.periodKey}`}
                  row={row}
                  onEdit={() => openEditBudget(row)}
                  onDelete={() => {
                    setBudgetDeleteError(null);
                    setBudgetToDelete(row);
                  }}
                  reallocationCents={
                    row.period === "monthly"
                      ? monthlyReallocationAdjustment(
                          initialReallocations,
                          row.categoryId,
                          row.periodKey,
                        )
                      : 0
                  }
                />
              ))}
            </div>
          )}

          {missingBudgets.length > 0 && (
            <Card>
              <CardHeader>
                {/* `unbudgetedCategories` leaves Income out: it cannot have a
                    budget, so inviting one here would be a dead end. */}
                <CardTitle className="text-sm font-medium">
                  {missingBudgets.length} {missingBudgets.length === 1 ? "category" : "categories"}{" "}
                  with no budget
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {missingBudgets.map((category) => (
                  <Button
                    key={category.id}
                    variant="outline"
                    size="sm"
                    onClick={() => openNewBudget(category.id)}
                  >
                    <Plus className="mr-2 h-3 w-3" />
                    {category.name}
                  </Button>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ================= History ================= */}
        <TabsContent value="history" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={historyPeriod}
              onValueChange={(value) => setHistoryPeriod(value as BudgetPeriod)}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {budgetPeriods.map((period) => (
                  <SelectItem key={period} value={period}>
                    {periodLabel(period)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={String(historyLength)}
              onValueChange={(value) => setHistoryLength(Number(value))}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HISTORY_LENGTHS.map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    Last {count} periods
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={historyCategory} onValueChange={setHistoryCategory}>
              <SelectTrigger className="w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {/* Income is omitted: it can hold no budget, so it has no history. */}
                {creatableCategories.map((category) => (
                  <SelectItem key={category.id} value={String(category.id)}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {historyLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>

          {historyError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{historyError}</span>
            </div>
          )}

          {historyGroups.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16">
                <CalendarRange className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No history for this selection</h3>
                <p className="text-sm text-muted-foreground text-center max-w-sm">
                  A period only appears once a budget was in force for it. Widen the range or
                  add a budget with an earlier start date.
                </p>
              </CardContent>
            </Card>
          ) : (
            historyGroups.map((group) => (
              <Card key={`${group.period}-${group.periodKey}`}>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                  <CardTitle className="text-base">
                    {group.label}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {group.startKey} → {group.endKey}
                    </span>
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {formatMoney(group.totalSpentCents)} of{" "}
                      {formatMoney(group.totalLimitCents)}
                    </span>
                    {group.overCount > 0 ? (
                      <Badge variant="destructive">
                        {group.overCount} over budget
                      </Badge>
                    ) : (
                      <Badge variant="secondary">All within budget</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Limit</TableHead>
                        <TableHead className="text-right">Carried in</TableHead>
                        <TableHead className="text-right">Spent</TableHead>
                        <TableHead className="text-right">Remaining</TableHead>
                        <TableHead className="text-right">Result</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.rows.map((row) => {
                        const verdict = historyVerdict(row, todayKey);
                        return (
                          <TableRow key={`${row.budgetId}-${row.periodKey}`}>
                            <TableCell className="font-medium">
                              {row.categoryName}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatMoney(row.limitCents)}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {row.rollover ? formatMoney(row.carriedInCents) : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatMoney(row.spentCents)}
                            </TableCell>
                            <TableCell
                              className={cn(
                                "text-right",
                                row.remainingCents < 0 && "text-destructive",
                              )}
                            >
                              {formatMoney(row.remainingCents)}
                            </TableCell>
                            <TableCell className="text-right">
                              <span
                                className={cn(
                                  "text-xs font-medium",
                                  verdict.status === "over" && "text-destructive",
                                  verdict.status === "under" && "text-emerald-600",
                                  verdict.status === "ignored" && "text-muted-foreground",
                                )}
                              >
                                {verdict.label}
                              </span>
                              {verdict.inProgress && (
                                <span className="ml-2 text-xs text-muted-foreground">
                                  (in progress)
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        {/* ================= Reallocations ================= */}
        <TabsContent value="reallocations" className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">One-off monthly reallocations</h2>
              <p className="text-sm text-muted-foreground">
                Each entry changes only the named month. It never edits either permanent budget.
              </p>
            </div>
            <Button
              onClick={() => setReallocationDialogOpen(true)}
              disabled={creatableCategories.length < 2}
            >
              <ArrowLeftRight className="mr-2 h-4 w-4" />
              Reallocate budget
            </Button>
          </div>

          {reallocationError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{reallocationError}</span>
            </div>
          )}

          {sortedReallocations.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-14 text-center">
                <ArrowLeftRight className="mb-3 h-10 w-10 text-muted-foreground" />
                <h3 className="font-semibold">No reallocations yet</h3>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  Move a fixed amount or a percentage from one monthly category budget to another.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead>From</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead className="text-right">Moved</TableHead>
                      <TableHead className="w-12"><span className="sr-only">Actions</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedReallocations.map((allocation) => (
                      <TableRow key={allocation.id}>
                        <TableCell className="font-medium">{allocation.month}</TableCell>
                        <TableCell>{allocation.fromCategoryName}</TableCell>
                        <TableCell>{allocation.toCategoryName}</TableCell>
                        <TableCell className="text-right">
                          <div className="font-medium">{formatMoney(allocation.amountCents)}</div>
                          <div className="text-xs text-muted-foreground">
                            {allocation.inputMode === "percentage"
                              ? `${allocation.inputValue}% when created`
                              : "fixed amount"}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            disabled={reallocationDeleteId === allocation.id}
                            onClick={() => void handleDeleteReallocation(allocation.id)}
                            aria-label={`Delete ${allocation.month} reallocation`}
                          >
                            {reallocationDeleteId === allocation.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4 text-destructive" />
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ================= Categories ================= */}
        <TabsContent value="categories" className="space-y-8">
          {initialCategories.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16">
                <WalletIcon className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No categories yet</h3>
                <p className="text-sm text-muted-foreground mb-4 text-center max-w-sm">
                  Create your first category to start tracking your spending and income
                </p>
                <Button onClick={() => openCategoryDialog(null)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Your First Category
                </Button>
              </CardContent>
            </Card>
          ) : (
            Object.entries(groupedCategories).map(
              ([type, cats]) =>
                cats.length > 0 && (
                  <div key={type} className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h2 className="text-xl font-semibold">{type}</h2>
                      <Badge
                        variant={
                          type === "Income"
                            ? "default"
                            : type === "Expense"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {cats.length} {cats.length === 1 ? "category" : "categories"}
                      </Badge>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                      {cats.map((category) => (
                        <CategoryCard
                          key={category.id}
                          category={category}
                          spendingCents={monthlySpendByCategory[category.id] ?? 0}
                          monthLabel={currentMonthLabel}
                          budgetCount={
                            new Set([
                              ...initialBudgets
                                .filter((budget) => budget.categoryId === category.id)
                                .map((budget) => budget.id),
                              ...currentRows
                                .filter((budget) => budget.categoryId === category.id)
                                .map((budget) => budget.budgetId),
                            ]).size
                          }
                          onEdit={() => openCategoryDialog(category)}
                          onAddBudget={() => openNewBudget(category.id)}
                          canBudget={category.type !== "Income"}
                          onDelete={() => {
                            setDeleteError(null);
                            setCategoryToDelete(category.id);
                            setDeleteDialogOpen(true);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ),
            )
          )}
        </TabsContent>
      </Tabs>

      {/* ---------------------------------- dialogs ---------------------------------- */}

      <BudgetRuleDialog
        open={budgetDialogOpen}
        onOpenChange={setBudgetDialogOpen}
        categories={initialCategories}
        budget={budgetBeingEdited}
        defaultCategoryId={budgetDefaultCategoryId}
        onSuccess={handleSuccess}
      />

      <BudgetReallocationDialog
        open={reallocationDialogOpen}
        onOpenChange={setReallocationDialogOpen}
        categories={initialCategories}
        defaultMonth={currentMonthLabel}
        onSuccess={handleSuccess}
      />

      <BudgetDialog
        open={categoryDialogOpen}
        onOpenChange={setCategoryDialogOpen}
        category={selectedCategory}
        onSuccess={handleSuccess}
      />

      <AlertDialog
        open={budgetToDelete !== null}
        onOpenChange={(next) => {
          if (!next) {
            setBudgetToDelete(null);
            setBudgetDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this budget?</AlertDialogTitle>
            <AlertDialogDescription>
              {budgetToDelete
                ? `The ${periodLabel(budgetToDelete.period).toLowerCase()} budget for ${
                    budgetToDelete.categoryName
                  } and its history disappear with it. To stop a budget while keeping its history, set an end date instead.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {budgetDeleteError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{budgetDeleteError}</span>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Keep the dialog open so a refusal can be read.
                event.preventDefault();
                void handleDeleteBudget();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={(next) => {
          if (!next) setDeleteError(null);
          setDeleteDialogOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Category</AlertDialogTitle>
            <AlertDialogDescription>
              {/* The old copy claimed the transactions would simply lose their
                  category. They did — and then vanished from every balance.
                  Deletion is now refused while any transaction references it. */}
              A category can only be deleted once no transactions use it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {deleteError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{deleteError}</span>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Keep the dialog open so the refusal can be read.
                event.preventDefault();
                void handleDeleteCategory();
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

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function CategoryIcon({ name, color }: { name: string; color: string }) {
  const Component = (Icons as unknown as Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>>)[
    name
  ];
  if (!Component) return null;
  return <Component className="h-4 w-4" style={{ color }} />;
}

/** One budget for the period in progress. */
function BudgetCard({
  row,
  onEdit,
  onDelete,
  reallocationCents,
}: {
  row: BudgetRowView;
  onEdit: () => void;
  onDelete: () => void;
  reallocationCents: Cents;
}) {
  const status = classifyBudgetRow(row);
  const percent = usagePercent(row.spentCents, row.availableCents);
  const rollover = describeRollover(row);

  return (
    <Card
      className={cn(
        status === "over" && "border-destructive",
        status === "near" && "border-orange-500/60",
      )}
    >
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div className="space-y-1">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CategoryIcon name={row.categoryIcon} color={row.categoryColor} />
            {row.categoryName}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="secondary" className="text-[10px]">
              {periodLabel(row.period)}
            </Badge>
            {row.rollover && (
              <Badge variant="outline" className="text-[10px]">
                Rollover
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={onEdit}
                aria-label="Edit budget"
              >
                <Pencil className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit budget</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={onDelete}
                aria-label="Delete budget"
              >
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete budget</TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-2">
          <div className="text-2xl font-bold">{formatMoney(row.spentCents)}</div>
          {status === "over" && <AlertTriangle className="h-4 w-4 text-destructive" />}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          of {formatMoney(row.availableCents)} available {periodUnitLabel(row.period)}
        </p>
        {reallocationCents !== 0 && (
          <p className={cn("mt-1 text-xs", reallocationCents > 0 ? "text-emerald-600" : "text-orange-600")}>
            {reallocationCents > 0 ? "+" : "−"}
            {formatMoney(Math.abs(reallocationCents))} {reallocationCents > 0 ? "moved in" : "moved out"} this month
          </p>
        )}

        <Progress
          className={cn("mt-3", status === "over" && "bg-destructive/25")}
          value={Math.min(percent, 100)}
        />

        <p className="text-xs text-muted-foreground mt-2">
          {formatPeriodRange(row.period, row.periodKey, row.startKey, row.endKey)} ·{" "}
          {Math.round(percent)}% used
        </p>

        {status === "over" && (
          <p className="text-xs text-destructive mt-2 font-medium">
            {formatMoney(-row.remainingCents)} over budget
          </p>
        )}
        {status === "near" && (
          <p className="text-xs text-orange-600 mt-2 font-medium">
            {formatMoney(row.remainingCents)} left
          </p>
        )}
        {status === "on-track" && (
          <p className="text-xs text-muted-foreground mt-2">
            {formatMoney(row.remainingCents)} left
          </p>
        )}

        {/* Carry-over is stated explicitly: an "available" figure that silently
            differs from the limit is worse than no rollover at all. */}
        {rollover.carriedInLabel && (
          <p className="text-xs text-muted-foreground mt-2">+ {rollover.carriedInLabel}</p>
        )}
        {rollover.carriedOutLabel && (
          <p className="text-xs text-muted-foreground mt-1">{rollover.carriedOutLabel}</p>
        )}
        {rollover.deficitAbsorbed && (
          <p className="text-xs text-muted-foreground mt-1">
            Nothing carries forward: an overspend is absorbed here, and the next period starts
            at {formatMoney(row.limitCents)}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** One category in the manager tab. */
function CategoryCard({
  category,
  spendingCents,
  monthLabel,
  budgetCount,
  canBudget,
  onEdit,
  onAddBudget,
  onDelete,
}: {
  category: Category;
  spendingCents: Cents;
  monthLabel: string;
  budgetCount: number;
  /** False for Income: a budget is a spending limit, so none is offered. */
  canBudget: boolean;
  onEdit: () => void;
  onAddBudget: () => void;
  onDelete: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <CategoryIcon name={category.icon} color={category.color} />
          {category.name}
        </CardTitle>
        <div className="flex items-center gap-1">
          {canBudget && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={onAddBudget}
                  aria-label="Add a budget for this category"
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Add a budget for this category</TooltipContent>
            </Tooltip>
          )}
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onEdit}>
            <Pencil className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onDelete}>
            <Trash2 className="h-3 w-3 text-destructive" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-2">
          <div className="text-2xl font-bold">{formatMoney(spendingCents)}</div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          in {monthLabel}
        </p>

        <p className="text-xs text-muted-foreground mt-2">
          {!canBudget
            ? "Income: a budget is a spending limit, so there is none"
            : budgetCount === 0
              ? "No budget yet"
              : `${budgetCount} ${budgetCount === 1 ? "budget" : "budgets"}`}
        </p>
      </CardContent>
    </Card>
  );
}
