import { AlertTriangle, Pencil, PiggyBank, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import {
  classifyBudgetRow,
  describeRollover,
  formatPeriodRange,
  periodLabel,
  periodUnitLabel,
  type BudgetRowView,
  visualBudgetUsage,
} from "@/components/budgets/budget-view-logic";
import { CategoryIcon } from "@/components/budgets/category-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMoney, type Cents } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  deriveBudgetGoalProgress,
  type BudgetReallocationFlow,
} from "@/lib/budgets";

export type BudgetCategory = {
  id: number;
  name: string;
  type: string;
  color: string;
  icon: string;
  displayOrder: number;
};

export function BudgetCard({
  row,
  onEdit,
  onDelete,
  reallocationFlow,
  dragHandle,
}: {
  row: BudgetRowView;
  onEdit: () => void;
  onDelete: () => void;
  reallocationFlow?: BudgetReallocationFlow;
  dragHandle?: ReactNode;
}) {
  const reallocationCents = reallocationFlow?.netCents ?? 0;
  const visualUsage = visualBudgetUsage(
    row.spentCents,
    row.availableCents,
    reallocationFlow?.outgoingCents ?? 0,
  );
  const status = classifyBudgetRow({
    ...row,
    spentCents: visualUsage.usedCents,
    availableCents: visualUsage.capacityCents,
  });
  const percent = visualUsage.percent;
  const rollover = describeRollover(row);

  const goal = deriveBudgetGoalProgress({
    ...row,
    limitCents: row.limitCents - reallocationCents,
  });

  return (
    <Card className={cn(status === "over" && "border-destructive", status === "near" && "border-orange-500/60")}>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div className="space-y-1">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CategoryIcon name={row.categoryIcon} color={row.categoryColor} />
            {row.categoryName}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="secondary" className="text-[10px]">{periodLabel(row.period)}</Badge>
            {row.rollover && <Badge variant="outline" className="text-[10px]">Rollover</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {dragHandle}
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onEdit} aria-label="Edit budget"><Pencil className="h-3 w-3" /></Button></TooltipTrigger><TooltipContent>Edit budget</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onDelete} aria-label="Delete budget"><Trash2 className="h-3 w-3 text-destructive" /></Button></TooltipTrigger><TooltipContent>Delete budget</TooltipContent></Tooltip>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-2"><div className="text-2xl font-bold">{formatMoney(row.spentCents)}</div>{status === "over" && <AlertTriangle className="h-4 w-4 text-destructive" />}</div>
        <p className="text-xs text-muted-foreground mt-1">of {formatMoney(row.availableCents)} available {periodUnitLabel(row.period)}</p>
        {reallocationCents !== 0 && <p className={cn("mt-1 text-xs", reallocationCents > 0 ? "text-emerald-600" : "text-orange-600")}>{reallocationCents > 0 ? "+" : "−"}{formatMoney(Math.abs(reallocationCents))} {reallocationCents > 0 ? "moved in" : "moved out"} this month</p>}
        <Progress className={cn("mt-3", status === "over" && "bg-destructive/25")} value={Math.min(percent, 100)} />
        <p className="text-xs text-muted-foreground mt-2">{formatPeriodRange(row.period, row.periodKey, row.startKey, row.endKey)} · {Math.round(percent)}% used</p>
        {status === "over" && <p className="text-xs text-destructive mt-2 font-medium">{formatMoney(-row.remainingCents)} over budget</p>}
        {status === "near" && <p className="text-xs text-orange-600 mt-2 font-medium">{formatMoney(row.remainingCents)} left</p>}
        {status === "on-track" && <p className="text-xs text-muted-foreground mt-2">{formatMoney(row.remainingCents)} left</p>}
        {rollover.carriedInLabel && <p className="text-xs text-muted-foreground mt-2">+ {rollover.carriedInLabel}</p>}
        {rollover.carriedOutLabel && <p className="text-xs text-muted-foreground mt-1">{rollover.carriedOutLabel}</p>}
        {rollover.deficitAbsorbed && <p className="text-xs text-muted-foreground mt-1">Nothing carries forward: an overspend is absorbed here, and the next period starts at {formatMoney(row.limitCents)}.</p>}
        {goal && (
          <div
            className="mt-4 space-y-2 rounded-md border bg-muted/30 p-3"
            aria-label={`${goal.name} savings goal`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <PiggyBank className="h-4 w-4" aria-hidden="true" />
                {goal.name}
              </p>
              <span className="text-xs text-muted-foreground">
                Target {formatMoney(goal.targetCents)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <p>
                <span className="block text-muted-foreground">Monthly allocation</span>
                <strong>{formatMoney(goal.monthlyAllocationCents)}</strong>
              </p>
              <p className="text-right">
                <span className="block text-muted-foreground">Accumulated available</span>
                <strong>{formatMoney(goal.savedCents)}</strong>
              </p>
            </div>
            <Progress
              value={goal.progressPercent}
              aria-label={`${goal.name} goal progress`}
            />
            <div className="flex justify-between gap-2 text-xs text-muted-foreground">
              <span>{Math.round(goal.progressPercent)}% saved</span>
              <span>{formatMoney(goal.remainingCents)} still needed</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}


export function CategoryCard({
  category, spendingCents, monthLabel, budgetCount, canBudget, dragHandle, onEdit, onAddBudget, onDelete,
}: {
  category: BudgetCategory;
  spendingCents: Cents;
  monthLabel: string;
  budgetCount: number;
  canBudget: boolean;
  dragHandle?: ReactNode;
  onEdit: () => void;
  onAddBudget: () => void;
  onDelete: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2"><CategoryIcon name={category.icon} color={category.color} />{category.name}</CardTitle>
        <div className="flex items-center gap-1">
          {dragHandle}
          {canBudget && <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onAddBudget} aria-label="Add a budget for this category"><Plus className="h-3 w-3" /></Button></TooltipTrigger><TooltipContent>Add a budget for this category</TooltipContent></Tooltip>}
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onEdit}><Pencil className="h-3 w-3" /></Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onDelete}><Trash2 className="h-3 w-3 text-destructive" /></Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{formatMoney(spendingCents)}</div>
        <p className="text-xs text-muted-foreground mt-1">in {monthLabel}</p>
        <p className="text-xs text-muted-foreground mt-2">{!canBudget ? "Income: a budget is a spending limit, so there is none" : budgetCount === 0 ? "No budget yet" : `${budgetCount} ${budgetCount === 1 ? "budget" : "budgets"}`}</p>
      </CardContent>
    </Card>
  );
}
