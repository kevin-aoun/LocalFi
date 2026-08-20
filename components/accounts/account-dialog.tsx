"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createAccount, updateAccount } from "@/app/actions/accounts";
import { formatMoney, tryParseAmount } from "@/lib/money";
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  accountFormStateFromAccount,
  emptyAccountFormState,
  kindIsEditable,
  openingBalanceHelp,
  resolveFormKind,
  toAccountFormData,
  validateAccountForm,
  type AccountFormState,
  type AccountKind,
  type AccountTypeName,
} from "./account-form-logic";
import { SUPPORTED_CURRENCIES, currencyOption, normalizeAccountCurrency } from "./currencies";

export type AccountForEdit = {
  id: number;
  name: string;
  kind: string;
  type: string;
  openingBalanceCents: number;
  openingBalanceDate?: import("@/lib/dates").DateKey;
  currency: string;
};

type AccountDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  account?: AccountForEdit | null;
  onSuccess: () => void;
};

export function AccountDialog({ open, onOpenChange, account, onSuccess }: AccountDialogProps) {
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [formState, setFormState] = useState<AccountFormState>(emptyAccountFormState);

  useEffect(() => {
    setError(null);
    setFormState(account ? accountFormStateFromAccount(account) : emptyAccountFormState());
  }, [account, open]);

  const handleTypeChange = (value: string) => {
    setFormState((prev) => ({
      ...prev,
      type: value,
      kind: resolveFormKind(value, prev.kind),
    }));
  };

  const openingPreviewCents =
    formState.openingBalance.trim() === "" ? null : tryParseAmount(formState.openingBalance.trim());

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const validation = validateAccountForm(formState);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    setLoading(true);
    try {
      const formData = toAccountFormData(formState);
      const result = account
        ? await updateAccount(account.id, formData)
        : await createAccount(formData);

      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save account:", err);
      setError(err instanceof Error ? err.message : "Failed to save account.");
    } finally {
      setLoading(false);
    }
  };

  const kindEditable = kindIsEditable(formState.type);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{account ? "Edit account" : "New account"}</DialogTitle>
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
            <Label htmlFor="account-name">Name</Label>
            <Input
              id="account-name"
              value={formState.name}
              onChange={(event) =>
                setFormState((prev) => ({ ...prev, name: event.target.value }))
              }
              placeholder="Everyday Checking"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="account-type">Type</Label>
              <Select value={formState.type} onValueChange={handleTypeChange}>
                <SelectTrigger id="account-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCOUNT_TYPES.map((type: AccountTypeName) => (
                    <SelectItem key={type} value={type}>
                      {ACCOUNT_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="account-kind">Side of the balance sheet</Label>
              <Select
                value={formState.kind}
                disabled={!kindEditable}
                onValueChange={(value) =>
                  setFormState((prev) => ({ ...prev, kind: value as AccountKind }))
                }
              >
                <SelectTrigger id="account-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asset">Asset: money you hold</SelectItem>
                  <SelectItem value="liability">Liability: money you owe</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {kindEditable
                  ? "“Other” can sit on either side, so choose one."
                  : `A ${ACCOUNT_TYPE_LABELS[formState.type as AccountTypeName] ?? formState.type} is always ${
                      formState.kind === "liability" ? "a liability" : "an asset"
                    }.`}
              </p>
            </div>
          </div>

          <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
            <Label htmlFor="account-opening-balance">
              Opening balance{formState.kind === "liability" ? " (amount owed)" : ""}
            </Label>
            <Input
              id="account-opening-balance"


              type="text"
              inputMode="decimal"
              data-private-input
              value={formState.openingBalance}
              onChange={(event) =>
                setFormState((prev) => ({ ...prev, openingBalance: event.target.value }))
              }
              placeholder="0.00"
            />
            <p className="text-xs text-muted-foreground">{openingBalanceHelp(formState.kind)}</p>
            {}
            {openingPreviewCents !== null && (
              <p className="text-xs font-medium" data-private-value>
                Starts at {formatMoney(openingPreviewCents, formState.currency || "USD")}
                {formState.kind === "liability" ? " owed" : ""}
              </p>
            )}
            {openingPreviewCents === null && formState.openingBalance.trim() !== "" && (
              <p className="text-xs font-medium text-destructive">
                That is not an amount: try 1,234.56
              </p>
            )}
            <div className="space-y-2 pt-1">
              <Label htmlFor="account-opening-balance-date">Effective from</Label>
              <DatePicker
                id="account-opening-balance-date"
                value={formState.openingBalanceDate}
                onChange={(value) =>
                  setFormState((prev) => ({ ...prev, openingBalanceDate: value ?? prev.openingBalanceDate }))
                }
                aria-label="Opening balance effective date"
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Historical balances before this day exclude the opening amount.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="account-currency">Currency</Label>
            <Select
              value={normalizeAccountCurrency(formState.currency)}
              onValueChange={(value) =>
                setFormState((prev) => ({ ...prev, currency: normalizeAccountCurrency(value) }))
              }
            >
              <SelectTrigger id="account-currency" aria-label="Account currency">
                <SelectValue placeholder="Choose a currency" />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_CURRENCIES.map((currency) => (
                  <SelectItem key={currency.code} value={currency.code}>
                    <span className="mr-2 inline-flex w-8 justify-center font-medium" aria-hidden="true">
                      {currency.icon}
                    </span>
                    <span>{currency.name}</span>
                    <span className="ml-2 text-muted-foreground">({currency.code})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {currencyOption(formState.currency)?.name ?? "Choose a supported ISO currency."}
            </p>
            {}
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
              {account ? "Save" : "Create account"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
