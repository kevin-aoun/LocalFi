"use client";

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { AlertCircle, CalendarIcon, Info, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import {
  createRecurringTransaction,
  updateRecurringTransaction,
} from "@/app/actions/recurring";
import type { RecurringTransaction } from "@/lib/db/schema";
import { fromDateKey, todayKey } from "@/lib/dates";
import { formatMoney, tryParseAmount } from "@/lib/money";
import { frequencies, type Frequency } from "@/lib/recurrence";
import { cn } from "@/lib/utils";

import {
  categoryHint,
  centsToInputValue,
  formatDateKey,
  frequencyLabel,
  monthEndNote,
  previewOccurrences,
  ruleFromFormState,
  toRecurringFormData,
  upcomingThroughKey,
  validateRecurringForm,
  type RecurringFormState,
} from "./recurring-form-logic";

/** The subset of `getRecurringFormOptions()` this dialog needs. */
export type AccountOption = { id: number; name: string; kind: string; type: string };
export type CategoryOption = { id: number; name: string; type: string };

const NONE = "none";

/** How far ahead the in-dialog "this will post on" sanity check looks. */
const PREVIEW_DAYS = 400;

type RecurringDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null/undefined = create. */
  template?: RecurringTransaction | null;
  accounts: AccountOption[];
  categories: CategoryOption[];
  onSuccess: () => void;
};

function emptyState(): RecurringFormState {
  return {
    name: "",
    accountId: "",
    transferAccountId: "",
    categoryId: "",
    amount: "",
    comment: "",
    frequency: "monthly",
    interval: "1",
    startDate: fromDateKey(todayKey()),
    endDate: null,
    archived: false,
  };
}

function stateFromTemplate(template: RecurringTransaction): RecurringFormState {
  return {
    name: template.name,
    accountId: template.accountId === null ? "" : template.accountId.toString(),
    transferAccountId:
      template.transferAccountId === null ? "" : template.transferAccountId.toString(),
    categoryId: template.categoryId === null ? "" : template.categoryId.toString(),
    // A stored amount of 0 cents must render as "0", not as an empty field.
    amount: centsToInputValue(template.amountCents),
    comment: template.comment ?? "",
    frequency: template.frequency,
    interval: template.interval.toString(),
    startDate: fromDateKey(template.startDate),
    endDate: template.endDate === null ? null : fromDateKey(template.endDate),
    archived: template.archived,
  };
}

