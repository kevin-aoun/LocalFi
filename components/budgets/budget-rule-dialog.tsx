"use client";

/**
 * Create/edit one BUDGET — a limit for a category over a real period, with
 * effective dates and rollover.
 *
 * This is not the category dialog (that is `budget-dialog.tsx`, which still owns
 * name/type/icon/colour and the legacy `monthly_limit_cents`). What was missing
 * before is everything this dialog adds:
 *   - a period other than "calendar month";
 *   - an effective window, so last quarter's limit stays true for last quarter;
 *   - rollover of an unused surplus.
 *
 * INCOME CATEGORIES ARE NOT OFFERED. A budget is a spending limit, so it makes
 * no sense on a paycheque; the dropdown lists `budgetableCategories` only and
 * `createBudget` / `updateBudget` refuse one regardless of the caller.
 *
 * All money crosses to the server as a DECIMAL STRING (the house transport
 * convention) and is parsed with `parseAmount` there; a limit of "0" is a real
 * ceiling and is always sent. Dates are 'YYYY-MM-DD' strings straight from
 * `<input type="date">` — no Date object, so no UTC shift.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { createBudget, updateBudget } from "@/app/actions/budgets";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { todayKey } from "@/lib/dates";

import {
  budgetFormStateFrom,
  budgetableCategories,
  periodLabel,
  periodUnitLabel,
  toBudgetFormData,
  validateBudgetForm,
  withPeriod,
  type BudgetRuleFormState,
  type CategoryOption,
  type EditableBudget,
} from "./budget-view-logic";

type BudgetRuleDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: CategoryOption[];
  /** The budget being edited, or null to create a new one. */
  budget?: EditableBudget | null;
  /** Pre-selected category when creating from a category's "Add budget" button. */
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
  /** Server-side failure to show the user; null when there is nothing wrong. */
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<BudgetRuleFormState>(() =>
    budgetFormStateFrom(null, todayKey(), { categoryId: defaultCategoryId }),
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFormData(budgetFormStateFrom(budget ?? null, todayKey(), { categoryId: defaultCategoryId }));
  }, [budget, defaultCategoryId, open]);

  /** Everything except Income: a budget is a spending limit. */
  const selectableCategories = useMemo(() => budgetableCategories(categories), [categories]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    // Validated here so an unusable value never reaches the action; "0" passes.
    // `categories` (not `selectableCategories`) so a category that is Income is
    // named in the refusal instead of reading as "unknown category".
    const invalid = validateBudgetForm(formData, categories);
    if (invalid) {
      setError(invalid);
      return;
    }

    setLoading(true);
    try {
      const payload = toBudgetFormData(formData);
      const result = budget ? await updateBudget(budget.id, payload) : await createBudget(payload);

      // The action reports failure by RETURNING { error }; the dialog stays open
      // so the message can be read.
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
                      : // Creating: snap the start date to the new period's start.
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
              <Input
                id="budget-from"
                type="date"
                value={formData.effectiveFrom}
                onChange={(event) =>
                  setFormData((prev) => ({ ...prev, effectiveFrom: event.target.value }))
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="budget-to">Until (optional)</Label>
              <Input
                id="budget-to"
                type="date"
                value={formData.effectiveTo}
                onChange={(event) =>
                  setFormData((prev) => ({ ...prev, effectiveTo: event.target.value }))
                }
              />
              <p className="text-xs text-muted-foreground">Leave blank to keep it in force.</p>
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
