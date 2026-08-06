"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

/** Only what the dialog needs; `getAccountBalances` rows satisfy this. */
export type AccountForEdit = {
  id: number;
  name: string;
  kind: string;
  type: string;
  openingBalanceCents: number;
  currency: string;
};

type AccountDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null/absent = create. */
  account?: AccountForEdit | null;
  onSuccess: () => void;
};

export function AccountDialog({ open, onOpenChange, account, onSuccess }: AccountDialogProps) {
  const [loading, setLoading] = useState(false);
  /** Server-side (or validation) failure to show the user; null when fine. */
  const [error, setError] = useState<string | null>(null);
  const [formState, setFormState] = useState<AccountFormState>(emptyAccountFormState);

  useEffect(() => {
    setError(null);
    setFormState(account ? accountFormStateFromAccount(account) : emptyAccountFormState());
  }, [account, open]);

  // Changing the type re-forces the kind for every unambiguous type: the server
  // rejects "a Mortgage that is an asset", and so does the form.
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

    // Validate before touching the server so a bad amount is a message, not a throw.
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

      // The actions report failure by RETURNING { error } — a duplicate name, for
      // instance. Closing regardless is how a discarded write used to look like a
      // successful one.
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
              // Text, not number: "1,234.56" is a thing people type, and
              // parseAmount accepts it exactly. Validation happens on submit.
              type="text"
              inputMode="decimal"
              value={formState.openingBalance}
              onChange={(event) =>
                setFormState((prev) => ({ ...prev, openingBalance: event.target.value }))
              }
              placeholder="0.00"
            />
            <p className="text-xs text-muted-foreground">{openingBalanceHelp(formState.kind)}</p>
            {/* `!== null`, not truthiness: an opening balance of 0 is a value the
                user stated, and hiding its confirmation is the same falsy-0
                mistake that has already been found twice in this codebase. */}
            {openingPreviewCents !== null && (
              <p className="text-xs font-medium">
                Starts at {formatMoney(openingPreviewCents, formState.currency || "USD")}
                {formState.kind === "liability" ? " owed" : ""}
              </p>
            )}
            {openingPreviewCents === null && formState.openingBalance.trim() !== "" && (
              <p className="text-xs font-medium text-destructive">
                That is not an amount: try 1,234.56
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="account-currency">Currency</Label>
            <Input
              id="account-currency"
              value={formState.currency}
              onChange={(event) =>
                setFormState((prev) => ({ ...prev, currency: event.target.value }))
              }
              placeholder="USD"
              maxLength={3}
            />
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
