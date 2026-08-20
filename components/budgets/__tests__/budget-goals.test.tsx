import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BudgetCard } from "../budget-cards";
import type { BudgetRowView } from "../budget-view-logic";
import { TooltipProvider } from "@/components/ui/tooltip";

function row(overrides: Partial<BudgetRowView> = {}): BudgetRowView {
  return {
    categoryId: 1,
    budgetId: 7,
    period: "monthly",
    periodKey: "2026-08",
    startKey: "2026-08-01",
    endKey: "2026-08-31",
    limitCents: 20_000,
    carriedInCents: 15_000,
    availableCents: 35_000,
    spentCents: 5_000,
    remainingCents: 30_000,
    carriedOutCents: 30_000,
    rollover: true,
    goalName: "Japan trip",
    goalAmountCents: 120_000,
    overBudget: false,
    categoryName: "Travel",
    categoryType: "Expense",
    categoryColor: "#10b981",
    categoryIcon: "Wallet",
    displayOrder: 0,
    legacy: false,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    ...overrides,
  };
}

function renderCard(value: BudgetRowView): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <BudgetCard row={value} onEdit={vi.fn()} onDelete={vi.fn()} />
    </TooltipProvider>,
  );
}

describe("budget savings-goal card", () => {
  it("renders allocation, accumulated availability, progress, and amount needed", () => {
    const markup = renderCard(row());
    expect(markup).toContain("Japan trip");
    expect(markup).toContain("Target $1,200.00");
    expect(markup).toContain("Monthly allocation");
    expect(markup).toContain("$200.00");
    expect(markup).toContain("Accumulated available");
    expect(markup).toContain("$300.00");
    expect(markup).toContain("25% saved");
    expect(markup).toContain("$900.00 still needed");
    expect(markup).toContain('aria-label="Japan trip goal progress"');
  });

  it("never renders negative progress after spending reduces rollover", () => {
    const markup = renderCard(
      row({ availableCents: 20_000, spentCents: 25_000, remainingCents: -5_000, carriedOutCents: 0 }),
    );
    expect(markup).toContain("0% saved");
    expect(markup).toContain("$1,200.00 still needed");
  });

  it("does not render a goal surface when metadata is absent", () => {
    const markup = renderCard(row({ goalName: null, goalAmountCents: null }));
    expect(markup).not.toContain("savings goal");
    expect(markup).not.toContain("Monthly allocation");
  });
});

describe("budget DateKey controls", () => {
  const dialogSource = readFileSync(
    path.resolve(process.cwd(), "components/budgets/budget-rule-dialog.tsx"),
    "utf8",
  );

  it("uses the shared DatePicker and has no native date/month input", () => {
    expect(dialogSource).toContain('from "@/components/ui/date-picker"');
    expect(dialogSource.match(/<DatePicker/g)).toHaveLength(2);
    expect(dialogSource).not.toMatch(/type\s*=\s*["'](?:date|month)["']/);
    expect(dialogSource).not.toContain("toISOString");
  });
});
