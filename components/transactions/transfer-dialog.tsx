"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createTransfer, updateTransfer } from "@/app/actions/transactions";
import { AlertCircle, ArrowRight, ArrowLeftRight, CalendarIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney, tryParseAmount } from "@/lib/money";
import {
  emptyTransferForm,
  toTransferFormData,
  transferFormFromTransaction,
  validateTransferForm,
  type StoredTransfer,
  type TransferFormState,
} from "./transfer-form-logic";

type AccountOption = {
  id: number;
  name: string;
  kind: string;
  type: string;
  currency?: string;
  /** A closed account is still offered, labelled, so an old transfer can be edited. */
  archived?: boolean;
};

type TransferDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The transfer being edited, or null/undefined to create a new one. */
  transfer?: StoredTransfer | null;
  accounts: AccountOption[];
  /** Pre-selected source account for a new transfer. */
  defaultAccountId: number | null;
  onSuccess: () => void;
};

/**
 * Move money between two of the user's own accounts.
 *
 * A SIBLING of the transaction dialog rather than a mode inside it, because the
 * two forms have almost nothing in common: a transfer has two accounts and NO
 * category, and it must never present a category field at all (see
 * transfer-form-logic.ts). The old workaround — booking the move as an
 * "Investment" expense — showed up as a net-worth LOSS.
 */
export function TransferDialog({
  open,
  onOpenChange,
  transfer,
  accounts,
  defaultAccountId,
  onSuccess,
}: TransferDialogProps) {
  const [loading, setLoading] = useState(false);
  /** Server-side or validation failure to show; null when there is nothing wrong. */
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<TransferFormState>(() => emptyTransferForm(defaultAccountId));

  useEffect(() => {
    setError(null);
    setForm(transfer ? transferFormFromTransaction(transfer) : emptyTransferForm(defaultAccountId));
  }, [transfer, defaultAccountId, open]);

  const set = <K extends keyof TransferFormState>(key: K, value: TransferFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const nameOf = (id: string) => accounts.find((a) => String(a.id) === id)?.name ?? "";
  const currencyOf = (id: string) => accounts.find((a) => String(a.id) === id)?.currency ?? "USD";

  // `!== null`, never a truthiness test: a 0-cent transfer is a real value.
  const previewCents = tryParseAmount(form.amount);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validated here first so the user is told without a round trip. The action
    // enforces all of it again — this is a courtesy, not the only check.
    const problem = validateTransferForm(form);
    if (problem) {
      setError(problem);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // The date is serialized by toTransferFormData, NOT by toISOString():
      // see transaction-form-logic.ts for why that mattered.
      const formData = toTransferFormData(form);
      const result = transfer
        ? await updateTransfer(transfer.id, formData)
        : await createTransfer(formData);

      // The action reports failure by RETURNING { error }, not by throwing.
      // Closing regardless is how a rejected write used to look like a good one.
      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save transfer:", err);
      setError(err instanceof Error ? err.message : "Failed to save transfer.");
    } finally {
      setLoading(false);
    }
  };

  const swap = () =>
    setForm((prev) => ({ ...prev, fromAccountId: prev.toAccountId, toAccountId: prev.fromAccountId }));

  const accountItems = (exclude: string) =>
    accounts
      .filter((account) => String(account.id) !== exclude)
      .map((account) => (
        <SelectItem key={account.id} value={account.id.toString()}>
          <span className="flex items-center gap-2">
            <span>{account.name}</span>
            <span className="text-xs text-muted-foreground">
              ({account.type}{account.archived ? ", archived" : ""})
            </span>
          </span>
        </SelectItem>
      ));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4" />
            {transfer ? "Edit Transfer" : "New Transfer"}
          </DialogTitle>
          <DialogDescription>
            Moving money between your own accounts. A transfer has no category: it is
            neither income nor expense and leaves your net worth unchanged.
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

          {accounts.length < 2 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              A transfer needs two accounts. Add another one on the Accounts page first.
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="transfer-from">From</Label>
              <Select
                value={form.fromAccountId}
                onValueChange={(value) => set("fromAccountId", value)}
              >
                <SelectTrigger id="transfer-from">
                  <SelectValue placeholder="Source account" />
                </SelectTrigger>
                <SelectContent>{accountItems(form.toAccountId)}</SelectContent>
              </Select>
            </div>

            {/* Icon-only, so `aria-label` carries the name and the tooltip only
                repeats it for a sighted mouse user. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mb-1 self-end"
                  onClick={swap}
                  aria-label="Swap the two accounts"
                >
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Swap the two accounts</TooltipContent>
            </Tooltip>

            <div className="space-y-2">
              <Label htmlFor="transfer-to">To</Label>
              <Select value={form.toAccountId} onValueChange={(value) => set("toAccountId", value)}>
                <SelectTrigger id="transfer-to">
                  <SelectValue placeholder="Destination account" />
                </SelectTrigger>
                <SelectContent>{accountItems(form.fromAccountId)}</SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="transfer-amount">Amount</Label>
            <Input
              id="transfer-amount"
              type="number"
              step="0.01"
              min="0"
              value={form.amount}
              onChange={(e) => set("amount", e.target.value)}
              placeholder="0.00"
              required
            />
            {previewCents !== null && form.fromAccountId !== "" && form.toAccountId !== "" && (
              <p className="text-xs text-muted-foreground">
                {nameOf(form.fromAccountId)} −{formatMoney(previewCents, currencyOf(form.fromAccountId))}
                {" · "}
                {nameOf(form.toAccountId)} +{formatMoney(previewCents, currencyOf(form.toAccountId))}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="transfer-comment">Note</Label>
            <Input
              id="transfer-comment"
              value={form.comment}
              onChange={(e) => set("comment", e.target.value)}
              placeholder="Optional: e.g. monthly savings"
            />
          </div>

          <div className="space-y-2">
            <Label>Date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={cn("w-full justify-start text-left font-normal")}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {format(form.date, "PPP")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={form.date}
                  onSelect={(picked) => {
                    if (picked) set("date", picked);
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="transfer-pending"
              checked={form.pending}
              onCheckedChange={(checked) => set("pending", checked === true)}
            />
            <Label htmlFor="transfer-pending" className="text-sm font-normal cursor-pointer">
              Pending (not yet cleared)
            </Label>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || accounts.length < 2}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {transfer ? "Update Transfer" : "Create Transfer"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
