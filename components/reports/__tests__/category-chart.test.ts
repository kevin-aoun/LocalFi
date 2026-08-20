import { describe, expect, it } from "vitest";

import {
  buildCategoryPie,
  categorySwatch,
  isCategoryView,
  type CategoryColors,
} from "@/components/reports/category-chart";
import { parseAmount } from "@/lib/money";
import type { CategoryBreakdownRow } from "@/lib/reports";

const cents = (value: string | number) => parseAmount(value);

function row(over: Partial<CategoryBreakdownRow> = {}): CategoryBreakdownRow {
  return {
    categoryId: 1,
    name: "Groceries",
    type: "Expense",
    totalCents: cents("100.00"),
    count: 3,
    share: 1,
    uncategorized: false,
    ...over,
  } as CategoryBreakdownRow;
}

const COLORS: CategoryColors = { 1: "#ff0000", 2: "#00ff00", 3: null, 4: "   " };

describe("categorySwatch", () => {
  it("uses the category's own colour", () => {
    expect(categorySwatch({ categoryId: 1 }, COLORS)).toBe("#ff0000");
  });

  it("falls back when the category has no colour, a blank colour, or no id", () => {
    const fallback = "hsl(var(--muted-foreground))";
    expect(categorySwatch({ categoryId: 3 }, COLORS)).toBe(fallback);
    expect(categorySwatch({ categoryId: 4 }, COLORS)).toBe(fallback);
    expect(categorySwatch({ categoryId: 99 }, COLORS)).toBe(fallback);
    expect(categorySwatch({ categoryId: null }, COLORS)).toBe(fallback);
  });

  it("is the single source of truth shared by the table and the pie", () => {

    const r = row({ categoryId: 2 });
    const pie = buildCategoryPie([r], COLORS);
    expect(pie.slices[0].color).toBe(categorySwatch(r, COLORS));
  });
});

