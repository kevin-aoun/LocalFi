"use client";

import { useState, useEffect } from "react";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createTransaction, updateTransaction } from "@/app/actions/transactions";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertCircle, CalendarIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { centsToDecimal, formatMoney, type Cents } from "@/lib/money";
import { toTransactionFormData } from "./transaction-form-logic";

type Category = {
  id: number;
  name: string;
  type: string;
  color: string;
  icon: string;
};

type Transaction = {
  id: number;
  /** null for a transfer, or for a row whose category was deleted. */
  categoryId: number | null;
  /** Amount in integer cents. */
  amountCents: Cents;
  comment: string | null;
  date: Date;
  pending?: boolean;
  /** The account the row belongs to; null for rows not yet assigned to one. */
  accountId?: number | null;
};

/** The subset of an account row the picker needs. */
type AccountOption = {
  id: number;
  name: string;
  type: string;
  /** A closed account is still offered, labelled, so an old row can be edited. */
  archived?: boolean;
};

type QuickCommand = {
  command: string;
  categoryId: number;
  /** Pre-filled amount in integer cents. */
  amountCents: Cents;
  comment: string;
};

/**
 * Cents -> the decimal string an `<input type="number">` expects. The server
 * action parses it back with `parseAmount`, which round-trips exactly.
 */
function centsToInputValue(cents: Cents): string {
  return centsToDecimal(cents).toString();
}

type TransactionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction?: Transaction | null;
  categories: Category[];
  /** Accounts the row can be filed against. Empty is fine (pre-accounts data). */
  accounts?: AccountOption[];
  /** `getDefaultAccountId()` — what a NEW transaction is pre-filled with. */
  defaultAccountId?: number | null;
  quickCommands: QuickCommand[];
  onSuccess: () => void;
};

export function TransactionDialog({
  open,
  onOpenChange,
  transaction,
  categories,
  accounts = [],
  defaultAccountId = null,
  quickCommands,
  onSuccess,
}: TransactionDialogProps) {
  const [loading, setLoading] = useState(false);
  /** Server-side failure to show the user; null when there is nothing wrong. */
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    categoryId: "",
    amount: "",
    comment: "",
  });
  const [date, setDate] = useState<Date>(new Date());
  const [isPending, setIsPending] = useState(false);
  const [showQuickCommands, setShowQuickCommands] = useState(false);
  /**
   * The account this row belongs to, as a string for the `<Select>`. "" means
   * "not supplied", which the action reads as: default account on create, leave
   * the account UNCHANGED on update.
   */
  const [accountId, setAccountId] = useState("");

  useEffect(() => {
    setError(null);
    if (transaction) {
      setFormData({
        // A row with no category (a transfer, or one whose category was
        // deleted) opens with the Category field empty rather than crashing.
        categoryId: transaction.categoryId === null ? "" : transaction.categoryId.toString(),
        amount: centsToInputValue(transaction.amountCents),
        comment: transaction.comment || "",
      });
      setDate(transaction.date);
      setIsPending(transaction.pending || false);
      // `== null` and not `|| ""`: an account id is never 0, but the nullish
      // check is what keeps a falsy-zero bug from being introduced later.
      setAccountId(transaction.accountId == null ? "" : String(transaction.accountId));
    } else {
      setFormData({
        categoryId: "",
        amount: "",
        comment: "",
      });
      setDate(new Date());
      setIsPending(false);
      setAccountId(defaultAccountId == null ? "" : String(defaultAccountId));
    }
  }, [transaction, defaultAccountId, open]);

  const handleCommentChange = (value: string) => {
    setFormData((prev) => ({ ...prev, comment: value }));

    // Check for quick command
    if (value.startsWith("/")) {
      const command = value.slice(1).toLowerCase();
      const matchingCommand = quickCommands.find((qc) =>
        qc.command.toLowerCase().startsWith(command)
      );

      if (matchingCommand && value === `/${matchingCommand.command}`) {
        // Apply quick command
        setFormData({
          categoryId: matchingCommand.categoryId.toString(),
          amount: centsToInputValue(matchingCommand.amountCents),
          comment: matchingCommand.comment,
        });
      }

      setShowQuickCommands(true);
    } else {
      setShowQuickCommands(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // The date is serialized by toTransactionFormData, NOT by toISOString():
      // see transaction-form-logic.ts for why that mattered.
      const formDataObj = toTransactionFormData({
        categoryId: formData.categoryId,
        amount: formData.amount,
        comment: formData.comment,
        date,
        pending: isPending,
        accountId,
      });

      const result = transaction
        ? await updateTransaction(transaction.id, formDataObj)
        : await createTransaction(formDataObj);

      // The server action reports failure by RETURNING { error }, not by
      // throwing. Ignoring it is how a rejected write used to look like a
      // successful one.
      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save transaction:", err);
      setError(err instanceof Error ? err.message : "Failed to save transaction.");
    } finally {
      setLoading(false);
    }
  };

  const filteredQuickCommands = showQuickCommands
    ? quickCommands.filter((qc) =>
        qc.command.toLowerCase().includes(formData.comment.slice(1).toLowerCase())
      )
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {transaction ? "Edit Transaction" : "Add Transaction"}
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
            <Label htmlFor="comment">Description</Label>
            <div className="relative">
              <Input
                id="comment"
                value={formData.comment}
                onChange={(e) => handleCommentChange(e.target.value)}
                placeholder="Type / for quick commands"
                required
              />
              {showQuickCommands && filteredQuickCommands.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-lg z-50 max-h-48 overflow-y-auto">
                  {filteredQuickCommands.map((qc) => {
                    const category = categories.find((c) => c.id === qc.categoryId);
                    return (
                      <button
                        key={qc.command}
                        type="button"
                        className="w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2 text-sm"
                        onClick={() => {
                          setFormData({
                            categoryId: qc.categoryId.toString(),
                            amount: centsToInputValue(qc.amountCents),
                            comment: qc.comment,
                          });
                          setShowQuickCommands(false);
                        }}
                      >
                        <span className="font-mono text-primary">/{qc.command}</span>
                        <span className="text-muted-foreground">→</span>
                        <span>{category?.name}</span>
                        <span className="ml-auto font-medium">{formatMoney(qc.amountCents)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="category">Category</Label>
            <Select
              value={formData.categoryId}
              onValueChange={(value) =>
                setFormData((prev) => ({ ...prev, categoryId: value }))
              }
              required
            >
              <SelectTrigger id="category">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id.toString()}>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: category.color }}
                      />
                      <span>{category.name}</span>
                      <span className="text-xs text-muted-foreground">
                        ({category.type})
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {accounts.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="account">Account</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger id="account">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id.toString()}>
                      <div className="flex items-center gap-2">
                        <span>{account.name}</span>
                        <span className="text-xs text-muted-foreground">
                          ({account.type}{account.archived ? ", archived" : ""})
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="amount">Amount</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              min="0"
              value={formData.amount}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, amount: e.target.value }))
              }
              placeholder="0.00"
              required
            />
          </div>

          <div className="space-y-2">
            <Label>Date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !date && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {date ? format(date, "PPP") : <span>Pick a date</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={date}
                  onSelect={(selectedDate) => {
                    if (selectedDate) {
                      setDate(selectedDate);
                    }
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="pending"
              checked={isPending}
              onCheckedChange={(checked) => setIsPending(checked === true)}
            />
            <Label htmlFor="pending" className="text-sm font-normal cursor-pointer">
              Pending
            </Label>
          </div>

          <div className="flex justify-end gap-2 pt-4">
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
              {transaction ? "Update" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
