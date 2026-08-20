
import { centsToDecimal, sumCents, type Cents } from "@/lib/money";
import type { CategoryBreakdownRow } from "@/lib/reports";

export type CategoryColors = Record<number, string | null | undefined>;

export function categorySwatch(
  row: Pick<CategoryBreakdownRow, "categoryId">,
  colors: CategoryColors,
): string {
  const own = row.categoryId !== null ? colors[row.categoryId] : undefined;
  return typeof own === "string" && own.trim() !== "" ? own : "hsl(var(--muted-foreground))";
}

export type CategorySlice = {

  key: string;
  categoryId: number | null;
  name: string;

  cents: Cents;

  value: number;

  share: number;
  color: string;
  count: number;

  uncategorized: boolean;
};

export type ExcludedSlice = {
  name: string;
  cents: Cents;

  reason: "zero" | "negative";
};

export type CategoryPieModel = {
  slices: CategorySlice[];

  totalCents: Cents;

  excluded: ExcludedSlice[];

  partial: boolean;
};

export function buildCategoryPie(
  rows: readonly CategoryBreakdownRow[],
  colors: CategoryColors,
): CategoryPieModel {
  const drawable: CategoryBreakdownRow[] = [];
  const excluded: ExcludedSlice[] = [];

  for (const row of rows) {

    if (row.totalCents > 0) drawable.push(row);
    else {
      excluded.push({
        name: row.name,
        cents: row.totalCents,
        reason: row.totalCents === 0 ? "zero" : "negative",
      });
    }
  }

  const totalCents = sumCents(drawable.map((r) => r.totalCents));

  const slices: CategorySlice[] = drawable.map((row, index) => ({
    key: `${row.categoryId ?? "none"}-${row.type}-${index}`,
    categoryId: row.categoryId,
    name: row.name,
    cents: row.totalCents,
    value: centsToDecimal(row.totalCents),
    share: totalCents > 0 ? row.totalCents / totalCents : 0,
    color: categorySwatch(row, colors),
    count: row.count,
    uncategorized: row.uncategorized,
  }));

  return {
    slices,
    totalCents,
    excluded,
    partial: excluded.length > 0,
  };
}





export const categoryViews = ["bar", "pie"] as const;
export type CategoryView = (typeof categoryViews)[number];

export function isCategoryView(value: unknown): value is CategoryView {
  return typeof value === "string" && (categoryViews as readonly string[]).includes(value);
}
