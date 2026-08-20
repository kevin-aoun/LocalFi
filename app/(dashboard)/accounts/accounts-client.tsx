"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Camera,
  Info,
  Landmark,
  Loader2,
  Plus,
} from "lucide-react";

import {
  deleteAccount,
  recordNetWorthToday,
  setAccountArchived,
  type AccountWithBalance,
  type NetWorthView,
} from "@/app/actions/accounts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountDialog } from "@/components/accounts/account-dialog";
import { AccountGroup } from "@/components/accounts/account-group";
import { OrphanRepairCard } from "@/components/accounts/orphan-repair-card";
import {
  groupAccountsByKind,
  type AccountRow,
} from "@/components/accounts/account-form-logic";
import { formatCurrencyTotals } from "@/components/assets/currency-totals";
import { fromDateKey, isDateKey } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

type SnapshotSummary = {

  date: string;
  currency: string;
  netWorthCents: number;
};

type AccountsClientProps = {
  accounts: AccountWithBalance[];
  netWorth: NetWorthView;
  latestSnapshot: SnapshotSummary | null;

  orphanCount: number;
};

function formatDateKey(key: string): string {
  return isDateKey(key) ? fromDateKey(key).toLocaleDateString() : key;
}

type BucketMoneyField =
  | "totalAssetsCents"
  | "totalLiabilitiesCents"
  | "netWorthCents"
  | "standaloneAssetsCents";

function bucketLabel(netWorth: NetWorthView, field: BucketMoneyField): string {
  return formatCurrencyTotals(
    netWorth.currencyTotals.map((total) => ({
      currency: total.currency,
      totalCents: total[field],
      count: 1,
    })),
  );
}

function BucketValues({ netWorth, field }: { netWorth: NetWorthView; field: BucketMoneyField }) {
  return (
    <div className="mt-1 space-y-0.5 text-2xl font-bold">
      {netWorth.currencyTotals.map((total) => (
        <div
          key={total.currency}
          className={cn(field === "netWorthCents" && total[field] < 0 && "text-red-600 dark:text-red-400")}
        >
          {formatMoney(total[field], total.currency)}
        </div>
      ))}
    </div>
  );
}

