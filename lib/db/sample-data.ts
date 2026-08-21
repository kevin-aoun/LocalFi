import { asc } from "drizzle-orm";

import { fromDateKey, type DateKey } from "@/lib/dates";
import {
  createManualInstrument,
  observationDay,
  postAssetOpeningPosition,
  projectPositionHolding,
  recordInstrumentObservation,
} from "@/lib/investments";
import {
  buildTransactionMovements,
  buildTransactionProjection,
  postLedgerEventRaw,
  registerLedgerAccount,
} from "@/lib/ledger";
import { parseAmount } from "@/lib/money";
import { authorizeDatabaseVaultFromEnvironment, withDb } from "./client";
import { accounts, assets, categories, transactions } from "./schema";
import { syncCashAssetWithin } from "./sync-cash";

const sampleAssets = [
  { category: "Investments", value: "50000.00", notes: "Stock Portfolio" },
  { category: "Crypto", value: "8500.00", notes: "Bitcoin" },
  { category: "Properties", value: "350000.00", notes: "Primary Residence" },
  { category: "Vehicles", value: "22500.00", notes: "Car" },
  { category: "Commodities", value: "3500.00", notes: "Gold Coins" },
] as const;

const sampleTransactions = [
  { date: "2026-01-28", category: "Salary", amount: "5000.00", comment: "Monthly salary" },
  { date: "2026-01-27", category: "Groceries", amount: "120.50", comment: "Weekly groceries" },
  { date: "2026-01-26", category: "Dining", amount: "45.00", comment: "Dinner with friends" },
  { date: "2026-01-25", category: "Transport", amount: "60.00", comment: "Gas and parking" },
  { date: "2026-01-24", category: "Entertainment", amount: "25.00", comment: "Movie tickets" },
  { date: "2026-01-20", category: "Groceries", amount: "85.30", comment: "Grocery shopping" },
] as const;

async function addSampleData(): Promise<void> {
  const result = await withDb(async (db, raw) => {
    const categoryRows = await db.select().from(categories).orderBy(asc(categories.id));
    const [account] = await db.select().from(accounts).orderBy(asc(accounts.id)).limit(1);
    if (categoryRows.length === 0 || !account) {
      throw new Error("Run bun run db:seed before adding sample data");
    }
    const categoryByName = new Map(categoryRows.map((category) => [category.name, category]));
    const now = Math.floor(Date.now() / 1000);
    const today = observationDay(now);

    for (const sample of sampleAssets) {
      const value = parseAmount(sample.value);
      const instrument = createManualInstrument(raw, {
        label: sample.notes,
        category: sample.category,
        currency: "USD",
        createdAt: now,
      });
      recordInstrumentObservation(raw, {
        instrumentId: instrument.id,
        observationKind: "valuation",
        observedDay: today,
        observedAt: now,
        amountMinor: value,
        currency: "USD",
        source: "sample-data",
      });
      const [asset] = await db.insert(assets).values({
        category: sample.category,
        currentValueCents: value,
        currency: "USD",
        instrumentId: instrument.id,
        notes: sample.notes,
      }).returning();
      postAssetOpeningPosition(raw, {
        assetId: asset.id,
        instrumentId: instrument.id,
        currency: "USD",
        quantity: "1",
        bookAmountMinor: value,
        effectiveDate: today,
        description: `Sample opening position for ${sample.notes}`,
        recordedAt: now,
        source: "manual-holding",
      });
      projectPositionHolding(raw, instrument.id, "USD");
    }

    for (const sample of sampleTransactions) {
      const category = categoryByName.get(sample.category);
      if (!category) throw new Error(`Sample category ${sample.category} does not exist`);
      const direction = category.type === "Income" ? "inflow" as const : "outflow" as const;
      const dateKey = sample.date as DateKey;
      const date = fromDateKey(dateKey);
      const [row] = await db.insert(transactions).values({
        date,
        categoryId: category.id,
        accountId: account.id,
        amountCents: parseAmount(sample.amount),
        direction,
        currency: account.currency,
        comment: sample.comment,
        pending: false,
      }).returning();
      const accountTargetId = registerLedgerAccount(raw, {
        targetType: "real_account",
        targetRef: account.id,
        currency: account.currency,
      });
      const categoryTargetId = registerLedgerAccount(raw, {
        targetType: "category",
        targetRef: category.id,
        currency: account.currency,
      });
      const event = postLedgerEventRaw(raw, {
        effectiveDate: dateKey,
        description: sample.comment,
        metadata: {
          projectionKey: row.id,
          transaction: buildTransactionProjection(row),
          provenance: { source: "sample-data" },
        },
        movements: buildTransactionMovements({
          direction,
          amountMinor: row.amountCents,
          currency: account.currency,
          accountTargetId,
          categoryTargetId,
        }),
        recordedAt: row.updatedAt,
      });
      raw.run("UPDATE transactions SET current_event_id = ? WHERE id = ?", [event.eventId, row.id]);
    }
    await syncCashAssetWithin(db);
    return { assets: sampleAssets.length, transactions: sampleTransactions.length };
  });
  console.log(`Added ${result.assets} sample assets and ${result.transactions} journaled transactions`);
}

async function main(): Promise<void> {
  const releaseAuthorization = await authorizeDatabaseVaultFromEnvironment();
  try {
    await addSampleData();
  } finally {
    await releaseAuthorization();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
