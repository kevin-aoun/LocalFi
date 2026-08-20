import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const source = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

describe("category drag-and-drop wiring", () => {
  it("supports pointer and keyboard sorting through a dedicated handle", () => {
    const tab = source("components/budgets/budget-categories-tab.tsx");
    expect(tab).toContain("DndContext");
    expect(tab).toContain("useSortable({ id: category.id, disabled })");
    expect(tab).toContain("activationConstraint: { distance: 8 }");
    expect(tab).toContain("sortableKeyboardCoordinates");
    expect(tab).toContain("setActivatorNodeRef");
    expect(tab).toContain("Drag to reorder");
  });

  it("sorts inside one semantic group, persists once, and rolls back failures", () => {
    const tab = source("components/budgets/budget-categories-tab.tsx");
    expect(tab).toContain("orderedCategories.filter((category) => category.type === type)");
    expect(tab).toContain("arrayMove(group, oldIndex, newIndex)");
    expect(tab).toContain("reorderCategories(type, orderedGroup.map((category) => category.id))");
    expect(tab).toContain("setOrderedCategories(previous)");
    expect(tab).toContain("router.refresh()");
  });
});

describe("budget drag-and-drop wiring", () => {
  it("uses the same accessible pointer and keyboard interaction", () => {
    const page = source("app/(dashboard)/budgets/budgets-client.tsx");
    expect(page).toContain("useSortable({ id: row.budgetId, disabled })");
    expect(page).toContain("sortableKeyboardCoordinates");
    expect(page).toContain("Reorder ${row.categoryName} budget");
  });

  it("persists the complete visible order and rolls back failed saves", () => {
    const page = source("app/(dashboard)/budgets/budgets-client.tsx");
    expect(page).toContain("const movedVisibleIds = arrayMove(visibleIds, oldIndex, newIndex)");
    expect(page).toContain("visibleIdSet.has(id) ? movedVisibleIds[nextVisibleIndex++] : id");
    expect(page).toContain("await reorderBudgets(next)");
    expect(page).toContain("setOrderedBudgetIds(previous)");
  });
});

describe("global text selection policy", () => {
  it("disables chrome selection while preserving editable and copyable content", () => {
    const css = source("app/globals.css");
    expect(css).toContain("@apply select-none bg-background text-foreground");
    for (const selector of ["input,", "textarea,", "[contenteditable=\"true\"]", "code,", "pre,", "[data-selectable]"]) {
      expect(css).toContain(selector);
    }
    expect(css).toContain("user-select: text");
  });
});
