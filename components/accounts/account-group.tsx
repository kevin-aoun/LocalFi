"use client";

import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/money";
import {
  ACCOUNT_TYPE_LABELS,
  describeBalance,
  type AccountRow,
  type AccountTypeName,
} from "./account-form-logic";

type AccountGroupProps = {
  title: string;
  /** One line explaining what this half of the balance sheet is. */
  description: string;
  rows: AccountRow[];
  /** Header for the balance column — "Balance" for assets, "Owed" for liabilities. */
  balanceHeader: string;
  emptyMessage: string;
  onEdit: (account: AccountRow) => void;
  onToggleArchived: (account: AccountRow) => void;
  onDelete: (account: AccountRow) => void;
};

const TONE_CLASS = {
  positive: "text-foreground",
  negative: "text-red-600 dark:text-red-400",
  neutral: "text-muted-foreground",
} as const;

/** One half of the balance sheet: a titled card with a row per account. */
export function AccountGroup({
  title,
  description,
  rows,
  balanceHeader,
  emptyMessage,
  onEdit,
  onToggleArchived,
  onDelete,
}: AccountGroupProps) {
  return (
    <div>
      <div className="mb-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase text-muted-foreground">
                    Account
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase text-muted-foreground">
                    Opening
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase text-muted-foreground">
                    Since then
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase text-muted-foreground">
                    {balanceHeader}
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium uppercase text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((account) => {
                  const balance = describeBalance(account);
                  return (
                    <tr
                      key={account.id}
                      className={cn(
                        "border-b last:border-0 hover:bg-muted/50",
                        account.archived && "opacity-60",
                      )}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{account.name}</span>
                          {account.archived && (
                            <Badge variant="outline" className="text-xs">
                              Archived
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {ACCOUNT_TYPE_LABELS[account.type as AccountTypeName] ?? account.type}
                          {" · "}
                          {account.currency}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-muted-foreground">
                        {formatMoney(account.openingBalanceCents, account.currency)}
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-muted-foreground">
                        {account.activityCents > 0 ? "+" : ""}
                        {formatMoney(account.activityCents, account.currency)}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className={cn("font-semibold", TONE_CLASS[balance.tone])}>
                          {balance.amountLabel}
                        </div>
                        {balance.note && (
                          <div className="text-xs text-muted-foreground">{balance.note}</div>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        {/* Each of these already names itself with the account
                            name via `aria-label`; the tooltip adds the sighted
                            hover copy that `title=` used to give. */}
                        <div className="flex items-center justify-end gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onEdit(account)}
                                aria-label={`Edit ${account.name}`}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Edit</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onToggleArchived(account)}
                                aria-label={
                                  account.archived
                                    ? `Restore ${account.name}`
                                    : `Archive ${account.name}`
                                }
                              >
                                {account.archived ? (
                                  <ArchiveRestore className="h-4 w-4" />
                                ) : (
                                  <Archive className="h-4 w-4" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {account.archived
                                ? "Restore this account"
                                : "Archive: keeps every transaction and its balance"}
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onDelete(account)}
                                aria-label={`Delete ${account.name}`}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              Delete: only possible while the account has no transactions
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
