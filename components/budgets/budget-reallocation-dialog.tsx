"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";

import { createBudgetReallocation } from "@/app/actions/budgets";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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

type CategoryOption = { id: number; name: string; type: string };
type InputMode = "amount" | "percentage";

const QUICK_PERCENTAGES = [
  { label: "25%", value: "25" },
  { label: "50%", value: "50" },
  { label: "Max", value: "100" },
] as const;

type BudgetReallocationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: CategoryOption[];
  defaultMonth: string;
  onSuccess: () => void;
};

export function BudgetReallocationDialog({
  open,
  onOpenChange,
  categories,
  defaultMonth,
  onSuccess,
}: BudgetReallocationDialogProps) {
  const selectable = useMemo(
    () => categories.filter((category) => category.type !== "Income"),
    [categories],
  );
  const [month, setMonth] = useState(defaultMonth);
  const [fromCategoryId, setFromCategoryId] = useState("");
  const [toCategoryId, setToCategoryId] = useState("");
  const [inputMode, setInputMode] = useState<InputMode>("amount");
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMonth(defaultMonth);
    setFromCategoryId("");
    setToCategoryId("");
    setInputMode("amount");
    setValue("");
    setError(null);
  }, [defaultMonth, open]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload = new FormData();
      payload.set("month", month);
      payload.set("fromCategoryId", fromCategoryId);
      payload.set("toCategoryId", toCategoryId);
      payload.set("inputMode", inputMode);
      payload.set("value", value);
      const result = await createBudgetReallocation(payload);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onSuccess();
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to reallocate budget.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Reallocate this month’s budget</DialogTitle>
          <DialogDescription>
            Move room between two monthly category budgets for one calendar month.
            Their permanent limits and the total budget do not change.
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
            <Label htmlFor="reallocation-month">Month</Label>
            <Input
              id="reallocation-month"
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              required
            />
          </div>

          <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
            <div className="space-y-2">
              <Label>Take from</Label>
              <Select value={fromCategoryId} onValueChange={setFromCategoryId}>
                <SelectTrigger><SelectValue placeholder="Source category" /></SelectTrigger>
                <SelectContent>
                  {selectable
                    .filter((category) => String(category.id) !== toCategoryId)
                    .map((category) => (
                      <SelectItem key={category.id} value={String(category.id)}>
                        {category.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <ArrowRight className="mb-2 hidden h-4 w-4 text-muted-foreground sm:block" />
            <div className="space-y-2">
              <Label>Give to</Label>
              <Select value={toCategoryId} onValueChange={setToCategoryId}>
                <SelectTrigger><SelectValue placeholder="Target category" /></SelectTrigger>
                <SelectContent>
                  {selectable
                    .filter((category) => String(category.id) !== fromCategoryId)
                    .map((category) => (
                      <SelectItem key={category.id} value={String(category.id)}>
                        {category.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Move by</Label>
              <Select
                value={inputMode}
                onValueChange={(next) => {
                  setInputMode(next as InputMode);
                  setValue("");
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="amount">Fixed amount</SelectItem>
                  <SelectItem value="percentage">Percentage</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reallocation-value">
                {inputMode === "amount" ? "Amount" : "Percent of available budget"}
              </Label>
              <div className="relative">
                {inputMode === "amount" && (
                  <span className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">$</span>
                )}
                <Input
                  id="reallocation-value"
                  type="number"
                  min={inputMode === "amount" ? "0.01" : "0.01"}
                  max={inputMode === "percentage" ? "100" : undefined}
                  step="0.01"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  className={inputMode === "amount" ? "pl-7" : "pr-7"}
                  placeholder={inputMode === "amount" ? "30.00" : "50"}
                  required
                />
                {inputMode === "percentage" && (
                  <span className="pointer-events-none absolute right-3 top-2 text-sm text-muted-foreground">%</span>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Quick amount</Label>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="Quick reallocation amount">
              {QUICK_PERCENTAGES.map((option) => {
                const selected = inputMode === "percentage" && value === option.value;
                return (
                  <Button
                    key={option.value}
                    type="button"
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    aria-pressed={selected}
                    onClick={() => {
                      setInputMode("percentage");
                      setValue(option.value);
                    }}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Both categories must have a monthly budget in the selected month. Percentages use
            the source budget still available to reallocate, then save as a fixed amount so later
            budget edits cannot rewrite history.
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || selectable.length < 2}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reallocate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
