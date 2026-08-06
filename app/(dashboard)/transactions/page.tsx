"use client";

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Plus,
  Pencil,
  Trash2,
  Filter,
  ArrowLeftRight,
  CalendarIcon,
  Upload,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Clock,
  Check,
  Search,
  X,
} from "lucide-react";
import { TransactionDialog } from "@/components/transactions/transaction-dialog";
import { TransferDialog } from "@/components/transactions/transfer-dialog";
import { ImportDialog } from "@/components/transactions/import-dialog";
import { getTransactions, deleteTransaction, confirmTransaction } from "@/app/actions/transactions";
import { getAccounts, getDefaultAccountId } from "@/app/actions/accounts";
import { getCategories } from "@/app/actions/categories";
import { getSettings } from "@/app/actions/settings";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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
import { useTransactionsStore } from "@/lib/stores/transactions-store";
import { formatMoney, type Cents } from "@/lib/money";
import { monthKey, toDateKey } from "@/lib/dates";
import { categoryCashDirection, isTransfer } from "@/lib/cash-balance";
import {
  buildLedgerIndex,
  filterLedger,
  hasActiveFilters,
  sortLedger,
  type LedgerAccountFilter,
  type LedgerFilters,
  type LedgerSortColumn,
  type LedgerSortDirection,
} from "@/components/transactions/ledger-filter-logic";
import {
  breakdownTypeFor,
  categoryBreakdown,
  summarizeLedger,
} from "@/components/transactions/ledger-summary-logic";
import { describeTransfer } from "@/components/transactions/transfer-form-logic";

const ITEMS_PER_PAGE = 10;

/**
 * A ledger row as this page needs it. The store's `Transaction` type omits
 * `pending`, so rows are widened once here rather than cast at each use.
 */
type LedgerTransaction = {
  id: number;
  date: Date;
  categoryId: number | null;
  accountId?: number | null;
  transferAccountId?: number | null;
  amountCents: Cents;
  comment: string | null;
  pending?: boolean | null;
};

type AccountRow = {
  id: number;
  name: string;
  kind: string;
  type: string;
  currency: string;
  archived: boolean;
};

