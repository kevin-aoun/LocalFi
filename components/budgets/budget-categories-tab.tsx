import { Plus, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CategoryCard, type BudgetCategory } from "./budget-cards";
import type { BudgetRowView } from "./budget-view-logic";
import type { Cents } from "@/lib/money";

export function BudgetCategoriesTab({ categories, budgets, rows, spending, monthLabel, onAdd, onEdit, onBudget, onDelete }: { categories: BudgetCategory[]; budgets: { categoryId: number; id: number }[]; rows: BudgetRowView[]; spending: Record<number, Cents>; monthLabel: string; onAdd: () => void; onEdit: (category: BudgetCategory) => void; onBudget: (id: number) => void; onDelete: (id: number) => void }) {
  const groups = { Income: categories.filter((c) => c.type === "Income"), Expense: categories.filter((c) => c.type === "Expense"), Investment: categories.filter((c) => c.type === "Investment") };
  return categories.length === 0 ? <Card><CardContent className="flex flex-col items-center justify-center py-16"><Wallet className="h-12 w-12 text-muted-foreground mb-4" /><h3 className="text-lg font-semibold mb-2">No categories yet</h3><p className="text-sm text-muted-foreground mb-4 text-center max-w-sm">Create your first category to start tracking your spending and income</p><Button onClick={onAdd}><Plus className="mr-2 h-4 w-4" />Add Your First Category</Button></CardContent></Card> : <>{Object.entries(groups).map(([type, cats]) => cats.length > 0 && <div key={type} className="space-y-4"><div className="flex items-center justify-between"><h2 className="text-xl font-semibold">{type}</h2><Badge variant={type === "Income" ? "default" : type === "Expense" ? "destructive" : "secondary"}>{cats.length} {cats.length === 1 ? "category" : "categories"}</Badge></div><div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{cats.map((category) => <CategoryCard key={category.id} category={category} spendingCents={spending[category.id] ?? 0} monthLabel={monthLabel} budgetCount={new Set([...budgets.filter((b) => b.categoryId === category.id).map((b) => b.id), ...rows.filter((r) => r.categoryId === category.id).map((r) => r.budgetId)]).size} onEdit={() => onEdit(category)} onAddBudget={() => onBudget(category.id)} canBudget={category.type !== "Income"} onDelete={() => onDelete(category.id)} />)}</div></div>)}</>;
}
