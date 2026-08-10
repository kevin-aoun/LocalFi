"use client";

/** Budget performance, history, one-off reallocations, and category management. */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeftRight,
  CalendarRange,
  CircleSlash,
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
import { BudgetCard, type BudgetCategory } from "@/components/budgets/budget-cards";
import { BudgetCategoriesTab } from "@/components/budgets/budget-categories-tab";
import { BudgetDialog } from "@/components/budgets/budget-dialog";
import type { EditableBudget } from "@/components/budgets/budget-form-logic";
import { BudgetHistoryTab } from "@/components/budgets/budget-history-tab";
import { BudgetReallocationsTab } from "@/components/budgets/budget-reallocations-tab";
import { BudgetRuleDialog } from "@/components/budgets/budget-rule-dialog";
import { BudgetReallocationDialog } from "@/components/budgets/budget-reallocation-dialog";
import {
  budgetableCategories,
  classifyBudgetRow,
  groupHistory,
  historyRange,
  isIgnoredRow,
  periodLabel,
  rowsForPeriodFilter,
  sortBudgetRows,
  strandedIncomeBudgets,
  summarizeBudgets,
  unbudgetedCategories,
  usagePercent,
  type BudgetRowView,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  budgetPeriods,
  monthlyReallocationAdjustment,
  monthlyReallocationFlow,
  type BudgetPeriod,
} from "@/lib/budgets";
import type { DateKey } from "@/lib/dates";
import { formatMoney, type Cents } from "@/lib/money";
import { cn } from "@/lib/utils";

type Category = BudgetCategory;

/** A `budgets` row as it arrives from the server. */
type BudgetRecord = {
  id: number;
  categoryId: number;
  period: BudgetPeriod;
  limitCents: Cents;
  effectiveFrom: DateKey;
  effectiveTo: DateKey | null;
  rollover: boolean;
  goalName: string | null;
  goalAmountCents: Cents | null;
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
      goalName: record?.goalName ?? row.goalName ?? null,
      goalAmountCents: record?.goalAmountCents ?? row.goalAmountCents ?? null,
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
              {visibleRows.map((row) => {
                const reallocationFlow =
                  row.period === "monthly"
                    ? monthlyReallocationFlow(
                        initialReallocations,
                        row.categoryId,
                        row.periodKey,
                      )
                    : undefined;
                return (
                  <BudgetCard
                    key={`${row.budgetId}-${row.periodKey}`}
                    row={row}
                    onEdit={() => openEditBudget(row)}
                    onDelete={() => {
                      setBudgetDeleteError(null);
                      setBudgetToDelete(row);
                    }}
                    reallocationFlow={reallocationFlow}
                  />
                );
              })}
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
          <BudgetHistoryTab
            historyPeriod={historyPeriod}
            setHistoryPeriod={setHistoryPeriod}
            historyLength={historyLength}
            setHistoryLength={setHistoryLength}
            historyCategory={historyCategory}
            setHistoryCategory={setHistoryCategory}
            categories={creatableCategories}
            historyLoading={historyLoading}
            historyError={historyError}
            historyGroups={historyGroups}
            todayKey={todayKey}
          />
        </TabsContent>

        {/* ================= Reallocations ================= */}
        <TabsContent value="reallocations" className="space-y-4">
          <BudgetReallocationsTab
            reallocations={sortedReallocations}
            canReallocate={creatableCategories.length >= 2}
            onOpen={() => setReallocationDialogOpen(true)}
            error={reallocationError}
            deletingId={reallocationDeleteId}
            onDelete={(id) => void handleDeleteReallocation(id)}
          />
        </TabsContent>

        {/* ================= Categories ================= */}
        <TabsContent value="categories" className="space-y-8">
          <BudgetCategoriesTab
            categories={initialCategories}
            budgets={initialBudgets}
            rows={currentRows}
            spending={monthlySpendByCategory}
            monthLabel={currentMonthLabel}
            onAdd={() => openCategoryDialog(null)}
            onEdit={openCategoryDialog}
            onBudget={openNewBudget}
            onDelete={(id) => { setDeleteError(null); setCategoryToDelete(id); setDeleteDialogOpen(true); }}
          />
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
