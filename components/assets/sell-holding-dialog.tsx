"use client";

import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { createTransaction, sellManualHolding } from "@/app/actions/transactions";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fromDateKey, toDateKey } from "@/lib/dates";
import { formatMoney, tryParseAmount } from "@/lib/money";
import {
  buildSaleRequest,
  initialSaleForm,
  saleAccounts,
  saleCategories,
  saleProceeds,
  type SaleAccount,
  type SaleCategory,
  type SaleForm,
  type SaleTarget,
} from "./sell-holding-logic";

type Props = {
  target: SaleTarget;
  accounts: SaleAccount[];
  categories: SaleCategory[];
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
};

// Mount only while a sale is in progress: the form initializes once, so background refreshes keep the input.
export function SellHoldingDialog({ target, accounts, categories, onOpenChange, onSuccess }: Props) {
  const [form, setForm] = useState<SaleForm>(() => initialSaleForm(target, categories, accounts));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const set = (patch: Partial<SaleForm>) => setForm({ ...form, ...patch });
  const accountOptions = saleAccounts(accounts, target);
  const categoryOptions = saleCategories(categories, target);
  const proceedsCents = tryParseAmount(saleProceeds(target, form));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const request = buildSaleRequest(target, form);
      const result = request.action === "trade"
        ? await createTransaction(request.formData)
        : await sellManualHolding(request.assetId, request.formData);
      if ("error" in result && result.error) {
        setError(result.error);
        return;
      }
      onSuccess();
      window.dispatchEvent(new Event("localfi:financial-updated"));
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the sale.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Sell {target.label}</DialogTitle>
          <DialogDescription>
            {target.kind === "priced"
              ? "Records a sale in Transactions. The proceeds, minus fees, go into the account you choose."
              : "Records the sale of the whole holding in Transactions and moves the proceeds into the account you choose."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {target.kind === "priced" ? (
            <div className="space-y-4" data-private-value>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="sale-quantity">{target.unit === "shares" ? "Shares" : target.unit === "coins" ? "Coins" : "Troy ounces"}</Label>
                  <Input id="sale-quantity" inputMode="decimal" data-private-input value={form.quantity} onChange={(event) => set({ quantity: event.target.value })} required />
                  <p className="text-xs text-muted-foreground">You hold {target.quantity}.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sale-unit-price">Price per unit ({target.currency})</Label>
                  <Input id="sale-unit-price" type="number" min="0.0001" step="0.0001" data-private-input value={form.unitPrice} placeholder="0.0000" onChange={(event) => set({ unitPrice: event.target.value })} required />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sale-fees">Fees ({target.currency})</Label>
                <Input id="sale-fees" type="number" min="0" step="0.01" data-private-input value={form.fees} onChange={(event) => set({ fees: event.target.value })} />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="sale-amount">Sale proceeds ({target.currency})</Label>
              <Input id="sale-amount" type="number" min="0" step="0.01" data-private-input value={form.amount} placeholder="0.00" onChange={(event) => set({ amount: event.target.value })} required />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="sale-account">Receive into</Label>
            <Select value={form.accountId} onValueChange={(accountId) => set({ accountId })}>
              <SelectTrigger id="sale-account"><SelectValue placeholder="Choose account" /></SelectTrigger>
              <SelectContent>
                {accountOptions.map((account) => <SelectItem key={account.id} value={String(account.id)}>{account.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {accountOptions.length === 0 && <p className="text-xs text-destructive">Add an active {target.currency} asset account in Accounts first.</p>}
          </div>

          {categoryOptions.length !== 1 && (
            <div className="space-y-2">
              <Label htmlFor="sale-category">Category</Label>
              <Select value={form.categoryId} onValueChange={(categoryId) => set({ categoryId })}>
                <SelectTrigger id="sale-category"><SelectValue placeholder="Choose category" /></SelectTrigger>
                <SelectContent>
                  {categoryOptions.map((category) => <SelectItem key={category.id} value={String(category.id)}>{category.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {categoryOptions.length === 0 && (
                <p className="text-xs text-destructive">
                  {target.kind === "priced"
                    ? "Add an Investment category for this asset type in Budgets first."
                    : "Add an Investment category without stock, crypto or commodity fields in Budgets first."}
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label>Date</Label>
            <DatePicker value={toDateKey(form.date)} onChange={(day) => { if (day) set({ date: fromDateKey(day) }); }} className="w-full" />
          </div>

          {target.kind === "priced" && (
            <p className="text-sm text-muted-foreground">
              Net proceeds: <span className="font-medium text-foreground" data-private-value>{proceedsCents === null ? "—" : formatMoney(proceedsCents, target.currency)}</span>
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
            <Button type="submit" disabled={loading || accountOptions.length === 0 || categoryOptions.length === 0}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record sale
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
