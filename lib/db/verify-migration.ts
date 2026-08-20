import { getDb } from "./client";
import { categories, transactions, assets, settings, quickCommands } from "./schema";
import { deriveCashBalanceCents } from "@/lib/cash-balance";
import { formatMoney } from "@/lib/money";

async function verify() {
  console.log("Verifying database migration...\n");

  const db = await getDb();

  const cats = await db.select().from(categories);
  const txs = await db.select().from(transactions);
  const assts = await db.select().from(assets);
  const stngs = await db.select().from(settings);
  const cmds = await db.select().from(quickCommands);

  console.log("Database Contents:");
  console.log(`  Categories: ${cats.length}`);
  console.log(`  Transactions: ${txs.length}`);
  console.log(`  Assets: ${assts.length}`);
  console.log(`  Settings: ${stngs.length}`);
  console.log(`  Quick Commands: ${cmds.length}\n`);


  const incomeCategories = cats.filter(c => c.type === "Income");
  const expenseCategories = cats.filter(c => c.type === "Expense");
  const investmentCategories = cats.filter(c => c.type === "Investment");

  console.log("Categories by Type:");
  console.log(`  Income: ${incomeCategories.length} (${incomeCategories.map(c => c.name).join(", ")})`);
  console.log(`  Expense: ${expenseCategories.length}`);
  console.log(`  Investment: ${investmentCategories.length}\n`);


  const cashAsset = assts.find(a => a.category === "Cash");
  console.log(
    `Cash Asset: ${cashAsset ? formatMoney(cashAsset.currentValueCents, cashAsset.currency) : "N/A"}`,
  );


  const commodityAsset = assts.find(a => a.category === "Commodities");
  if (commodityAsset) {
    console.log(`Commodity Asset: ${commodityAsset.quantity}${commodityAsset.unit} ${commodityAsset.commodityType} = ${formatMoney(commodityAsset.currentValueCents, commodityAsset.currency)}`);
    console.log(`  Live Price: ${commodityAsset.useLivePrice ? "Enabled" : "Disabled"}\n`);
  }


  if (stngs.length > 0) {
    console.log("Settings:");
    console.log(`  User Name: ${stngs[0].userName}`);
    console.log(`  Accent Color: ${stngs[0].accentColor}`);
    console.log(`  Theme: ${stngs[0].theme}\n`);
  }


  if (cmds.length > 0) {
    console.log("Quick Commands:");
    cmds.forEach(cmd => {
      console.log(`  /${cmd.command} → ${cmd.categoryName} (${formatMoney(cmd.amountCents)}) - ${cmd.comment}`);
    });
    console.log();
  }








  const calculatedCashCents = deriveCashBalanceCents(
    txs.map(tx => ({ categoryId: tx.categoryId, amountCents: tx.amountCents, pending: false })),
    cats,
  );

  console.log("Verification:");
  console.log(`  Calculated Cash: ${formatMoney(calculatedCashCents)}`);
  console.log(`  Stored Cash: ${cashAsset ? formatMoney(cashAsset.currentValueCents, cashAsset.currency) : "N/A"}`);
  console.log(`  Match: ${calculatedCashCents === (cashAsset?.currentValueCents ?? 0) ? "✓ YES" : "✗ NO"}\n`);

  console.log("✅ Verification complete!");
}

verify().catch(console.error);
