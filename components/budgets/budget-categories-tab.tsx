"use client";

import { useEffect, useState } from "react";
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
import { GripVertical, Plus, Wallet } from "lucide-react";

import { reorderCategories } from "@/app/actions/categories";
import { CategoryCard, type BudgetCategory } from "@/components/budgets/budget-cards";
import type { BudgetRowView } from "@/components/budgets/budget-view-logic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Cents } from "@/lib/money";
import { cn } from "@/lib/utils";

type CategoryType = "Income" | "Expense" | "Investment";

type BudgetCategoriesTabProps = {
  categories: BudgetCategory[];
  budgets: { categoryId: number; id: number }[];
  rows: BudgetRowView[];
  spending: Record<number, Cents>;
  monthLabel: string;
  onAdd: () => void;
  onEdit: (category: BudgetCategory) => void;
  onBudget: (id: number) => void;
  onDelete: (id: number) => void;
};

type SortableCategoryProps = {
  category: BudgetCategory;
  disabled: boolean;
  spendingCents: Cents;
  monthLabel: string;
  budgetCount: number;
  onEdit: () => void;
  onAddBudget: () => void;
  onDelete: () => void;
};

function SortableCategory({
  category,
  disabled,
  spendingCents,
  monthLabel,
  budgetCount,
  onEdit,
  onAddBudget,
  onDelete,
}: SortableCategoryProps) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: category.id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("relative", isDragging && "z-10 opacity-70")}
    >
      <CategoryCard
        category={category}
        spendingCents={spendingCents}
        monthLabel={monthLabel}
        budgetCount={budgetCount}
        canBudget={category.type !== "Income"}
        onEdit={onEdit}
        onAddBudget={onAddBudget}
        onDelete={onDelete}
        dragHandle={(
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={setActivatorNodeRef}
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 touch-none cursor-grab p-0 active:cursor-grabbing"
                disabled={disabled}
                {...attributes}
                {...listeners}
                aria-label={`Reorder ${category.name}`}
              >
                <GripVertical className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Drag to reorder</TooltipContent>
          </Tooltip>
        )}
      />
    </div>
  );
}

function SortableCategoryGrid({
  categories,
  disabled,
  renderCategory,
  onMove,
}: {
  categories: BudgetCategory[];
  disabled: boolean;
  renderCategory: (category: BudgetCategory, disabled: boolean) => React.ReactNode;
  onMove: (activeId: number, overId: number) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onMove(Number(active.id), Number(over.id));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={categories.map((category) => category.id)} strategy={rectSortingStrategy}>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {categories.map((category) => renderCategory(category, disabled))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function replaceTypeOrder(
  categories: BudgetCategory[],
  type: CategoryType,
  orderedGroup: BudgetCategory[],
): BudgetCategory[] {
  let index = 0;
  return categories.map((category) => (
    category.type === type ? orderedGroup[index++] : category
  ));
}

export function BudgetCategoriesTab({
  categories,
  budgets,
  rows,
  spending,
  monthLabel,
  onAdd,
  onEdit,
  onBudget,
  onDelete,
}: BudgetCategoriesTabProps) {
  const router = useRouter();
  const [orderedCategories, setOrderedCategories] = useState(categories);
  const [savingOrder, setSavingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);

  useEffect(() => {
    setOrderedCategories(categories);
  }, [categories]);

  const moveCategory = async (type: CategoryType, activeId: number, overId: number) => {
    if (savingOrder) return;
    const group = orderedCategories.filter((category) => category.type === type);
    const oldIndex = group.findIndex((category) => category.id === activeId);
    const newIndex = group.findIndex((category) => category.id === overId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;

    const previous = orderedCategories;
    const orderedGroup = arrayMove(group, oldIndex, newIndex);
    setOrderedCategories(replaceTypeOrder(previous, type, orderedGroup));
    setSavingOrder(true);
    setOrderError(null);

    const result = await reorderCategories(type, orderedGroup.map((category) => category.id));
    if ("error" in result) {
      setOrderedCategories(previous);
      setOrderError(result.error ?? "Failed to save the category order.");
    } else {
      router.refresh();
    }
    setSavingOrder(false);
  };

  if (orderedCategories.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16">
          <Wallet className="mb-4 h-12 w-12 text-muted-foreground" />
          <h3 className="mb-2 text-lg font-semibold">No categories yet</h3>
          <p className="mb-4 max-w-sm text-center text-sm text-muted-foreground">
            Create your first category to start tracking your spending and income.
          </p>
          <Button onClick={onAdd}>
            <Plus className="mr-2 h-4 w-4" />
            Add Your First Category
          </Button>
        </CardContent>
      </Card>
    );
  }

  const groups: Array<{ type: CategoryType; categories: BudgetCategory[] }> = [
    { type: "Income", categories: orderedCategories.filter((category) => category.type === "Income") },
    { type: "Expense", categories: orderedCategories.filter((category) => category.type === "Expense") },
    { type: "Investment", categories: orderedCategories.filter((category) => category.type === "Investment") },
  ];

  return (
    <div className="space-y-6">
      {orderError && <p role="alert" className="text-sm text-destructive">{orderError}</p>}
      <p aria-live="polite" className="sr-only">
        {savingOrder ? "Saving category order" : orderError ? orderError : "Category order saved"}
      </p>
      {groups.map(({ type, categories: group }) => group.length > 0 && (
        <section key={type} className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">{type}</h2>
            <Badge variant={type === "Income" ? "default" : type === "Expense" ? "destructive" : "secondary"}>
              {group.length} {group.length === 1 ? "category" : "categories"}
            </Badge>
          </div>
          <SortableCategoryGrid
            categories={group}
            disabled={savingOrder}
            onMove={(activeId, overId) => void moveCategory(type, activeId, overId)}
            renderCategory={(category, disabled) => (
              <SortableCategory
                key={category.id}
                category={category}
                disabled={disabled}
                spendingCents={spending[category.id] ?? 0}
                monthLabel={monthLabel}
                budgetCount={new Set([
                  ...budgets.filter((budget) => budget.categoryId === category.id).map((budget) => budget.id),
                  ...rows.filter((row) => row.categoryId === category.id).map((row) => row.budgetId),
                ]).size}
                onEdit={() => onEdit(category)}
                onAddBudget={() => onBudget(category.id)}
                onDelete={() => onDelete(category.id)}
              />
            )}
          />
        </section>
      ))}
    </div>
  );
}
