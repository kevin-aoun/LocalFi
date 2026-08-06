import { getDb, saveDb } from "./client";
import { assets, transactions, categories } from "./schema";
import { parseAmount } from "@/lib/money";

async function addSampleData() {
  console.log("Adding sample data...");
  const db = await getDb();

  // Get categories
  const allCategories = await db.select().from(categories).all();
  console.log(`Found ${allCategories.length} categories`);

  if (allCategories.length === 0) {
    console.log("No categories found. Please run npm run db:seed first.");
    return;
  }

  // Add sample assets
  // Amounts are written as dollar strings and converted once via parseAmount,
  // so the sample data cannot introduce a float into a money column.
  const sampleAssets = [
    { category: "Investments" as const, currentValueCents: parseAmount("50000.00"), currency: "USD", notes: "Stock Portfolio" },
    { category: "Crypto" as const, currentValueCents: parseAmount("8500.00"), currency: "USD", notes: "Bitcoin" },
    { category: "Properties" as const, currentValueCents: parseAmount("350000.00"), currency: "USD", notes: "Primary Residence" },
    { category: "Vehicles" as const, currentValueCents: parseAmount("22500.00"), currency: "USD", notes: "Car" },
    { category: "Commodities" as const, currentValueCents: parseAmount("3500.00"), currency: "USD", notes: "Gold Coins" },
  ];

  for (const asset of sampleAssets) {
    await db.insert(assets).values(asset);
  }
  console.log(`Added ${sampleAssets.length} sample assets`);

  // Add sample transactions
  const salaryCategory = allCategories.find(c => c.name === "Salary");
  const groceriesCategory = allCategories.find(c => c.name === "Groceries");
  const diningCategory = allCategories.find(c => c.name === "Dining");
  const transportCategory = allCategories.find(c => c.name === "Transport");
  const entertainmentCategory = allCategories.find(c => c.name === "Entertainment");

  const sampleTransactions = [
    {
      date: new Date("2026-01-28"),
      categoryId: salaryCategory?.id || 1,
      amountCents: parseAmount("5000.00"),
      comment: "Monthly salary",
    },
    {
      date: new Date("2026-01-27"),
      categoryId: groceriesCategory?.id || 2,
      amountCents: parseAmount("120.50"),
      comment: "Weekly groceries",
    },
    {
      date: new Date("2026-01-26"),
      categoryId: diningCategory?.id || 3,
      amountCents: parseAmount("45.00"),
      comment: "Dinner with friends",
    },
    {
      date: new Date("2026-01-25"),
      categoryId: transportCategory?.id || 4,
      amountCents: parseAmount("60.00"),
      comment: "Gas and parking",
    },
    {
      date: new Date("2026-01-24"),
      categoryId: entertainmentCategory?.id || 5,
      amountCents: parseAmount("25.00"),
      comment: "Movie tickets",
    },
    {
      date: new Date("2026-01-20"),
      categoryId: groceriesCategory?.id || 2,
      amountCents: parseAmount("85.30"),
      comment: "Grocery shopping",
    },
  ];

  for (const transaction of sampleTransactions) {
    await db.insert(transactions).values(transaction);
  }
  console.log(`Added ${sampleTransactions.length} sample transactions`);

  await saveDb();
  console.log("Sample data added successfully!");
}

addSampleData().catch(console.error);
