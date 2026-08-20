import { getDb, saveDb } from "./client";
import { categories } from "./schema";
import { parseAmount } from "@/lib/money";

const defaultCategories = [

  { name: "Salary", type: "Income" as const, icon: "Wallet", color: "#10b981", monthlyLimitCents: null },
  { name: "Allowance", type: "Income" as const, icon: "Coins", color: "#34d399", monthlyLimitCents: null },

  { name: "Rent", type: "Expense" as const, icon: "Home", color: "#ef4444", monthlyLimitCents: null },
  { name: "Groceries", type: "Expense" as const, icon: "ShoppingCart", color: "#f59e0b", monthlyLimitCents: parseAmount("100.00") },
  { name: "Dining", type: "Expense" as const, icon: "UtensilsCrossed", color: "#f97316", monthlyLimitCents: parseAmount("70.00") },
  { name: "Transport", type: "Expense" as const, icon: "Car", color: "#8b5cf6", monthlyLimitCents: parseAmount("30.00") },
  { name: "Utilities", type: "Expense" as const, icon: "Zap", color: "#06b6d4", monthlyLimitCents: parseAmount("200.00") },
  { name: "Entertainment", type: "Expense" as const, icon: "Film", color: "#ec4899", monthlyLimitCents: parseAmount("100.00") },
  { name: "Shopping", type: "Expense" as const, icon: "ShoppingBag", color: "#a855f7", monthlyLimitCents: parseAmount("300.00") },
  { name: "Healthcare", type: "Expense" as const, icon: "Heart", color: "#f43f5e", monthlyLimitCents: null },
  { name: "Personal Development", type: "Expense" as const, icon: "BookOpen", color: "#3b82f6", monthlyLimitCents: parseAmount("200.00") },
  { name: "Subscriptions", type: "Expense" as const, icon: "CreditCard", color: "#6366f1", monthlyLimitCents: parseAmount("40.00") },
  { name: "Travel", type: "Expense" as const, icon: "Plane", color: "#14b8a6", monthlyLimitCents: null },

  { name: "Savings", type: "Investment" as const, icon: "PiggyBank", color: "#22c55e", monthlyLimitCents: parseAmount("100.00") },
  { name: "Startups", type: "Investment" as const, icon: "Rocket", color: "#0ea5e9", monthlyLimitCents: parseAmount("100.00") },
];

async function seed() {
  console.log("Seeding database...");

  const db = await getDb();

  for (const category of defaultCategories) {
    await db.insert(categories).values(category).onConflictDoNothing();
  }

  await saveDb();
  console.log("Database seeded successfully!");
}

seed().catch(console.error);