export default function AccountsClient({
  accounts,
  netWorth,
  latestSnapshot,
  orphanCount,
}: AccountsClientProps) {
  const router = useRouter();

  const [showArchived, setShowArchived] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<AccountRow | null>(null);
  const [accountToDelete, setAccountToDelete] = useState<AccountRow | null>(null);

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [snapshotNote, setSnapshotNote] = useState<string | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);

  const grouped = groupAccountsByKind(accounts, { includeArchived: showArchived });
  const mixed = netWorth.aggregateCurrency === null;
  const currencies = netWorth.currencyTotals.map((total) => total.currency);
  const assignable = accounts.filter((account) => !account.archived);

  const refresh = () => router.refresh();

  const openCreate = () => {
    setSelectedAccount(null);
    setDialogOpen(true);
  };

  const openEdit = (account: AccountRow) => {
    setSelectedAccount(account);
    setDialogOpen(true);
  };

  const handleToggleArchived = async (account: AccountRow) => {
    setActionError(null);
    const result = await setAccountArchived(account.id, !account.archived);

    if (result && "error" in result) {
      setActionError(result.error || "Failed to archive the account.");
      return;
    }
    refresh();
  };

  const handleDelete = async () => {
    if (!accountToDelete) return;
    const result = await deleteAccount(accountToDelete.id);

    if (result && "error" in result) {
      setDeleteError(result.error || "Failed to delete the account.");
      return;
    }
    setDeleteError(null);
    setAccountToDelete(null);
    refresh();
  };

  const handleSnapshot = async () => {
    setActionError(null);
    setSnapshotNote(null);
    setSnapshotting(true);
    try {
      const result = await recordNetWorthToday();
      if (result && "error" in result) {
        setActionError(result.error || "Failed to record net worth.");
        return;
      }
      setSnapshotNote(
        `Recorded ${formatMoney(result.data.netWorthCents, result.data.currency)} for ` +
          `${formatDateKey(result.data.date)}. ${result.data.priceSummary}`,
      );
      refresh();
    } catch (err) {
      console.error("Failed to snapshot net worth:", err);
      setActionError(err instanceof Error ? err.message : "Failed to record net worth.");
    } finally {
      setSnapshotting(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Accounts</h1>
          <p className="text-muted-foreground">
            Everything you hold and everything you owe, as of {formatDateKey(netWorth.dateKey)}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleSnapshot} disabled={snapshotting}>
            {snapshotting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Camera className="mr-2 h-4 w-4" />
            )}
            Record today
          </Button>
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            New account
          </Button>
        </div>
      </div>

      {actionError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-6">
            <div className="text-sm text-muted-foreground">Total assets</div>
            <BucketValues netWorth={netWorth} field="totalAssetsCents" />
            <div className="mt-1 text-xs text-muted-foreground">
              Accounts you hold, plus standalone assets ({bucketLabel(netWorth, "standaloneAssetsCents")})
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm text-muted-foreground">Total liabilities</div>
            <BucketValues netWorth={netWorth} field="totalLiabilitiesCents" />
            <div className="mt-1 text-xs text-muted-foreground">
              What you owe, shown as a positive amount
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm text-muted-foreground">Net worth</div>
            <BucketValues netWorth={netWorth} field="netWorthCents" />
            <div className="mt-1 text-xs text-muted-foreground">Assets minus liabilities</div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-2 text-xs text-muted-foreground">
        <p className="flex items-start gap-2">
          <Camera className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {latestSnapshot
              ? `Net-worth history: last recorded ${formatDateKey(latestSnapshot.date)} at ${formatMoney(latestSnapshot.netWorthCents, latestSnapshot.currency)}.`
              : "Net-worth history is empty. Record today to start it."}{" "}
            Recording twice on the same day updates that day rather than adding a duplicate.
          </span>
        </p>
        {snapshotNote && (
          <p className="font-medium text-green-700 dark:text-green-400">{snapshotNote}</p>
        )}
        {netWorth.currencyTotals.some((total) => total.unassignedCents !== 0) && (
          <p className="flex items-start gap-2">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {formatCurrencyTotals(
                netWorth.currencyTotals
                  .filter((total) => total.unassignedCents !== 0)
                  .map((total) => ({
                    currency: total.currency,
                    totalCents: total.unassignedCents,
                    count: 1,
                  })),
              )} comes from transactions with no account and is kept in its own currency bucket.
            </span>
          </p>
        )}
        {mixed && (
          <Tooltip>
            <TooltipTrigger asChild>
              {}
              <p
                tabIndex={0}
                className="flex items-start gap-2 rounded-sm text-amber-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:text-amber-400"
              >
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  Net worth is shown as separate {currencies.join(", ")} buckets. No exchange
                  rates are applied, and no combined amount exists.
                </span>
              </p>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              No exchange rates are applied. Each displayed amount contains one currency only.
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <OrphanRepairCard
        orphanCount={orphanCount}
        accounts={assignable}
        onRepaired={refresh}
      />

      {grouped.isEmpty ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Landmark className="mb-4 h-12 w-12 text-muted-foreground" />
            <h3 className="mb-2 text-lg font-semibold">No accounts yet</h3>
            <p className="mb-4 max-w-md text-center text-sm text-muted-foreground">
              Add the accounts you actually use: current accounts, savings, credit cards,
              loans, a mortgage. Give each one an <strong>opening balance</strong>: the money
              that was already there before your logged history begins. Without it, every
              balance is counted from zero and your net worth reads far too low.
            </p>
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              Add your first account
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {grouped.archivedCount > 0 && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="show-archived"
                checked={showArchived}
                onCheckedChange={(checked) => setShowArchived(checked === true)}
              />
              <Label htmlFor="show-archived" className="text-sm font-normal">
                Show {grouped.archivedCount} archived account
                {grouped.archivedCount === 1 ? "" : "s"} (their balances still count towards net
                worth)
              </Label>
            </div>
          )}

          <AccountGroup
            title="Assets"
            description="Money you hold. A balance is the opening balance plus everything logged since."
            rows={grouped.assets}
            balanceHeader="Balance"
            emptyMessage="No asset accounts yet."
            onEdit={openEdit}
            onToggleArchived={handleToggleArchived}
            onDelete={(account) => {
              setDeleteError(null);
              setAccountToDelete(account);
            }}
          />

          <AccountGroup
            title="Liabilities"
            description="Money you owe, shown as the amount outstanding, not as a negative balance."
            rows={grouped.liabilities}
            balanceHeader="Owed"
            emptyMessage="No liabilities recorded. Add a credit card, loan or mortgage to see them here."
            onEdit={openEdit}
            onToggleArchived={handleToggleArchived}
            onDelete={(account) => {
              setDeleteError(null);
              setAccountToDelete(account);
            }}
          />
        </>
      )}

      <AccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        account={selectedAccount}
        onSuccess={refresh}
      />

      <AlertDialog
        open={accountToDelete !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleteError(null);
            setAccountToDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {accountToDelete?.name ?? "account"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Deleting is only possible while nothing references the account. If it has any
              transactions, archive it instead; that keeps the history and its balance.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {deleteError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{deleteError}</span>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {accountToDelete && !accountToDelete.archived && (
              <Button
                variant="outline"
                onClick={() => {
                  const target = accountToDelete;
                  setAccountToDelete(null);
                  void handleToggleArchived(target);
                }}
              >
                Archive instead
              </Button>
            )}
            <AlertDialogAction
              onClick={(event) => {

                event.preventDefault();
                void handleDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
