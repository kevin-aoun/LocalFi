"use client";

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { AlertCircle, ArrowRight, CalendarIcon, Loader2 } from "lucide-react";

import {
  createBudgetReallocation,
  getBudgetReallocationAvailability,
  type BudgetReallocationAvailability,
} from "@/app/actions/budgets";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fromMonthKey, monthKey } from "@/lib/dates";
import { centsToDecimal, formatMoney } from "@/lib/money";
import {
  draftedReallocationCents,
  reallocationOverflowCents,
  type ReallocationInputMode,
} from "./budget-reallocation-logic";

type CategoryOption = { id: number; name: string; type: string };
const QUICK_PERCENTAGES = [
  { label: "25%", value: "25" },
  { label: "50%", value: "50" },
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
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [fromCategoryId, setFromCategoryId] = useState("");
  const [toCategoryId, setToCategoryId] = useState("");
  const [inputMode, setInputMode] = useState<ReallocationInputMode>("amount");
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<BudgetReallocationAvailability | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const selectedSource = selectable.find(
    (category) => String(category.id) === fromCategoryId,
  );

  useEffect(() => {
    if (!open) return;
    setMonth(defaultMonth);
    setMonthPickerOpen(false);
    setFromCategoryId("");
    setToCategoryId("");
    setInputMode("amount");
    setValue("");
    setError(null);
    setAvailability(null);
    setAvailabilityError(null);
  }, [defaultMonth, open]);

  useEffect(() => {
    if (!open || fromCategoryId === "") {
      setAvailability(null);
      setAvailabilityError(null);
      setAvailabilityLoading(false);
      return;
    }
    let cancelled = false;
    setAvailability(null);
    setAvailabilityError(null);
    setAvailabilityLoading(true);
    getBudgetReallocationAvailability({ month, categoryId: Number(fromCategoryId) })
      .then((next) => {
        if (!cancelled) setAvailability(next);
      })
      .catch((caught) => {
        if (!cancelled) {
          setAvailabilityError(caught instanceof Error ? caught.message : "Could not load this category’s available budget.");
        }
      })
      .finally(() => {
        if (!cancelled) setAvailabilityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fromCategoryId, month, open]);

  const draftedCents = draftedReallocationCents(
    inputMode,
    value,
    availability?.budgetedCents ?? null,
  );
  const overflowCents = reallocationOverflowCents(draftedCents, availability?.maximumCents ?? null);

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
            <Popover open={monthPickerOpen} onOpenChange={setMonthPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  id="reallocation-month"
                  type="button"
                  variant="outline"
                  className="w-full justify-start text-left font-normal"
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {format(fromMonthKey(month), "MMMM yyyy")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={fromMonthKey(month)}
                  defaultMonth={fromMonthKey(month)}
                  onSelect={(date) => {
                    if (!date) return;
                    setMonth(monthKey(date));
                    setValue("");
                    setMonthPickerOpen(false);
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>

          <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
            <div className="space-y-2">
              <Label>Take from</Label>
              <Select
                value={fromCategoryId}
                onValueChange={(categoryId) => {
                  setFromCategoryId(categoryId);
                  setValue("");
                }}
              >
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
                disabled={!fromCategoryId}
                onValueChange={(next) => {
                  setInputMode(next as ReallocationInputMode);
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
                {inputMode === "amount" ? "Amount" : "Percent of current allocation"}
              </Label>
              <div className="relative">
                {inputMode === "amount" && (
                  <span className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">$</span>
                )}
                <Input
                  id="reallocation-value"
                  type="number"
                  min={inputMode === "amount" ? "0.01" : "0.01"}
                  max={inputMode === "percentage" ? "100" : availability ? centsToDecimal(availability.maximumCents) : undefined}
                  step="0.01"
                  value={value}
                  disabled={!fromCategoryId}
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

          {availabilityLoading && (
            <p className="text-xs text-muted-foreground">Loading available budget…</p>
          )}
          {availabilityError && (
            <p role="alert" className="text-xs text-destructive">{availabilityError}</p>
          )}
          {availability && (
            <p className="text-xs text-muted-foreground" data-private-value>
              {formatMoney(availability.maximumCents)} unspent of {formatMoney(availability.budgetedCents)} is available to move.
            </p>
          )}
          {overflowCents !== null && availability && draftedCents !== null && (
            <p role="alert" className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200" data-private-value>
              This moves {formatMoney(draftedCents)}, but only {formatMoney(availability.maximumCents)} is unspent. Choose a smaller amount or Max.
            </p>
          )}

          <div className="space-y-2">
            <Label>
              {selectedSource
                ? `Quick move from ${selectedSource.name}`
                : "Quick percentage of source"}
            </Label>
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
                    disabled={!fromCategoryId || loading}
                    onClick={() => {
                      setInputMode("percentage");
                      setValue(option.value);
                    }}
                  >
                    {option.label}
                  </Button>
                );
              })}
              <Button
                type="button"
                size="sm"
                variant={inputMode === "amount" && availability !== null && draftedCents === availability.maximumCents ? "default" : "outline"}
                aria-pressed={inputMode === "amount" && availability !== null && draftedCents === availability.maximumCents}
                disabled={!fromCategoryId || loading || availabilityLoading || availability === null || availability.maximumCents <= 0}
                onClick={() => {
                  if (!availability) return;
                  setInputMode("amount");
                  setValue(String(centsToDecimal(availability.maximumCents)));
                }}
              >
                Max
              </Button>
            </div>
            {!selectedSource && (
              <p className="text-xs text-muted-foreground">
                Choose the source category before selecting a percentage.
              </p>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Both categories must have a monthly budget in the selected month. Percentages use the
            current source allocation; Max uses only its unspent amount. Every choice saves as a
            fixed amount so later budget edits cannot rewrite history.
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                loading ||
                selectable.length < 2 ||
                !fromCategoryId ||
                !toCategoryId ||
                value === "" ||
                availabilityLoading ||
                availabilityError !== null ||
                overflowCents !== null
              }
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reallocate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
