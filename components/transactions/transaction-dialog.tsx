"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { fromDateKey, toDateKey } from "@/lib/dates";
import {
  createTransaction,
  updateTransaction,
} from "@/app/actions/transactions";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertCircle, Loader2 } from "lucide-react";
import { centsToDecimal, formatMoney, type Cents } from "@/lib/money";
import { pricedHolding } from "@/lib/prices";
import { unitPriceFromAmountCents } from "@/lib/investments/cost";
import {
  transactionInvestmentKind,
  toTransactionFormData,
  transactionCashAmount,
  validateTransactionForm,
} from "./transaction-form-logic";
import { emptyInvestment, InvestmentFields, type InvestmentForm } from "./investment-fields";
import type { InvestmentKind } from "@/lib/investments/categories";

type Category = {
  id: number;
  name: string;
  type: string;
  color: string;
  icon: string;
  investmentKind?: InvestmentKind | null;
};

type Transaction = {
  id: number;

  categoryId: number | null;

  amountCents: Cents;
  comment: string | null;
  date: Date;
  pending?: boolean | null;

  accountId?: number | null;
  instrumentId?: string | null;
  quantityDelta?: string | null;
  investmentUnitPrice?: string | null;
  investmentFeeAmountCents?: Cents | null;
};

type AccountOption = {
  id: number;
  name: string;
  type: string;

  archived?: boolean;
  currency?: string;
  kind?: string;
};

type QuickCommand = {
  command: string;
  categoryId: number;

  amountCents: Cents;
  comment: string;
};

function centsToInputValue(cents: Cents): string {
  return centsToDecimal(cents).toString();
}

type TransactionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction?: Transaction | null;
  categories: Category[];

  accounts?: AccountOption[];

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

  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    categoryId: "",
    amount: "",
    comment: "",
  });
  const [date, setDate] = useState<Date>(new Date());
  const [isPending, setIsPending] = useState(false);
  const [showQuickCommands, setShowQuickCommands] = useState(false);

  const [accountId, setAccountId] = useState("");
  const [investment, setInvestment] = useState<InvestmentForm>(emptyInvestment);

  useEffect(() => {
    setError(null);
    if (transaction) {
      setFormData({

        categoryId: transaction.categoryId === null ? "" : transaction.categoryId.toString(),
        amount: centsToInputValue(transaction.amountCents),
        comment: transaction.comment || "",
      });
      setDate(transaction.date);
      setIsPending(transaction.pending || false);

      setAccountId(transaction.accountId == null ? "" : String(transaction.accountId));
      const instrumentSymbol = transaction.instrumentId?.replace(/^instrument:[^:]+:/, "") ?? "";
      const quantity = transaction.quantityDelta?.replace(/^-/, "") ?? "";
      const quantityNumber = Number(quantity);
      const inferredUnitPrice = quantityNumber > 0 && transaction.amountCents > 0
        ? unitPriceFromAmountCents(transaction.amountCents, quantity)
        : "";
      setInvestment({
        instrumentSymbol,
        investmentSide: transaction.quantityDelta?.startsWith("-") ? "sell" : "buy",
        quantity,
        unitPrice: transaction.investmentUnitPrice ?? inferredUnitPrice,
        instrumentUnit: pricedHolding(instrumentSymbol)?.defaultUnit ?? "",
        fees: centsToInputValue(transaction.investmentFeeAmountCents ?? 0 as Cents),
      });
    } else {
      setFormData({
        categoryId: "",
        amount: "",
        comment: "",
      });
      setDate(new Date());
      setIsPending(false);
      setAccountId(defaultAccountId == null ? "" : String(defaultAccountId));
      setInvestment(emptyInvestment());
    }
  }, [transaction, defaultAccountId, open]);

  const selectCategory = (categoryId: string) => {
    const selected = categories.find((category) => String(category.id) === categoryId);
    const kind = transactionInvestmentKind(selected);
    const currentKind = transactionInvestmentKind(categories.find((category) => String(category.id) === formData.categoryId), investment.instrumentSymbol);
    if (kind !== currentKind) setInvestment(emptyInvestment(kind));
    setFormData((previous) => ({ ...previous, categoryId }));
  };

  const handleCommentChange = (value: string) => {
    setFormData((prev) => ({ ...prev, comment: value }));

    if (value.startsWith("/")) {
      const command = value.slice(1).toLowerCase();
      const matchingCommand = quickCommands.find((qc) =>
        qc.command.toLowerCase().startsWith(command)
      );

      if (matchingCommand && value === `/${matchingCommand.command}`) {
        selectCategory(String(matchingCommand.categoryId));

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
    setError(null);

    const state = {
      categoryId: formData.categoryId,
      amount: formData.amount,
      comment: formData.comment,
      date,
      pending: isPending,
      accountId,
      ...(showsInvestment ? investment : {}),
    };
    const problem = showsInvestment && !investment.instrumentSymbol ? "Choose an investment instrument." : validateTransactionForm(state);
    if (problem) {
      setError(problem);
      return;
    }
    setLoading(true);

    try {


      const formDataObj = toTransactionFormData(state);

      const result = transaction
        ? await updateTransaction(transaction.id, formDataObj)
        : await createTransaction(formDataObj);




      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }

      onSuccess();
      window.dispatchEvent(new Event("localfi:financial-updated"));
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
  const selectedCategory = categories.find((category) => String(category.id) === formData.categoryId);
  const investmentKind = transactionInvestmentKind(selectedCategory, investment.instrumentSymbol);
  const showsInvestment = investmentKind !== null;
  const tradeAccounts = showsInvestment ? accounts.filter((account) => !account.archived && account.kind === "asset" && account.currency === "USD") : accounts;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[500px]">
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
            <Label htmlFor="category">Category</Label>
            <Select
              value={formData.categoryId}
              onValueChange={selectCategory}
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
                          selectCategory(String(qc.categoryId));
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

          {investmentKind && <InvestmentFields kind={investmentKind} value={investment} onChange={setInvestment} />}

          {accounts.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="account">{showsInvestment ? investment.investmentSide === "sell" ? "Receive into" : "Paid from" : "Account"}</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger id="account">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {tradeAccounts.map((account) => (
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
          {showsInvestment && tradeAccounts.length === 0 && <p className="text-sm text-destructive">Add an active USD asset account in Accounts before recording a trade.</p>}

          <div className="space-y-2">
            <Label htmlFor="amount">{showsInvestment ? investment.investmentSide === "sell" ? "Net proceeds (USD)" : "Total paid (USD)" : "Amount"}</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              min="0"
              value={transactionCashAmount({ amount: formData.amount, ...(showsInvestment ? investment : {}) })}
              readOnly={showsInvestment}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, amount: e.target.value }))
              }
              placeholder="0.00"
              required
            />
          </div>

          <div className="space-y-2">
            <Label>Date</Label>
            <DatePicker value={toDateKey(date)} onChange={(day) => { if (day) setDate(fromDateKey(day)); }} className="w-full" />
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="pending"
              checked={isPending}
              onCheckedChange={(checked) => setIsPending(checked === true)}
              disabled={Boolean(transaction && !transaction.pending)}
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
            <Button type="submit" disabled={loading || (showsInvestment && tradeAccounts.length === 0)}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {transaction ? "Update" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