export function RecurringDialog({
  open,
  onOpenChange,
  template,
  accounts,
  categories,
  onSuccess,
}: RecurringDialogProps) {
  const [loading, setLoading] = useState(false);
  /** Failure from the server action, or from local validation. */
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<RecurringFormState>(emptyState);

  useEffect(() => {
    setError(null);
    setState(template ? stateFromTemplate(template) : emptyState());
  }, [template, open]);

  const set = <K extends keyof RecurringFormState>(key: K, value: RecurringFormState[K]) =>
    setState((prev) => ({ ...prev, [key]: value }));

  const isTransfer = state.transferAccountId !== "";

  /**
   * The occurrences this rule really produces, computed by `lib/recurrence` — not
   * re-derived here. This is what makes the month-end behaviour visible BEFORE the
   * template is saved: an anchor on the 31st shows Feb 28 in the list.
   */
  const preview = useMemo(() => {
    const rule = ruleFromFormState(state);
    if (!rule) return null;
    // The cursor is deliberately ignored: this panel answers "what does this rule
    // mean", not "what is outstanding".
    return previewOccurrences(rule, {
      throughKey: upcomingThroughKey(rule.startDate, PREVIEW_DAYS),
      limit: 8,
    });
  }, [state]);

  const clampNote = useMemo(() => {
    const rule = ruleFromFormState(state);
    return rule ? monthEndNote(rule) : null;
  }, [state]);

  const hint = categoryHint(state);
  const parsedInterval = state.interval.trim();
  /**
   * The typed amount in integer cents, or null when the field is empty/unparseable.
   * `tryParseAmount` is the only float-free way to read this field — never
   * `Number(x) * 100`, which drifts (2.675 * 100 === 267.49999999999994) — and the
   * comparison below is `!== null`, because 0 cents is a real amount.
   */
  const previewCents = tryParseAmount(state.amount.trim() === "" ? null : state.amount);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const problem = validateRecurringForm(state);
    if (problem) {
      setError(problem);
      return;
    }

    setLoading(true);
    try {
      const formData = toRecurringFormData(state);
      const result = template
        ? await updateRecurringTransaction(template.id, formData)
        : await createRecurringTransaction(formData);

      // The action reports failure by RETURNING { error }. Ignoring that is how a
      // rejected write used to look identical to a successful one — so the dialog
      // stays OPEN with the message the server gave.
      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }

      onSuccess();
      onOpenChange(false);
    } catch (cause) {
      console.error("Failed to save recurring transaction:", cause);
      setError(cause instanceof Error ? cause.message : "Failed to save the recurring transaction.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {template ? "Edit recurring transaction" : "New recurring transaction"}
          </DialogTitle>
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
            <Label htmlFor="recurring-name">Name</Label>
            <Input
              id="recurring-name"
              value={state.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Rent"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="recurring-account">Account</Label>
              <Select
                value={state.accountId === "" ? NONE : state.accountId}
                onValueChange={(value) => set("accountId", value === NONE ? "" : value)}
              >
                <SelectTrigger id="recurring-account">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No account</SelectItem>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id.toString()}>
                      <span>{account.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">({account.type})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="recurring-amount">Amount</Label>
              <Input
                id="recurring-amount"
                type="number"
                step="0.01"
                value={state.amount}
                onChange={(e) => set("amount", e.target.value)}
                placeholder="0.00"
              />
              <p className="text-xs text-muted-foreground">
                Amount of ONE occurrence. 0 is allowed.
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="recurring-transfer">Transfer to</Label>
              <Select
                value={state.transferAccountId === "" ? NONE : state.transferAccountId}
                onValueChange={(value) => set("transferAccountId", value === NONE ? "" : value)}
              >
                <SelectTrigger id="recurring-transfer">
                  <SelectValue placeholder="Not a transfer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not a transfer</SelectItem>
                  {accounts
                    .filter((account) => account.id.toString() !== state.accountId)
                    .map((account) => (
                      <SelectItem key={account.id} value={account.id.toString()}>
                        {account.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="recurring-category">Category</Label>
              <Select
                value={state.categoryId === "" ? NONE : state.categoryId}
                onValueChange={(value) => set("categoryId", value === NONE ? "" : value)}
                disabled={isTransfer}
              >
                <SelectTrigger id="recurring-category">
                  <SelectValue placeholder={isTransfer ? "Transfers have no category" : "Select category"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No category</SelectItem>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id.toString()}>
                      <span>{category.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">({category.type})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isTransfer && (
                <p className="text-xs text-muted-foreground">
                  A transfer has no category; this will be cleared on save.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="recurring-comment">Description</Label>
            <Input
              id="recurring-comment"
              value={state.comment}
              onChange={(e) => set("comment", e.target.value)}
              placeholder="Copied onto every occurrence"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="recurring-frequency">Repeats</Label>
              <Select
                value={state.frequency}
                onValueChange={(value) => set("frequency", value as Frequency)}
              >
                <SelectTrigger id="recurring-frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {frequencies.map((frequency) => (
                    <SelectItem key={frequency} value={frequency}>
                      {frequency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="recurring-interval">Every</Label>
              <Input
                id="recurring-interval"
                type="number"
                min="1"
                step="1"
                value={state.interval}
                onChange={(e) => set("interval", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {parsedInterval === ""
                  ? "A whole number of 1 or more."
                  : frequencyLabel(state.frequency, Number(parsedInterval))}
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Starts / next due</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(state.startDate, "PPP")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={state.startDate}
                    onSelect={(date) => {
                      if (date) set("startDate", date);
                    }}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              <p className="text-xs text-muted-foreground">
                The anchor. Every later occurrence is counted from this day.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Ends (optional)</Label>
              <div className="flex gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className={cn(
                        "flex-1 justify-start text-left font-normal",
                        state.endDate === null && "text-muted-foreground",
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {state.endDate === null ? "No end date" : format(state.endDate, "PPP")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={state.endDate ?? undefined}
                      onSelect={(date) => set("endDate", date ?? null)}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                {state.endDate !== null && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Clear end date"
                    onClick={() => set("endDate", null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Inclusive. Blank means it repeats forever.
              </p>
            </div>
          </div>

          {template && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id="recurring-archived"
                checked={state.archived}
                onCheckedChange={(checked) => set("archived", checked === true)}
              />
              <Label htmlFor="recurring-archived" className="cursor-pointer text-sm font-normal">
                Paused (generates nothing, keeps its history)
              </Label>
            </div>
          )}

          {/* What the rule really means, straight from the recurrence engine. */}
          <div className="rounded-md border bg-muted/40 p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Info className="h-4 w-4" />
              This will post on
            </div>
            {preview === null ? (
              <p className="text-sm text-muted-foreground">
                Fill in a valid interval to preview the schedule.
              </p>
            ) : preview.error !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {preview.error}
              </p>
            ) : preview.occurrences.length === 0 ? (
              <p className="text-sm text-destructive">
                Never: the end date leaves no occurrence on or after the start date.
              </p>
            ) : (
              <>
                <ol className="space-y-1 text-sm">
                  {preview.occurrences.map((key) => (
                    <li key={key} className="flex justify-between gap-4">
                      <span>{formatDateKey(key)}</span>
                      <span className="text-muted-foreground">
                        {previewCents === null ? "" : formatMoney(previewCents)}
                      </span>
                    </li>
                  ))}
                </ol>
                {preview.truncated && (
                  <p className="text-xs text-muted-foreground">
                    …and more, {frequencyLabel(state.frequency, Number(parsedInterval) || 1)}.
                  </p>
                )}
              </>
            )}
            {clampNote && <p className="text-xs text-muted-foreground">{clampNote}</p>}
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
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
              {template ? "Update" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
