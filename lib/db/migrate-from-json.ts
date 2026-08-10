import { getDb, saveDb } from "./client";
import { readFileSync, existsSync } from "fs";
import path from "path";
import * as schema from "./schema";
import { formatMoney, parseAmount, tryParseAmount } from "@/lib/money";

const DATA_DIR = path.resolve(process.cwd(), "data");

async function migrateFromJSON() {
  console.log("Starting JSON to SQLite migration...\n");

  const db = await getDb();

  // Read JSON files
  const categoriesPath = path.join(DATA_DIR, "categories.json");
  const transactionsPath = path.join(DATA_DIR, "transactions.json");
  const assetsPath = path.join(DATA_DIR, "assets.json");
  const settingsPath = path.join(DATA_DIR, "settings.json");

  if (!existsSync(categoriesPath)) {
    throw new Error("categories.json not found");
  }

  const categoriesJSON = JSON.parse(readFileSync(categoriesPath, "utf-8"));
  const transactionsJSON = existsSync(transactionsPath)
    ? JSON.parse(readFileSync(transactionsPath, "utf-8"))
    : [];
  const assetsJSON = existsSync(assetsPath)
    ? JSON.parse(readFileSync(assetsPath, "utf-8"))
    : [];
  const settingsJSON = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf-8"))
    : { userName: "", accentColor: "default", theme: "system", quickCommands: [] };

  console.log("Read JSON files:");
  console.log(`  Categories: ${categoriesJSON.length}`);
  console.log(`  Transactions: ${transactionsJSON.length}`);
  console.log(`  Assets: ${assetsJSON.length}`);
  console.log(`  Quick Commands: ${settingsJSON.quickCommands?.length || 0}\n`);

  // Migration ID mapping (JSON IDs to SQLite IDs)
  const categoryIdMap = new Map<number, number>();
  const transactionIdMap = new Map<number, number>();

  // 1. Migrate Categories
  console.log("Migrating categories...");
  for (const cat of categoriesJSON) {
    const result = await db.insert(schema.categories).values({
      name: cat.name,
      type: cat.type,
      monthlyLimitCents: tryParseAmount(cat.monthlyLimit),
      icon: cat.icon,
      color: cat.color,
      createdAt: new Date(cat.createdAt),
      updatedAt: new Date(cat.updatedAt),
    }).returning();

    categoryIdMap.set(cat.id, result[0].id);
    console.log(`  ✓ ${cat.name} (${cat.id} -> ${result[0].id})`);
  }

  // 2. Migrate Transactions
  console.log("\nMigrating transactions...");
  for (const tx of transactionsJSON) {
    const newCategoryId = categoryIdMap.get(tx.categoryId);
    if (!newCategoryId && tx.categoryId !== 0) {
      console.warn(`  ⚠ Skipping transaction ${tx.id}: category ${tx.categoryId} not found`);
      continue;
    }

    const result = await db.insert(schema.transactions).values({
      date: new Date(tx.date),
      categoryId: newCategoryId || tx.categoryId,
      amountCents: parseAmount(tx.amount),
      comment: tx.comment || null,
      createdAt: new Date(tx.createdAt),
      updatedAt: new Date(tx.updatedAt),
    }).returning();

    transactionIdMap.set(tx.id, result[0].id);
    console.log(`  ✓ Transaction ${tx.id} -> ${result[0].id} (${formatMoney(parseAmount(tx.amount))})`);
  }

  // 3. Migrate Assets
  console.log("\nMigrating assets...");
  for (const asset of assetsJSON) {
    // Handle linkedTransactionIds mapping
    let linkedIds = null;
    if (asset.linkedTransactionIds) {
      try {
        const oldIds = JSON.parse(asset.linkedTransactionIds);
        const newIds = oldIds.map((id: number | null) =>
          id === null ? null : transactionIdMap.get(id) || id
        );
        linkedIds = JSON.stringify(newIds);
      } catch {
        linkedIds = asset.linkedTransactionIds;
      }
    }

    await db.insert(schema.assets).values({
      category: asset.category,
      currentValueCents: parseAmount(asset.currentValue),
      currency: asset.currency || "USD",
      notes: asset.notes || null,
      commodityType: asset.commodityType || null,
      // `|| null` would turn a quantity of exactly 0 into "no quantity recorded",
      // losing the distinction between an emptied holding and one that never had
      // a quantity. 0 is a real value here.
      quantity: asset.quantity ?? null,
      unit: asset.unit || null,
      linkedTransactionIds: linkedIds,
      useLivePrice: asset.useLivePrice || false,
      createdAt: new Date(asset.createdAt),
      updatedAt: new Date(asset.updatedAt),
    });

    console.log(`  ✓ ${asset.category} asset (${formatMoney(parseAmount(asset.currentValue), asset.currency || "USD")})`);
  }

  // 4. Migrate Settings
  console.log("\nMigrating settings...");
  await db.insert(schema.settings).values({
    userName: settingsJSON.userName,
    accentColor: settingsJSON.accentColor,
    theme: settingsJSON.theme,
  });
  console.log(`  ✓ User: ${settingsJSON.userName}, Theme: ${settingsJSON.theme}`);

  // 5. Migrate Quick Commands
  if (settingsJSON.quickCommands && settingsJSON.quickCommands.length > 0) {
    console.log("\nMigrating quick commands...");
    for (const cmd of settingsJSON.quickCommands) {
      await db.insert(schema.quickCommands).values({
        command: cmd.command,
        categoryName: cmd.categoryName,
        amountCents: parseAmount(cmd.amount),
        comment: cmd.comment,
      });
      console.log(`  ✓ Quick command: ${cmd.command}`);
    }
  }

  // Save database to file
  await saveDb();

  console.log("\n✅ Migration completed successfully!");
  console.log("\nSummary:");
  console.log(`  Categories: ${categoriesJSON.length}`);
  console.log(`  Transactions: ${transactionsJSON.length}`);
  console.log(`  Assets: ${assetsJSON.length}`);
  console.log(`  Quick Commands: ${settingsJSON.quickCommands?.length || 0}`);

  // Verify Cash asset value
  const cashAsset = assetsJSON.find((a: any) => a.category === "Cash");
  if (cashAsset) {
    console.log(`\nCash Asset Value: ${formatMoney(parseAmount(cashAsset.currentValue), cashAsset.currency || "USD")}`);
  }
}

migrateFromJSON().catch(console.error);
