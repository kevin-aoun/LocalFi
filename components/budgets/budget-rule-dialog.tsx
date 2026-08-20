"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { createBudget, updateBudget } from "@/app/actions/budgets";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { budgetPeriods, type BudgetPeriod } from "@/lib/budgets";
import { todayKey, type DateKey } from "@/lib/dates";

import {
  budgetFormStateFrom,
  toBudgetFormData,
  validateBudgetForm,
  withPeriod,
  type BudgetRuleFormState,
  type EditableBudget,
} from "./budget-form-logic";
import {
  budgetableCategories,
  periodLabel,
  periodUnitLabel,
  type CategoryOption,
} from "./budget-view-logic";

type BudgetRuleDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: CategoryOption[];

  budget?: EditableBudget | null;

  defaultCategoryId?: number;
  onSuccess: () => void;
};

export function BudgetRuleDialog({
  open,
  onOpenChange,
  categories,
  budget,
  defaultCategoryId,
  onSuccess,
}: BudgetRuleDialogProps) {
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<BudgetRuleFormState>(() =>
    budgetFormStateFrom(null, todayKey(), { categoryId: defaultCategoryId }),
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFormData(budgetFormStateFrom(budget ?? null, todayKey(), { categoryId: defaultCategoryId }));
  }, [budget, defaultCategoryId, open]);

  const selectableCategories = useMemo(() => budgetableCategories(categories), [categories]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const invalid = validateBudgetForm(formData, categories);
    if (invalid) {
      setError(invalid);
      return;
    }

    setLoading(true);
    try {
      const payload = toBudgetFormData(formData);
      const result = budget ? await updateBudget(budget.id, payload) : await createBudget(payload);

      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save budget:", err);
      setError(err instanceof Error ? err.message : "Failed to save budget.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{budget ? "Edit Budget" : "New Budget"}</DialogTitle>
          <DialogDescription>
            A spending limit for one category over one period. Income categories
            are not listed: a paycheque is not spending, so there is nothing to
            limit.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="budget-category">Category</Label>
            <Select
              value={formData.categoryId}
              onValueChange={(value) => setFormData((prev) => ({ ...prev, categoryId: value }))}
              disabled={budget != null}
            >
              <SelectTrigger id="budget-category">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {selectableCategories.map((category) => (
                  <SelectItem key={category.id} value={String(category.id)}>
                    {category.name} · {category.type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {budget != null && (
              <p className="text-xs text-muted-foreground">
                The category is fixed once a budget exists; delete this budget to move it.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="budget-period">Period</Label>
              <Select
                value={formData.period}
                onValueChange={(value) =>
                  setFormData((prev) =>
                    budget
                      ? { ...prev, period: value as BudgetPeriod }
                      :
                        withPeriod(prev, value as BudgetPeriod),
                  )
                }
              >
                <SelectTrigger id="budget-period">
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
            </div>

            <div className="space-y-2">
              <Label htmlFor="budget-limit">Limit</Label>
              <Input
                id="budget-limit"
                type="number"
                step="0.01"
                min="0"
                value={formData.limit}
                onChange={(event) =>
                  setFormData((prev) => ({ ...prev, limit: event.target.value }))
                }
                placeholder="0.00"
                required
              />
              <p className="text-xs text-muted-foreground">
                {`Amount available ${periodUnitLabel(
                  formData.period,
                )}. 0 is a real ceiling: spend nothing.`}
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="budget-from">In force from</Label>
              <DatePicker
                id="budget-from"
                value={formData.effectiveFrom}
                onChange={(value) =>
                  value && setFormData((prev) => ({ ...prev, effectiveFrom: value }))
                }
                aria-label="Budget start date"
                className="w-full"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="budget-to">Until (optional)</Label>
              <DatePicker
                id="budget-to"
                value={formData.effectiveTo === "" ? null : (formData.effectiveTo as DateKey)}
                onChange={(value) =>
                  value && setFormData((prev) => ({ ...prev, effectiveTo: value }))
                }
                aria-label="Budget end date"
                placeholder="No end date"
                className="w-full"
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">Leave blank to keep it in force.</p>
                {formData.effectiveTo !== "" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setFormData((prev) => ({ ...prev, effectiveTo: "" }))}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-start gap-3">
              <Checkbox
                id="budget-rollover"
                checked={formData.rollover}
                onCheckedChange={(checked) =>
                  setFormData((prev) => ({ ...prev, rollover: checked === true }))
                }
              />
              <div className="space-y-1">
                <Label htmlFor="budget-rollover" className="font-medium">
                  Carry unused amounts forward
                </Label>
                <p className="text-xs text-muted-foreground">
                  A surplus is added to the next period&apos;s available amount. An
                  overspend is <strong>not</strong> carried: the next period starts
                  clean at its own limit.
                </p>
              </div>
            </div>

            <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="budget-goal-name">Savings goal (optional)</Label>
                <Input
                  id="budget-goal-name"
                  value={formData.goalName}
                  onChange={(event) =>
                    setFormData((prev) => ({ ...prev, goalName: event.target.value }))
                  }
                  placeholder="Emergency fund"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="budget-goal-amount">Target amount</Label>
                <Input
                  id="budget-goal-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={formData.goalAmount}
                  onChange={(event) =>
                    setFormData((prev) => ({ ...prev, goalAmount: event.target.value }))
                  }
                  placeholder="0.00"
                />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                A goal is available on monthly rollover budgets. Progress uses the
                amount already left in this budget; it does not create contributions
                or transactions. Clear both fields to remove the goal.
              </p>
            </div>

            {!budget && (
              <div className="flex items-start gap-3">
                <Checkbox
                  id="budget-close-previous"
                  checked={formData.closePrevious}
                  onCheckedChange={(checked) =>
                    setFormData((prev) => ({ ...prev, closePrevious: checked === true }))
                  }
                />
                <div className="space-y-1">
                  <Label htmlFor="budget-close-previous" className="font-medium">
                    Replace the current budget for this category
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Ends the existing budget the day before this one starts, so past
                    periods keep the limit they actually had.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {budget ? "Update" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
