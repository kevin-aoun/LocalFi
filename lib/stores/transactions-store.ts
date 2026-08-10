import { create } from "zustand";
import type { Cents } from "@/lib/money";

type Category = {
  id: number;
  name: string;
  type: string;
  color: string;
  icon: string;
  /** Monthly budget ceiling in integer cents; null means "no limit". */
  monthlyLimitCents: Cents | null;
};

type Transaction = {
  id: number;
  /**
   * NULL for a transfer (which has no category), or for a row whose category was
   * deleted. See lib/db/schema/transactions.ts.
   */
  categoryId: number | null;
  /** Amount in integer cents. */
  amountCents: Cents;
  comment: string | null;
  date: Date;
  /** The account this row belongs to; NULL for rows not yet assigned to one. */
  accountId?: number | null;
  /** Set only on a transfer: the destination account. */
  transferAccountId?: number | null;
  pending?: boolean | null;
  currentEventId?: string | null;
  instrumentId?: string | null;
  quantityDelta?: string | null;
  transferPrincipalAmountCents?: Cents | null;
  allocations?: Array<{ categoryId: number; amountCents: Cents }>;
};

type QuickCommand = {
  command: string;
  categoryId: number;
  /** Pre-filled amount in integer cents. */
  amountCents: Cents;
  comment: string;
};

type TransactionsStore = {
  // Data
  transactions: Transaction[];
  categories: Category[];
  quickCommands: QuickCommand[];
  filteredTransactions: Transaction[];

  setTransactions: (transactions: Transaction[]) => void;
  setCategories: (categories: Category[]) => void;
  setQuickCommands: (commands: QuickCommand[]) => void;
  setFilteredTransactions: (transactions: Transaction[]) => void;

  // Filters
  selectedDate: Date | null;
  selectedType: string;
  selectedCategory: number | null;
  currentPage: number;

  setSelectedDate: (date: Date | null) => void;
  setSelectedType: (type: string) => void;
  setSelectedCategory: (categoryId: number | null) => void;
  setCurrentPage: (page: number | ((prev: number) => number)) => void;

  // Dialog states
  dialogOpen: boolean;
  importDialogOpen: boolean;
  deleteDialogOpen: boolean;

  setDialogOpen: (open: boolean) => void;
  setImportDialogOpen: (open: boolean) => void;
  setDeleteDialogOpen: (open: boolean) => void;

  // Selected items
  selectedTransaction: Transaction | null;
  transactionToDelete: number | null;

  setSelectedTransaction: (transaction: Transaction | null) => void;
  setTransactionToDelete: (id: number | null) => void;

  // Actions
  openAddDialog: () => void;
  openEditDialog: (transaction: Transaction) => void;
  openDeleteDialog: (transactionId: number) => void;
  openImportDialog: () => void;
  closeAllDialogs: () => void;
  clearFilters: () => void;
};

export const useTransactionsStore = create<TransactionsStore>((set) => ({
  // Initial state
  transactions: [],
  categories: [],
  quickCommands: [],
  filteredTransactions: [],
  selectedDate: null,
  selectedType: "all",
  selectedCategory: null,
  currentPage: 1,
  dialogOpen: false,
  importDialogOpen: false,
  deleteDialogOpen: false,
  selectedTransaction: null,
  transactionToDelete: null,

  // Setters
  setTransactions: (transactions) => set({ transactions }),
  setCategories: (categories) => set({ categories }),
  setQuickCommands: (commands) => set({ quickCommands: commands }),
  setFilteredTransactions: (transactions) => set({ filteredTransactions: transactions }),
  setSelectedDate: (date) => set({ selectedDate: date }),
  setSelectedType: (type) => set({ selectedType: type }),
  setSelectedCategory: (categoryId) => set({ selectedCategory: categoryId }),
  setCurrentPage: (page) => set((state) => ({
    currentPage: typeof page === "function" ? page(state.currentPage) : page
  })),
  setDialogOpen: (open) => set({ dialogOpen: open }),
  setImportDialogOpen: (open) => set({ importDialogOpen: open }),
  setDeleteDialogOpen: (open) => set({ deleteDialogOpen: open }),
  setSelectedTransaction: (transaction) => set({ selectedTransaction: transaction }),
  setTransactionToDelete: (id) => set({ transactionToDelete: id }),

  // Actions
  openAddDialog: () =>
    set({
      selectedTransaction: null,
      dialogOpen: true,
    }),

  openEditDialog: (transaction) =>
    set({
      selectedTransaction: transaction,
      dialogOpen: true,
    }),

  openDeleteDialog: (transactionId) =>
    set({
      transactionToDelete: transactionId,
      deleteDialogOpen: true,
    }),

  openImportDialog: () =>
    set({
      importDialogOpen: true,
    }),

  closeAllDialogs: () =>
    set({
      dialogOpen: false,
      importDialogOpen: false,
      deleteDialogOpen: false,
      selectedTransaction: null,
      transactionToDelete: null,
    }),

  clearFilters: () =>
    set({
      selectedDate: null,
      selectedType: "all",
      selectedCategory: null,
    }),
}));
