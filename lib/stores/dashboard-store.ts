import { create } from "zustand";
import type { Cents } from "@/lib/money";

type Asset = {
  id: number;
  category: string;

  currentValueCents: Cents;
  currency: string;
  notes?: string | null;
};

type DashboardStore = {

  assets: Asset[];
  setAssets: (assets: Asset[]) => void;

  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;

  deleteDialogOpen: boolean;
  setDeleteDialogOpen: (open: boolean) => void;

  selectedAsset: Asset | null;
  setSelectedAsset: (asset: Asset | null) => void;

  assetToDelete: number | null;
  setAssetToDelete: (id: number | null) => void;

  chartStyle: "smooth" | "step";
  setChartStyle: (style: "smooth" | "step") => void;

  openAddDialog: () => void;
  openEditDialog: (asset: Asset) => void;
  openDeleteDialog: (assetId: number) => void;
  closeAllDialogs: () => void;
};

export const useDashboardStore = create<DashboardStore>((set) => ({

  assets: [],
  dialogOpen: false,
  deleteDialogOpen: false,
  selectedAsset: null,
  assetToDelete: null,
  chartStyle: "smooth",

  setAssets: (assets) => set({ assets }),
  setDialogOpen: (open) => set({ dialogOpen: open }),
  setDeleteDialogOpen: (open) => set({ deleteDialogOpen: open }),
  setSelectedAsset: (asset) => set({ selectedAsset: asset }),
  setAssetToDelete: (id) => set({ assetToDelete: id }),
  setChartStyle: (style) => set({ chartStyle: style }),

  openAddDialog: () =>
    set({
      selectedAsset: null,
      dialogOpen: true,
    }),

  openEditDialog: (asset) =>
    set({
      selectedAsset: asset,
      dialogOpen: true,
    }),

  openDeleteDialog: (assetId) =>
    set({
      assetToDelete: assetId,
      deleteDialogOpen: true,
    }),

  closeAllDialogs: () =>
    set({
      dialogOpen: false,
      deleteDialogOpen: false,
      selectedAsset: null,
      assetToDelete: null,
    }),
}));
