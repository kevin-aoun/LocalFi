"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeftRight,
  CalendarRange,
  CircleSlash,
  GripVertical,
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
  reorderBudgets,
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

function SortableBudgetCard({
  row,
  disabled,
  onEdit,
  onDelete,
  reallocationFlow,
}: {
  row: BudgetRowView;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
  reallocationFlow?: ReturnType<typeof monthlyReallocationFlow>;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.budgetId, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("relative", isDragging && "z-10 opacity-70")}
    >
      <BudgetCard
        row={row}
        onEdit={onEdit}
        onDelete={onDelete}
        reallocationFlow={reallocationFlow}
        dragHandle={(
          <Button
            ref={setActivatorNodeRef}
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 touch-none cursor-grab p-0 active:cursor-grabbing"
            disabled={disabled}
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${row.categoryName} budget`}
            title="Drag to reorder"
          >
            <GripVertical className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          </Button>
        )}
      />
    </div>
  );
}

type Category = BudgetCategory;


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


type DeletableBudget = { budgetId: number; categoryName: string; period: BudgetPeriod };

type BudgetsClientProps = {

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


  const [budgetDialogOpen, setBudgetDialogOpen] = useState(false);
  const [budgetBeingEdited, setBudgetBeingEdited] = useState<EditableBudget | null>(null);
  const [budgetDefaultCategoryId, setBudgetDefaultCategoryId] = useState<number | undefined>();


  const [budgetToDelete, setBudgetToDelete] = useState<DeletableBudget | null>(null);
  const [budgetDeleteError, setBudgetDeleteError] = useState<string | null>(null);
  const [reallocationDialogOpen, setReallocationDialogOpen] = useState(false);
  const [reallocationDeleteId, setReallocationDeleteId] = useState<number | null>(null);
  const [reallocationError, setReallocationError] = useState<string | null>(null);


  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState<number | null>(null);

  const [deleteError, setDeleteError] = useState<string | null>(null);


  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("all");
  const [orderedBudgetIds, setOrderedBudgetIds] = useState(() =>
    sortBudgetRows(initialCurrentPeriod)
      .filter((row) => row.budgetId > 0)
      .map((row) => row.budgetId),
  );
  const [savingBudgetOrder, setSavingBudgetOrder] = useState(false);
  const [budgetOrderError, setBudgetOrderError] = useState<string | null>(null);
  const budgetSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    setOrderedBudgetIds(
      sortBudgetRows(initialCurrentPeriod)
        .filter((row) => row.budgetId > 0)
        .map((row) => row.budgetId),
    );
  }, [initialCurrentPeriod]);


  const [historyPeriod, setHistoryPeriod] = useState<BudgetPeriod>("monthly");
  const [historyLength, setHistoryLength] = useState(initialHistoryPeriods);
  const [historyCategory, setHistoryCategory] = useState<string>("all");
  const [historyRows, setHistoryRows] = useState<BudgetPerformanceRow[]>(initialHistory);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

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



  const budgetOrderIndex = new Map(orderedBudgetIds.map((id, index) => [id, index]));
  const visibleRows = sortBudgetRows(
    rowsForPeriodFilter(currentRows, periodFilter).filter((row) => !isIgnoredRow(row)),
  ).sort((a, b) =>
    (budgetOrderIndex.get(a.budgetId) ?? Number.MAX_SAFE_INTEGER) -
    (budgetOrderIndex.get(b.budgetId) ?? Number.MAX_SAFE_INTEGER),
  );
  const overRows = visibleRows.filter((row) => classifyBudgetRow(row) === "over");
  const missingBudgets = unbudgetedCategories(initialCategories, currentRows);

  const creatableCategories = budgetableCategories(initialCategories);

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

  const handleBudgetDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || savingBudgetOrder) return;
    const visibleIds = visibleRows
      .filter((row) => row.budgetId > 0)
      .map((row) => row.budgetId);
    const oldIndex = visibleIds.indexOf(Number(active.id));
    const newIndex = visibleIds.indexOf(Number(over.id));
    if (oldIndex < 0 || newIndex < 0) return;

    const previous = orderedBudgetIds;
    const movedVisibleIds = arrayMove(visibleIds, oldIndex, newIndex);
    const visibleIdSet = new Set(visibleIds);
    let nextVisibleIndex = 0;
    const next = previous.map((id) => (
      visibleIdSet.has(id) ? movedVisibleIds[nextVisibleIndex++] : id
    ));
    setOrderedBudgetIds(next);
    setSavingBudgetOrder(true);
    setBudgetOrderError(null);
    const result = await reorderBudgets(next);
    if ("error" in result) {
      setOrderedBudgetIds(previous);
      setBudgetOrderError(result.error);
    } else {
      router.refresh();
    }
    setSavingBudgetOrder(false);
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

      {}
      {}
      {}
      {}
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

      {}
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

        {}
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
            <>
              {budgetOrderError && (
                <p role="alert" className="text-sm text-destructive">{budgetOrderError}</p>
              )}
              <p aria-live="polite" className="sr-only">
                {savingBudgetOrder ? "Saving budget order" : budgetOrderError ?? "Budget order saved"}
              </p>
              <DndContext
                sensors={budgetSensors}
                collisionDetection={closestCenter}
                onDragEnd={(event) => void handleBudgetDragEnd(event)}
              >
                <SortableContext
                  items={visibleRows.filter((row) => row.budgetId > 0).map((row) => row.budgetId)}
                  strategy={rectSortingStrategy}
                >
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
                const cardProps = {
                  row,
                  onEdit: () => openEditBudget(row),
                  onDelete: () => {
                    setBudgetDeleteError(null);
                    setBudgetToDelete(row);
                  },
                  reallocationFlow,
                };
                return row.budgetId > 0 ? (
                  <SortableBudgetCard
                    key={`${row.budgetId}-${row.periodKey}`}
                    {...cardProps}
                    disabled={savingBudgetOrder}
                  />
                ) : (
                  <BudgetCard key={`${row.budgetId}-${row.periodKey}`} {...cardProps} />
                );
              })}
                  </div>
                </SortableContext>
              </DndContext>
            </>
          )}

          {missingBudgets.length > 0 && (
            <Card>
              <CardHeader>
                {}
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

        {}
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

        {}
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

        {}
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

      {}

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
              {}
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