describe("buildCategoryPie", () => {
  it("computes shares that sum to 1 and match the drawn total", () => {
    const pie = buildCategoryPie(
      [
        row({ categoryId: 1, name: "Rent", totalCents: cents("750.00") }),
        row({ categoryId: 2, name: "Food", totalCents: cents("250.00") }),
      ],
      COLORS,
    );

    expect(pie.totalCents).toBe(cents("1000.00"));
    expect(pie.slices.map((s) => s.share)).toEqual([0.75, 0.25]);
    expect(pie.slices.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 12);
    expect(pie.partial).toBe(false);
    expect(pie.excluded).toEqual([]);
  });

  it("keeps money in cents and only floats the recharts angle", () => {
    const pie = buildCategoryPie([row({ totalCents: cents("19.99") })], COLORS);
    expect(pie.slices[0].cents).toBe(1999);
    expect(pie.slices[0].value).toBe(19.99);
    expect(Number.isInteger(pie.slices[0].cents)).toBe(true);
  });

  it("preserves row order, so the pie reads clockwise as the table reads down", () => {
    const pie = buildCategoryPie(
      [
        row({ categoryId: 1, name: "A", totalCents: cents("10.00") }),
        row({ categoryId: 2, name: "B", totalCents: cents("90.00") }),
      ],
      COLORS,
    );
    expect(pie.slices.map((s) => s.name)).toEqual(["A", "B"]);
  });

  it("excludes a ZERO row rather than treating it as absent", () => {
    const pie = buildCategoryPie(
      [
        row({ categoryId: 1, name: "Rent", totalCents: cents("100.00") }),
        row({ categoryId: 2, name: "Gifts", totalCents: cents("0.00") }),
      ],
      COLORS,
    );

    expect(pie.slices).toHaveLength(1);
    expect(pie.excluded).toEqual([{ name: "Gifts", cents: 0, reason: "zero" }]);
    expect(pie.partial).toBe(true);
  });

  it("excludes a NEGATIVE row (a refund larger than the spending it reverses)", () => {
    const pie = buildCategoryPie(
      [
        row({ categoryId: 1, name: "Rent", totalCents: cents("100.00") }),
        row({ categoryId: 2, name: "Returns", totalCents: cents("-40.00") }),
      ],
      COLORS,
    );

    expect(pie.slices).toHaveLength(1);
    expect(pie.excluded).toEqual([{ name: "Returns", cents: -4000, reason: "negative" }]);
    expect(pie.partial).toBe(true);
  });

  it("re-bases shares on the DRAWN total, never on the direction total", () => {

    const pie = buildCategoryPie(
      [
        row({ categoryId: 1, name: "Rent", totalCents: cents("100.00"), share: 0.5 }),
        row({ categoryId: 2, name: "Returns", totalCents: cents("-100.00"), share: 0.5 }),
      ],
      COLORS,
    );

    expect(pie.slices).toHaveLength(1);
    expect(pie.slices[0].share).toBe(1);
    expect(pie.totalCents).toBe(cents("100.00"));
  });

  it("carries a null share through as a drawable wedge, re-based", () => {

    const pie = buildCategoryPie(
      [
        row({ categoryId: 1, totalCents: cents("30.00"), share: null }),
        row({ categoryId: 2, totalCents: cents("10.00"), share: null }),
      ],
      COLORS,
    );

    expect(pie.slices.map((s) => s.share)).toEqual([0.75, 0.25]);
    expect(pie.slices.every((s) => Number.isFinite(s.share))).toBe(true);
  });

  it("keeps an uncategorized row and flags it", () => {
    const pie = buildCategoryPie(
      [row({ categoryId: null, name: "Uncategorized", uncategorized: true })],
      COLORS,
    );
    expect(pie.slices).toHaveLength(1);
    expect(pie.slices[0].uncategorized).toBe(true);
  });

  it("returns an empty, non-throwing model for no rows", () => {
    const pie = buildCategoryPie([], COLORS);
    expect(pie.slices).toEqual([]);
    expect(pie.totalCents).toBe(0);
    expect(pie.partial).toBe(false);
  });

  it("produces no NaN when every row is undrawable", () => {
    const pie = buildCategoryPie(
      [row({ totalCents: cents("0.00") }), row({ categoryId: 2, totalCents: cents("0.00") })],
      COLORS,
    );
    expect(pie.slices).toEqual([]);
    expect(pie.totalCents).toBe(0);
    expect(pie.excluded).toHaveLength(2);
    expect(pie.partial).toBe(true);
  });

  it("never yields NaN or Infinity for any share", () => {
    const pie = buildCategoryPie(
      [
        row({ categoryId: 1, totalCents: cents("0.01") }),
        row({ categoryId: 2, totalCents: cents("99999.99") }),
        row({ categoryId: 3, totalCents: cents("0.00") }),
      ],
      COLORS,
    );
    for (const slice of pie.slices) {
      expect(Number.isFinite(slice.share)).toBe(true);
      expect(slice.share).toBeGreaterThan(0);
      expect(slice.share).toBeLessThanOrEqual(1);
    }
  });

  it("gives distinct keys to two rows sharing a name and a missing category", () => {
    const pie = buildCategoryPie(
      [
        row({ categoryId: null, name: "Uncategorized", uncategorized: true }),
        row({ categoryId: null, name: "Uncategorized", uncategorized: true }),
      ],
      COLORS,
    );
    expect(new Set(pie.slices.map((s) => s.key)).size).toBe(2);
  });

  it("does not mutate its input", () => {
    const rows = [row({ categoryId: 1 }), row({ categoryId: 2 })];
    const snapshot = JSON.stringify(rows);
    buildCategoryPie(rows, COLORS);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe("isCategoryView", () => {
  it("accepts the two views and rejects everything else", () => {
    expect(isCategoryView("bar")).toBe(true);
    expect(isCategoryView("pie")).toBe(true);
    expect(isCategoryView("donut")).toBe(false);
    expect(isCategoryView("")).toBe(false);
    expect(isCategoryView(undefined)).toBe(false);
    expect(isCategoryView(null)).toBe(false);
  });
});
