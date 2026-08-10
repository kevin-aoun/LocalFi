"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createCategory, updateCategory } from "@/app/actions/categories";
import { AlertCircle, Loader2 } from "lucide-react";
import { toCategoryFormData } from "./budget-form-logic";
import {
  CATEGORY_ICON_OPTIONS,
  CategoryIcon,
} from "./category-icons";

type Category = {
  id: number;
  name: string;
  type: string;
  color: string;
  icon: string;
};

type BudgetDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category?: Category | null;
  onSuccess: () => void;
};

const COLOR_OPTIONS = [
  "#10b981", "#34d399", "#ef4444", "#f59e0b", "#f97316", "#8b5cf6",
  "#06b6d4", "#ec4899", "#a855f7", "#f43f5e", "#3b82f6", "#6366f1",
  "#14b8a6", "#22c55e", "#0ea5e9"
];

export function BudgetDialog({
  open,
  onOpenChange,
  category,
  onSuccess,
}: BudgetDialogProps) {
  const [loading, setLoading] = useState(false);
  /** Server-side failure to show the user; null when there is nothing wrong. */
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    type: "Expense",
    icon: "Wallet",
    color: "#10b981",
  });

  useEffect(() => {
    setError(null);
    if (category) {
      setFormData({
        name: category.name,
        type: category.type,
        icon: category.icon,
        color: category.color,
      });
    } else {
      setFormData({
        name: "",
        type: "Expense",
        icon: "Wallet",
        color: "#10b981",
      });
    }
  }, [category, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const formDataObj = toCategoryFormData(formData);

      const result = category
        ? await updateCategory(category.id, formDataObj)
        : await createCategory(formDataObj);

      // The action reports failure by RETURNING { error }. Ignoring it is how a
      // duplicate category name used to be silently discarded.
      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save category:", err);
      setError(err instanceof Error ? err.message : "Failed to save category.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {category ? "Edit Category" : "Add Category"}
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
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, name: e.target.value }))
              }
              placeholder="e.g., Groceries, Rent"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="type">Type</Label>
            <Select
              value={formData.type}
              onValueChange={(value) =>
                setFormData((prev) => ({ ...prev, type: value }))
              }
              required
            >
              <SelectTrigger id="type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Income">Income</SelectItem>
                <SelectItem value="Expense">Expense</SelectItem>
                <SelectItem value="Investment">Investment</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label id="icon-label">Icon</Label>
            <div
              role="group"
              aria-labelledby="icon-label"
              className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8"
            >
              {CATEGORY_ICON_OPTIONS.map((icon) => {
                const selected = formData.icon === icon;
                return (
                  <button
                    key={icon}
                    type="button"
                    aria-label={icon}
                    aria-pressed={selected}
                    title={icon}
                    className={`flex h-10 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      selected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-input hover:bg-accent hover:text-accent-foreground"
                    }`}
                    onClick={() => setFormData((prev) => ({ ...prev, icon }))}
                  >
                    <CategoryIcon name={icon} className="h-5 w-5" />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              {COLOR_OPTIONS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="w-8 h-8 rounded-full border-2 transition-all"
                  style={{
                    backgroundColor: color,
                    borderColor: formData.color === color ? "#000" : "transparent",
                  }}
                  onClick={() => setFormData((prev) => ({ ...prev, color }))}
                />
              ))}
            </div>
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
              {category ? "Update" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
