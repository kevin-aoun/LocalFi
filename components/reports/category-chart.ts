/**
 * The "By category" breakdown, prepared for either rendering — the share-bar
 * table or the pie.
 *
 * ## Why this is a separate module
 *
 * Two views of one dataset is exactly how two views end up disagreeing. The
 * colour of a category and the percentage next to it are decided HERE, once, and
 * both `CategoryBreakdown` and `CategoryPie` read them from this file. Neither
 * component resolves a colour or computes a share of its own.
 *
 * ## Why a pie needs its own denominator
 *
 * `CategoryBreakdownRow.share` is a share of that DIRECTION's total. A pie wedge
 * is a share of THE PIE. Those are the same number right up until a row cannot be
 * drawn — a zero total has no angle, and a negative one (a refund larger than the
 * spending it reverses) would render as a wedge pointing the wrong way if drawn
 * at all, or silently vanish if not.
 *
 * So the pie computes its own shares from the rows it actually draws, and reports
 * what it left out. A wedge always means "this fraction of the circle you are
 * looking at", and when that circle is not the whole direction, the caption says
 * so. The alternative — printing `row.share` beside a wedge sized by something
 * else — is a chart that lies quietly.
 */
import { centsToDecimal, sumCents, type Cents } from "@/lib/money";
import type { CategoryBreakdownRow } from "@/lib/reports";

/** Category id -> colour, as stored on the category itself. */
export type CategoryColors = Record<number, string | null | undefined>;

/**
 * The one place a breakdown row's colour is decided.
 *
 * A row with no category (its category was deleted) or a category with no colour
 * set falls back to the muted swatch. Two such rows therefore look alike — in the
 * table AND in the pie, identically. That is deliberate: inventing a distinct
 * colour for the pie would make the same row a different colour in each view,
 * which is worse than two grey wedges.
 */
export function categorySwatch(
  row: Pick<CategoryBreakdownRow, "categoryId">,
  colors: CategoryColors,
): string {
  const own = row.categoryId !== null ? colors[row.categoryId] : undefined;
  return typeof own === "string" && own.trim() !== "" ? own : "hsl(var(--muted-foreground))";
}

export type CategorySlice = {
  /** Stable across re-renders and unique even when two rows share a name. */
  key: string;
  categoryId: number | null;
  name: string;
  /** Positive magnitude, in integer cents. The number the reader is shown. */
  cents: Cents;
  /**
   * `cents` as a decimal. Recharts needs a plain number for the angle; this is
   * the ONLY float here and it is never displayed. Every figure the user reads
   * goes through `formatMoney(cents)`.
   */
  value: number;
  /** Fraction of the drawn pie, 0..1. Never null: an undrawable row is excluded. */
  share: number;
  color: string;
  count: number;
  /** Its category no longer exists, so it counts towards no total anywhere. */
  uncategorized: boolean;
};

export type ExcludedSlice = {
  name: string;
  cents: Cents;
  /** Why it has no wedge, in the words shown to the reader. */
  reason: "zero" | "negative";
};

export type CategoryPieModel = {
  slices: CategorySlice[];
  /** The sum of the drawn wedges — the pie's own whole. */
  totalCents: Cents;
  /** Rows a pie cannot represent. Disclosed, never dropped in silence. */
  excluded: ExcludedSlice[];
  /**
   * True when the drawn total is not the direction total, i.e. some row was
   * excluded. The caller must caption the chart when this is set.
   */
  partial: boolean;
};

/**
 * Turn breakdown rows into pie wedges.
 *
 * Pure, total, and order-preserving: the wedge order is the row order, so the
 * pie reads clockwise in the same order the table reads downwards.
 */
export function buildCategoryPie(
  rows: readonly CategoryBreakdownRow[],
  colors: CategoryColors,
): CategoryPieModel {
  const drawable: CategoryBreakdownRow[] = [];
  const excluded: ExcludedSlice[] = [];

  for (const row of rows) {
    // `> 0`, not truthiness: a category with exactly 0 is a real row with no
    // angle, and must be reported as excluded rather than treated as absent.
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

  // Guard the division. `drawable` non-empty implies totalCents > 0, but a
  // wrong `share` here would be an invisible error, so it is not left to
  // inference.
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

// ---------------------------------------------------------------------------
// The view toggle
// ---------------------------------------------------------------------------

export const categoryViews = ["bar", "pie"] as const;
export type CategoryView = (typeof categoryViews)[number];

export function isCategoryView(value: unknown): value is CategoryView {
  return typeof value === "string" && (categoryViews as readonly string[]).includes(value);
}
