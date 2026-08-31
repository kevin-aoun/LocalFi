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
import {
  createTransaction,
  previewInvestmentPurchase,
  updateTransaction,
} from "@/app/actions/transactions";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertCircle, CalendarIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { centsToDecimal, formatMoney, type Cents } from "@/lib/money";
import { PRICE_SYMBOLS, pricedHolding } from "@/lib/prices";
import {
  previewInvestmentQuantity,
  toTransactionFormData,
  validateTransactionForm,
} from "./transaction-form-logic";

type Category = {
  id: number;
  name: string;
  type: string;
  color: string;
  icon: string;
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
};

type AccountOption = {
  id: number;
  name: string;
  type: string;

  archived?: boolean;
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
  onCreateCryptoPurchase?: (defaults: { accountId: number | null; categoryId: number | null }) => void;
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
  onCreateCryptoPurchase,
  onSuccess,
}: TransactionDialogProps) {
  const [loading, setLoading] = useState(false);
  const [providerLoading, setProviderLoading] = useState(false);
  const [previewSource, setPreviewSource] = useState<string | null>(null);

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
  const [investment, setInvestment] = useState({
    instrumentSymbol: "",
    quantity: "",
    unitPrice: "",
    instrumentUnit: "",
  });

  useEffect(() => {
    setError(null);
    setPreviewSource(null);
    if (transaction) {
      setFormData({

        categoryId: transaction.categoryId === null ? "" : transaction.categoryId.toString(),
        amount: centsToInputValue(transaction.amountCents),
        comment: transaction.comment || "",
      });
      setDate(transaction.date);
      setIsPending(transaction.pending || false);

      setAccountId(transaction.accountId == null ? "" : String(transaction.accountId));
      const instrumentSymbol = transaction.instrumentId?.split(":").at(-1) ?? "";
      const quantity = transaction.quantityDelta ?? "";
      const quantityNumber = Number(quantity);
      const inferredUnitPrice = quantityNumber > 0
        ? centsToInputValue(Math.round(transaction.amountCents / quantityNumber) as Cents)
        : "";
      setInvestment({
        instrumentSymbol,
        quantity,
        unitPrice: inferredUnitPrice,
        instrumentUnit: pricedHolding(instrumentSymbol)?.defaultUnit ?? "",
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
      setInvestment({ instrumentSymbol: "", quantity: "", unitPrice: "", instrumentUnit: "" });
    }
  }, [transaction, defaultAccountId, open]);

  const handleCommentChange = (value: string) => {
    setFormData((prev) => ({ ...prev, comment: value }));

    if (value.startsWith("/")) {
      const command = value.slice(1).toLowerCase();
      const matchingCommand = quickCommands.find((qc) =>
        qc.command.toLowerCase().startsWith(command)
      );

      if (matchingCommand && value === `/${matchingCommand.command}`) {

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
      ...investment,
    };
    const problem = validateTransactionForm(state);
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
  const showsInvestment = Boolean(transaction?.instrumentId);
  const quantityPreview = previewInvestmentQuantity(formData.amount, investment.unitPrice);

  const openCryptoPurchase = () => {
    onOpenChange(false);
    onCreateCryptoPurchase?.({
      accountId: accountId === "" ? defaultAccountId : Number(accountId),
      categoryId: selectedCategory?.type === "Investment" ? selectedCategory.id : null,
    });
  };

  const loadProviderPreview = async () => {
    setError(null);
    setProviderLoading(true);
    try {
      const result = await previewInvestmentPurchase(
        investment.instrumentSymbol,
        formData.amount,
      );
      if ("error" in result) {
        setError(result.error ?? "Failed to load provider preview.");
        return;
      }
      setInvestment((previous) => ({
        ...previous,
        instrumentSymbol: result.data.symbol,
        instrumentUnit: result.data.instrumentUnit,
        unitPrice: centsToInputValue(result.data.unitPriceMinor as Cents),
        quantity: result.data.quantity,
      }));
      setPreviewSource(result.data.sourceLabel);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load provider preview.");
    } finally {
      setProviderLoading(false);
    }
  };

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

          {!transaction && onCreateCryptoPurchase && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
              <p className="text-sm font-medium">Buying crypto?</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Use the shared crypto purchase form so the holding and its ledger transaction stay together.
              </p>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={openCryptoPurchase}>
                Add crypto purchase
              </Button>
            </div>
          )}

          {showsInvestment && (
            <div className="space-y-3 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Investment purchase</p>
                <p className="text-xs text-muted-foreground">
                  Confirm the exact acquired quantity. Later prices never rewrite it.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="instrument-symbol">Instrument</Label>
                  <Select
                    value={investment.instrumentSymbol}
                    onValueChange={(symbol) => setInvestment((previous) => ({
                      ...previous,
                      instrumentSymbol: symbol,
                      instrumentUnit: pricedHolding(symbol)?.defaultUnit ?? "",
                    }))}
                  >
                    <SelectTrigger id="instrument-symbol">
                      <SelectValue placeholder="Choose instrument" />
                    </SelectTrigger>
                    <SelectContent>
                      {PRICE_SYMBOLS.map((symbol) => (
                        <SelectItem key={symbol} value={symbol}>
                          {pricedHolding(symbol)?.label ?? symbol} ({symbol})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="investment-unit-price">Unit price</Label>
                  <Input
                    id="investment-unit-price"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={investment.unitPrice}
                    onChange={(event) => setInvestment((previous) => ({
                      ...previous,
                      unitPrice: event.target.value,
                    }))}
                    placeholder="0.00"
                  />
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={
                  providerLoading || investment.instrumentSymbol === "" || formData.amount === ""
                }
                onClick={() => void loadProviderPreview()}
              >
                {providerLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Get provider preview
              </Button>
              {previewSource && (
                <p className="text-xs text-muted-foreground">Preview source: {previewSource}</p>
              )}
              <div className="space-y-2">
                <Label htmlFor="investment-quantity">Exact quantity</Label>
                <div className="flex gap-2">
                  <Input
                    id="investment-quantity"
                    inputMode="decimal"
                    value={investment.quantity}
                    onChange={(event) => setInvestment((previous) => ({
                      ...previous,
                      quantity: event.target.value,
                    }))}
                    placeholder="0.00000000"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={quantityPreview === null}
                    onClick={() => {
                      if (quantityPreview !== null) {
                        setInvestment((previous) => ({ ...previous, quantity: quantityPreview }));
                      }
                    }}
                  >
                    Use entered price
                  </Button>
                </div>
                {quantityPreview !== null && (
                  <p className="text-xs text-muted-foreground">
                    Provider-price preview: {quantityPreview} {investment.instrumentUnit || "units"}
                  </p>
                )}
              </div>
            </div>
          )}

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