export default function TransactionsPage() {
  const {
    transactions,
    categories,
    quickCommands,
    selectedDate,
    selectedType,
    selectedCategory,
    currentPage,
    dialogOpen,
    importDialogOpen,
    deleteDialogOpen,
    selectedTransaction,
    transactionToDelete,
    setTransactions,
    setCategories,
    setQuickCommands,
    setFilteredTransactions,
    setSelectedDate,
    setSelectedType,
    setSelectedCategory,
    setCurrentPage,
    setDialogOpen,
    setImportDialogOpen,
    setDeleteDialogOpen,
    openAddDialog,
    openEditDialog,
    openDeleteDialog,
    openImportDialog,
    clearFilters,
  } = useTransactionsStore();

  const [sortColumn, setSortColumn] = useState<LedgerSortColumn>("date");
  const [sortDirection, setSortDirection] = useState<LedgerSortDirection>("desc");
  /** Failure from a delete/confirm action; null when there is nothing to report. */
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * Filters the shared store does not know about. Kept local on purpose: the
   * store is shared with other routes and this page owns its own view state.
   */
  const [query, setQuery] = useState("");
  const [fromDate, setFromDate] = useState<Date | null>(null);
  const [toDate, setToDate] = useState<Date | null>(null);
  const [accountFilter, setAccountFilter] = useState<LedgerAccountFilter>(null);

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [defaultAccountId, setDefaultAccountId] = useState<number | null>(null);

  /** Transfers get their own dialog: they have two accounts and NO category. */
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [selectedTransfer, setSelectedTransfer] = useState<LedgerTransaction | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const [txData, catData, settings, accountData, defaultId] = await Promise.all([
      getTransactions(),
      getCategories(),
      getSettings(),
      // Archived accounts INCLUDED on purpose: a row filed against a closed
      // account must still show that account's name, not "Unassigned".
      getAccounts({ includeArchived: true }),
      getDefaultAccountId(),
    ]);
    setTransactions(txData);
    setCategories(catData);
    setAccounts(accountData as AccountRow[]);
    setDefaultAccountId(defaultId);

    // Map quick commands from settings to use category IDs
    const commandsWithIds = (settings.quickCommands || []).map((qc) => {
      const category = catData.find((c: any) =>
        c.name.toLowerCase() === qc.categoryName.toLowerCase()
      );
      return {
        command: qc.command,
        categoryId: category?.id || 0,
        amountCents: qc.amountCents,
        comment: qc.comment,
      };
    }).filter((qc) => qc.categoryId !== 0);

    setQuickCommands(commandsWithIds);
  };

  const rows = transactions as LedgerTransaction[];

  // Split into pending vs confirmed. Pending rows are excluded from the cash
  // balance but still appear in the ledger, in their own queue.
  const pendingTransactions = useMemo(() => rows.filter((tx) => tx.pending), [rows]);
  const confirmedTransactions = useMemo(() => rows.filter((tx) => !tx.pending), [rows]);

  /** Category/account lookups hoisted once instead of a `find` per row per render. */
  const index = useMemo(
    () => buildLedgerIndex(categories, accounts),
    [categories, accounts],
  );

  const accountName = (id: number | null | undefined) =>
    id == null ? "" : index.accounts.get(id)?.name ?? "";

  /** Active accounts first; a closed one is still offered so an old row can be edited. */
  const pickerAccounts = useMemo(
    () => [...accounts].sort((a, b) => Number(a.archived) - Number(b.archived)),
    [accounts],
  );

  const filters: LedgerFilters = useMemo(
    () => ({
      query,
      month: selectedDate ? monthKey(selectedDate) : null,
      type: selectedType,
      categoryId: selectedCategory,
      accountId: accountFilter,
      fromKey: fromDate ? toDateKey(fromDate) : null,
      toKey: toDate ? toDateKey(toDate) : null,
    }),
    [query, selectedDate, selectedType, selectedCategory, accountFilter, fromDate, toDate],
  );

  /**
   * In memory, one pass, predicate extracted to ledger-filter-logic.ts where it
   * is unit-tested. Fast enough on a few thousand rows to re-run per keystroke.
   */
  const filteredTransactions = useMemo(
    () => filterLedger(confirmedTransactions, index, filters),
    [confirmedTransactions, index, filters],
  );

  // Keep the shared store's copy honest for any other consumer.
  useEffect(() => {
    setFilteredTransactions(filteredTransactions);
  }, [filteredTransactions, setFilteredTransactions]);

  useEffect(() => {
    setCurrentPage(1);
  }, [filters, rows, setCurrentPage]);

  const summary = useMemo(
    () => summarizeLedger(filteredTransactions, categories),
    [filteredTransactions, categories],
  );

  const breakdown = useMemo(
    () => categoryBreakdown(filteredTransactions, categories, breakdownTypeFor(selectedType)),
    [filteredTransactions, categories, selectedType],
  );

  const filtersActive =
    hasActiveFilters(filters) || query.trim() !== "" || fromDate !== null || toDate !== null;

  const resetAllFilters = () => {
    clearFilters();
    setQuery("");
    setFromDate(null);
    setToDate(null);
    setAccountFilter(null);
  };

  const handleDelete = async () => {
    if (!transactionToDelete) return;

    const result = await deleteTransaction(transactionToDelete);
    // The action reports failure by RETURNING { error }; closing regardless made
    // a failed delete indistinguishable from a successful one.
    if (result && "error" in result && result.error) {
      setActionError(result.error);
      return;
    }

    setActionError(null);
    await loadData();
    setDeleteDialogOpen(false);
  };

  /** Edit routes to the right dialog: a transfer has no category to pick. */
  const openEdit = (tx: LedgerTransaction) => {
    if (isTransfer(tx)) {
      setSelectedTransfer(tx);
      setTransferDialogOpen(true);
      return;
    }
    openEditDialog(tx);
  };

  const openAddTransfer = () => {
    setSelectedTransfer(null);
    setTransferDialogOpen(true);
  };

  // Handle column sorting
  const handleSort = (column: LedgerSortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  };

  const sortedTransactions = useMemo(
    () => sortLedger(filteredTransactions, index, sortColumn, sortDirection),
    [filteredTransactions, sortColumn, sortDirection, index],
  );

  // Pagination
  const totalPages = Math.ceil(sortedTransactions.length / ITEMS_PER_PAGE);
  const paginatedTransactions = sortedTransactions.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  /** The Category cell: a category badge, or a distinct Transfer badge. */
  const renderTypeCell = (transaction: LedgerTransaction) => {
    if (isTransfer(transaction)) {
      return (
        <Badge
          variant="outline"
          className="font-normal border-sky-500 text-sky-600 dark:text-sky-400"
        >
          <ArrowLeftRight className="mr-1 h-3 w-3" />
          Transfer
        </Badge>
      );
    }
    const category = transaction.categoryId == null ? undefined : index.categories.get(transaction.categoryId);
    if (!category) return <span className="text-xs text-muted-foreground">Uncategorized</span>;
    return (
      <Badge
        variant="outline"
        className="font-normal"
        style={{ borderColor: category.color, color: category.color }}
      >
        {category.name}
      </Badge>
    );
  };

  /** The Account cell: one account, or a transfer's direction. */
  const renderAccountCell = (transaction: LedgerTransaction) => {
    if (isTransfer(transaction)) {
      return (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {describeTransfer(accountName(transaction.accountId), accountName(transaction.transferAccountId))}
        </span>
      );
    }
    const name = accountName(transaction.accountId);
    return (
      <span className={cn("text-xs", name ? "text-muted-foreground" : "text-amber-600")}>
        {name || "Unassigned"}
      </span>
    );
  };

  /**
   * The Amount cell. A transfer is signed NEITHER way: it is a movement, not
   * income or expense, and rendering it with a "-" is exactly the mistake that
   * made the old Investment-expense workaround look like real spend.
   */
  const renderAmountCell = (transaction: LedgerTransaction) => {
    if (isTransfer(transaction)) {
      return (
        <span className="font-semibold text-sky-600 dark:text-sky-400 whitespace-nowrap">
          ⇄ {formatMoney(transaction.amountCents)}
        </span>
      );
    }
    const category = transaction.categoryId == null ? undefined : index.categories.get(transaction.categoryId);
    const direction = categoryCashDirection(category?.type);
    return (
      <span
        className={cn(
          "font-semibold",
          direction === "inflow" && "text-green-600",
          direction === "outflow" && "text-red-600",
        )}
      >
        {direction === "inflow" ? "+" : direction === "outflow" ? "-" : ""}
        {formatMoney(transaction.amountCents)}
      </span>
    );
  };

  const datePickerButton = (
    label: string,
    value: Date | null,
    onPick: (date: Date | null) => void,
  ) => (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "w-full justify-start text-left font-normal",
              !value && "text-muted-foreground",
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {value ? format(value, "d MMM yyyy") : <span>{label}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={value || undefined}
            onSelect={(date) => onPick(date || null)}
            initialFocus
          />
        </PopoverContent>
      </Popover>
      {value && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPick(null)}
              aria-label={`Clear ${label}`}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{`Clear ${label}`}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Transactions</h1>
          <p className="text-muted-foreground">
            Income, expenses and transfers between your accounts
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={openImportDialog}>
            <Upload className="mr-2 h-4 w-4" />
            Import
          </Button>
          <Button variant="outline" onClick={openAddTransfer}>
            <ArrowLeftRight className="mr-2 h-4 w-4" />
            Transfer
          </Button>
          <Button onClick={openAddDialog}>
            <Plus className="mr-2 h-4 w-4" />
            Add Transaction
          </Button>
        </div>
      </div>

      {/* Failures from confirm/delete are shown, not swallowed. */}
      {actionError && !deleteDialogOpen && (
        <div
          role="alert"
          className="flex items-start justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>{actionError}</span>
          <button type="button" className="underline" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Filters</CardTitle>
              <Filter className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="ledger-search">
                Search
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="ledger-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Description, category or account…"
                  className="pl-9 pr-9"
                />
                {query !== "" && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setQuery("")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label="Clear search"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Clear search</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">From</label>
                {datePickerButton("Any date", fromDate, setFromDate)}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">To</label>
                {datePickerButton("Any date", toDate, setToDate)}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Month</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !selectedDate && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {selectedDate ? format(selectedDate, "MMM yyyy") : <span>Any month</span>}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={selectedDate || undefined}
                      onSelect={(date) => {
                        setSelectedDate(date || null);
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Type</label>
                <Select value={selectedType} onValueChange={setSelectedType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="income">Income</SelectItem>
                    <SelectItem value="expense">Expense</SelectItem>
                    <SelectItem value="investment">Investment</SelectItem>
                    {/* A transfer is neither income nor expense: its own bucket. */}
                    <SelectItem value="transfer">Transfer</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Category</label>
                <Select
                  value={selectedCategory?.toString() || "all"}
                  onValueChange={(value) => setSelectedCategory(value === "all" ? null : Number(value))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {categories.map((category) => (
                      <SelectItem key={category.id} value={category.id.toString()}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Account</label>
                <Select
                  value={accountFilter === null ? "all" : String(accountFilter)}
                  onValueChange={(value) =>
                    setAccountFilter(
                      value === "all" ? null : value === "unassigned" ? "unassigned" : Number(value),
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Accounts</SelectItem>
                    {pickerAccounts.map((account) => (
                      <SelectItem key={account.id} value={account.id.toString()}>
                        {account.name}
                        {account.archived ? " (archived)" : ""}
                      </SelectItem>
                    ))}
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-sm pt-2 border-t">
              <span className="text-muted-foreground">
                Showing {filteredTransactions.length} transaction{filteredTransactions.length !== 1 ? "s" : ""}
                {summary.transferCount > 0 && (
                  <>
                    {" · "}
                    {summary.transferCount} transfer{summary.transferCount !== 1 ? "s" : ""}, excluded
                    from income and expense
                  </>
                )}
              </span>
              <Button variant="ghost" size="sm" onClick={resetAllFilters} disabled={!filtersActive}>
                Clear Filters
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Totals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Income</span>
              <span className="font-semibold text-green-600">
                +{formatMoney(summary.incomeCents)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Expenses</span>
              <span className="font-semibold text-red-600">
                -{formatMoney(summary.expenseCents)}
              </span>
            </div>
            {summary.investmentCents !== 0 && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Investments</span>
                <span className="font-semibold text-red-600">
                  -{formatMoney(summary.investmentCents)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between border-t pt-2">
              <span className="font-medium">Net</span>
              <span
                className={cn(
                  "font-semibold",
                  summary.netCents < 0 ? "text-red-600" : "text-green-600",
                )}
              >
                {formatMoney(summary.netCents)}
              </span>
            </div>
            {summary.transferCount > 0 && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <ArrowLeftRight className="h-3 w-3" />
                  Transferred
                </span>
                <span>{formatMoney(summary.transferCents)}</span>
              </div>
            )}
            {summary.transferCount > 0 && (
              <p className="text-xs text-muted-foreground">
                Transfers move money between your own accounts, so they are counted in
                neither income nor expenses and leave your net worth unchanged.
              </p>
            )}
            {summary.uncategorizedCount > 0 && (
              <p className="text-xs text-amber-600">
                {summary.uncategorizedCount} row
                {summary.uncategorizedCount !== 1 ? "s have" : " has"} no category and
                {summary.uncategorizedCount !== 1 ? " are" : " is"} counted in no total.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {breakdown.data.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{breakdown.type} Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {breakdown.data.slice(0, 6).map((item) => (
                <div key={item.name} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="font-medium">{item.name}</span>
                    </div>
                    <span className="text-muted-foreground">
                      {formatMoney(item.valueCents)} · {item.percentage.toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full transition-all"
                      style={{
                        width: `${item.percentage}%`,
                        backgroundColor: item.color,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="pt-3 mt-3 border-t text-sm font-semibold">
              Total: {formatMoney(breakdown.totalCents)}
            </div>
          </CardContent>
        </Card>
      )}

      {pendingTransactions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              Pending
              <span className="ml-auto rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-600">
                {pendingTransactions.length}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-6 py-3 text-left text-sm font-semibold">Description</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold">Category</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold">Account</th>
                    <th className="px-6 py-3 text-right text-sm font-semibold">Amount</th>
                    <th className="px-6 py-3 text-right text-sm font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingTransactions.map((transaction) => (
                    <tr key={transaction.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-2">
                          <Clock className="h-3.5 w-3.5 text-yellow-600 shrink-0" />
                          <span className="font-medium">
                            {transaction.comment || (isTransfer(transaction) ? "Transfer" : "—")}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-3">{renderTypeCell(transaction)}</td>
                      <td className="px-6 py-3">{renderAccountCell(transaction)}</td>
                      <td className="px-6 py-3 text-right whitespace-nowrap">
                        {renderAmountCell(transaction)}
                      </td>
                      <td className="px-6 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Popover>
                            {/* Two `asChild` layers deep: Tooltip and Popover
                                both compose onto the SAME button rather than
                                each rendering one, so there is a single control
                                and a single tab stop. */}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <PopoverTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    aria-label="Confirm transaction"
                                  >
                                    <Check className="h-4 w-4 text-green-600" />
                                  </Button>
                                </PopoverTrigger>
                              </TooltipTrigger>
                              <TooltipContent>Confirm transaction</TooltipContent>
                            </Tooltip>
                            <PopoverContent className="w-auto p-0" align="end">
                              <Calendar
                                mode="single"
                                selected={new Date()}
                                onSelect={async (date) => {
                                  if (!date) return;
                                  const result = await confirmTransaction(transaction.id, date);
                                  if (result && "error" in result && result.error) {
                                    setActionError(result.error);
                                    return;
                                  }
                                  setActionError(null);
                                  await loadData();
                                }}
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>
                          <Button variant="ghost" size="sm" onClick={() => openEdit(transaction)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => openDeleteDialog(transaction.id)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {filteredTransactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <ArrowLeftRight className="h-12 w-12 text-muted-foreground mb-4" />
              {filtersActive && confirmedTransactions.length > 0 ? (
                <>
                  <h3 className="text-lg font-semibold mb-2">No matching transactions</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    {confirmedTransactions.length} transaction
                    {confirmedTransactions.length !== 1 ? "s" : ""} are hidden by the current
                    filters.
                  </p>
                  <Button variant="outline" onClick={resetAllFilters}>
                    Clear Filters
                  </Button>
                </>
              ) : (
                <>
                  <h3 className="text-lg font-semibold mb-2">No transactions yet</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Start tracking your finances by adding your first transaction
                  </p>
                  <Button onClick={openAddDialog}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Transaction
                  </Button>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-6 py-4 text-left text-sm font-semibold">
                        <button
                          type="button"
                          onClick={() => handleSort("date")}
                          className="flex items-center gap-2 hover:text-primary transition-colors"
                        >
                          Date
                          {sortColumn === "date" ? (
                            sortDirection === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />
                          ) : (
                            <ArrowUpDown className="h-4 w-4 opacity-50" />
                          )}
                        </button>
                      </th>
                      <th className="px-6 py-4 text-left text-sm font-semibold">Description</th>
                      <th className="px-6 py-4 text-left text-sm font-semibold">
                        <button
                          type="button"
                          onClick={() => handleSort("category")}
                          className="flex items-center gap-2 hover:text-primary transition-colors"
                        >
                          Category
                          {sortColumn === "category" ? (
                            sortDirection === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />
                          ) : (
                            <ArrowUpDown className="h-4 w-4 opacity-50" />
                          )}
                        </button>
                      </th>
                      <th className="px-6 py-4 text-left text-sm font-semibold">Account</th>
                      <th className="px-6 py-4 text-right text-sm font-semibold">
                        <button
                          type="button"
                          onClick={() => handleSort("amount")}
                          className="flex items-center gap-2 ml-auto hover:text-primary transition-colors"
                        >
                          Amount
                          {sortColumn === "amount" ? (
                            sortDirection === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />
                          ) : (
                            <ArrowUpDown className="h-4 w-4 opacity-50" />
                          )}
                        </button>
                      </th>
                      <th className="px-6 py-4 text-right text-sm font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedTransactions.map((transaction) => (
                      <tr
                        key={transaction.id}
                        className={cn(
                          "border-b last:border-0 hover:bg-muted/50 transition-colors",
                          // A transfer is visually its own thing, not a coloured expense.
                          isTransfer(transaction) && "bg-sky-500/5",
                        )}
                      >
                        <td className="px-6 py-4 text-sm whitespace-nowrap">
                          {/* Rendered from the LOCAL calendar day, never via toISOString. */}
                          {format(new Date(transaction.date), "d MMM yyyy")}
                        </td>
                        <td className="px-6 py-4">
                          <div className="font-medium">
                            {transaction.comment ||
                              (isTransfer(transaction)
                                ? describeTransfer(
                                    accountName(transaction.accountId),
                                    accountName(transaction.transferAccountId),
                                  )
                                : "—")}
                          </div>
                        </td>
                        <td className="px-6 py-4">{renderTypeCell(transaction)}</td>
                        <td className="px-6 py-4">{renderAccountCell(transaction)}</td>
                        <td className="px-6 py-4 text-right whitespace-nowrap">
                          {renderAmountCell(transaction)}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={() => openEdit(transaction)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openDeleteDialog(transaction.id)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between px-6 py-4 border-t">
                  <div className="text-sm text-muted-foreground">
                    Page {currentPage} of {totalPages}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <TransactionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        transaction={selectedTransaction}
        categories={categories}
        accounts={pickerAccounts}
        defaultAccountId={defaultAccountId}
        quickCommands={quickCommands}
        onSuccess={loadData}
      />

      <TransferDialog
        open={transferDialogOpen}
        onOpenChange={(next) => {
          setTransferDialogOpen(next);
          if (!next) setSelectedTransfer(null);
        }}
        transfer={selectedTransfer}
        accounts={pickerAccounts}
        defaultAccountId={defaultAccountId}
        onSuccess={loadData}
      />

      <ImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        categories={categories}
        accounts={pickerAccounts}
        defaultAccountId={defaultAccountId}
        onSuccess={loadData}
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Transaction</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this transaction? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {actionError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <span>{actionError}</span>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Keep the dialog open so a failure can be read.
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
