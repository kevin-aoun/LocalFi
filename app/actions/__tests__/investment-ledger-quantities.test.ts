import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getNetWorth, recordNetWorthToday } from "@/app/actions/accounts";
import { deleteAsset, getAssets, getInvestmentHistory } from "@/app/actions/assets";
import { refreshLivePricedAssets } from "@/app/actions/crypto";
import { createTransaction, deleteTransaction, getTransactions, updateTransaction } from "@/app/actions/transactions";
import { buildAssetTable } from "@/components/dashboard/asset-table";
import { buildInvestmentHistory } from "@/components/reports/investment-history";
import { readDb, withDb } from "@/lib/db/client";
import { discoverInstrument, ensureInstrument, postAssetOpeningPosition, projectPositionHolding, recordInstrumentObservation } from "@/lib/investments";
import { readPositionHistory, verifyLedger } from "@/lib/ledger";
import { createDomainDb, form, seedAccount, seedCategory, type DomainDb } from "./support/domain-fixture";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let temp: DomainDb;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 20, 12));
  temp = await createDomainDb();
  seedCategory(temp, { id: 12, name: "Crypto", type: "Investment" });
  seedAccount(temp, { id: 9, name: "Fixture wallet", kind: "asset", type: "Checking", openingBalanceCents: 200_000, openingBalanceDate: "2026-01-01" });
});
afterEach(async () => {
  await temp.cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const purchase = (symbol: string, quantity: string, extra = {}) => form({
  accountId: "9", categoryId: "12", date: "2026-06-01", instrumentSymbol: symbol,
  instrumentUnit: symbol === "XAU" ? "oz" : "coins", quantity, unitPrice: "120", fees: "1.25", pending: "false", ...extra,
});

async function opening(symbol: string, separateInstrument: boolean) {
  return withDb((_db, raw) => {
    const spec = discoverInstrument(symbol);
    const instrument = ensureInstrument(raw, separateInstrument
      ? { ...spec, id: `instrument:legacy-asset:fixture-${symbol}` }
      : spec);
    raw.run("INSERT INTO assets (category, current_value_cents, currency, instrument_id) VALUES (?, 45000, 'USD', ?)", [instrument.category, instrument.id]);
    const assetId = Number(raw.exec("SELECT last_insert_rowid()")[0].values[0][0]);
    postAssetOpeningPosition(raw, {
      assetId, instrumentId: instrument.id, currency: "USD", quantity: "3.75", bookAmountMinor: 45000,
      effectiveDate: "2026-05-01", description: "Synthetic opening snapshot", source: "manual-live-holding",
    });
    recordInstrumentObservation(raw, {
      instrumentId: instrument.id, observationKind: "price", observedDay: "2026-05-01",
      observedAt: 1, currency: "USD", amountMinor: 12000, source: "fixture",
    });
    projectPositionHolding(raw, instrument.id, "USD");
    return instrument.id;
  });
}

describe("investment inventory comes from transaction movements", () => {
  it.each([
    ["BTC", true], ["ETH", true], ["BTC", false], ["ETH", false],
  ] as const)("excludes %s opening snapshots (separate instrument: %s) from every portfolio total", async (symbol, separate) => {
    const openingId = await opening(symbol, separate);
    const openingJournal = temp.query("SELECT * FROM ledger_events WHERE sequence = 2");
    const holdings = () => getAssets().then((rows) => rows.filter((row) => row.priceSymbol === symbol));
    {
      expect(await holdings()).toEqual([]);
      expect(await getInvestmentHistory()).toEqual([]);
    }

    const first = await createTransaction(purchase(symbol, "1.125"));
    const second = await createTransaction(purchase(symbol, "2.625", { date: "2026-06-02" }));
    if ("error" in first) throw new Error(first.error);
    if ("error" in second) throw new Error(second.error);
    expect(await holdings()).toMatchObject([{
      priceSymbol: symbol, quantity: 3.75, quantityExact: "3.75", currentValueCents: 45000,
      costBasisCents: 45250, profitLossCents: -250,
    }]);
    {
      expect(buildAssetTable({ assets: await getAssets(), accounts: [] }).categories
        .find((row) => row.name === "Crypto")?.holdings).toMatchObject([
        { name: symbol, detail: "3.75 coins", amountLabel: "$450.00" },
      ]);
    }
    expect(await getInvestmentHistory()).toMatchObject([
      { dateKey: "2026-06-01", valueCents: 13500, costBasisCents: 13625 },
      { dateKey: "2026-06-02", valueCents: 45000, costBasisCents: 45250 },
    ]);
    expect(await getNetWorth()).toMatchObject({ aggregate: { netWorthCents: 199750 } });
    expect(buildInvestmentHistory(await getInvestmentHistory()).series.map((row) => row.label))
      .toEqual([symbol]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ bitcoin: { usd: 160 }, ethereum: { usd: 160 }, "pax-gold": { usd: 160 } }) }));
    await refreshLivePricedAssets();
    await refreshLivePricedAssets();
    expect(await holdings()).toMatchObject([{
      quantityExact: "3.75", currentValueCents: 60000, costBasisCents: 45250,
    }]);
    expect((await getInvestmentHistory()).at(-1)).toMatchObject({ valueCents: 60000, costBasisCents: 45250 });
    expect(await getNetWorth()).toMatchObject({ aggregate: { netWorthCents: 214750 } });
    expect(await recordNetWorthToday()).toMatchObject({ success: true, data: { netWorthCents: 214750 } });
    expect(temp.query("SELECT value_cents FROM asset_history")).toEqual([{ value_cents: 60000 }]);
    expect(await getTransactions()).toHaveLength(2);

    expect(await updateTransaction(first.data.id, purchase(symbol, "0.875"))).toMatchObject({ success: true });
    expect(await holdings()).toMatchObject([{ quantityExact: "3.5" }]);
    expect(await deleteTransaction(second.data.id)).toMatchObject({ success: true });
    expect(await holdings()).toMatchObject([{ quantityExact: "0.875" }]);
    expect(await deleteTransaction(first.data.id)).toMatchObject({ success: true });
    expect(await holdings()).toEqual([]);
    expect(await getInvestmentHistory()).toEqual([]);
    expect(await getNetWorth()).toMatchObject({ aggregate: { netWorthCents: 200000 } });
    expect(temp.query("SELECT * FROM ledger_events WHERE sequence = 2")).toEqual(openingJournal);
    expect(temp.query(`SELECT quantity FROM instrument_positions WHERE instrument_id = '${openingId}'`)).toEqual([{ quantity: "3.75" }]);
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it.each([true, false])("keeps legitimate gold openings additive (separate instrument: %s)", async (separate) => {
    await opening("XAU", separate);
    const result = await createTransaction(purchase("XAU", "1.25"));
    if ("error" in result) throw new Error(result.error);
    const holdings = (await getAssets()).filter((row) => row.priceSymbol === "XAU");
    expect(holdings.reduce((total, row) => total + Number(row.quantityExact), 0)).toBe(5);
    expect(holdings.reduce((total, row) => total + row.currentValueCents, 0)).toBe(60000);
    expect(await getNetWorth()).toMatchObject({ aggregate: { netWorthCents: 244875 } });
    await deleteTransaction(result.data.id);
    expect((await getAssets()).filter((row) => row.priceSymbol === "XAU")).toMatchObject([{ quantityExact: "3.75", currentValueCents: 45000 }]);
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("refuses to delete an opening holding with purchases still attached", async () => {
    await opening("XAU", false);
    await createTransaction(purchase("XAU", "1.25"));
    const [holding] = (await getAssets()).filter((row) => row.priceSymbol === "XAU");
    expect(await deleteAsset(holding.id, { confirmed: true })).toHaveProperty("error");
    expect((await getAssets()).find((row) => row.id === holding.id)?.quantityExact).toBe("5");
    expect((await verifyLedger()).failures).toEqual([]);
  });

  it("uses today's quantity and observation cutoff consistently with net worth", async () => {
    await createTransaction(purchase("BTC", "1", { fees: "0" }));
    await createTransaction(purchase("ETH", "2", { date: "2098-01-01", fees: "0" }));
    await withDb((_db, raw) => recordInstrumentObservation(raw, {
      instrumentId: discoverInstrument("BTC").id, observationKind: "price", observedDay: "2098-01-01",
      observedAt: 4102444800, currency: "USD", amountMinor: 99900, source: "fixture",
    }));
    expect((await getAssets()).filter((row) => row.category === "Crypto")).toMatchObject([
      { priceSymbol: "BTC", quantityExact: "1", currentValueCents: 12000, costBasisCents: 12000 },
    ]);
    expect(await getNetWorth()).toMatchObject({ aggregate: { netWorthCents: 200000 } });
  });

  it("loads the journal once for investment history across observation days", async () => {
    await createTransaction(purchase("BTC", "1"));
    await createTransaction(purchase("BTC", "1", { date: "2026-07-01" }));
    let journalReads = 0;
    await readDb((_db, raw) => {
      const prepare = raw.prepare.bind(raw);
      const spy = vi.spyOn(raw, "prepare").mockImplementation((sql, ...args) => {
        if (sql.includes("FROM ledger_events ORDER BY sequence")) journalReads += 1;
        return prepare(sql, ...args);
      });
      try { expect(readPositionHistory(raw)).toHaveLength(2); }
      finally { spy.mockRestore(); }
    });
    expect(journalReads).toBe(1);
  });

  it("ignores pending purchases until confirmation", async () => {
    const pending = await createTransaction(purchase("BTC", "0.125", { pending: "true" }));
    if ("error" in pending) throw new Error(pending.error);
    expect((await getAssets()).filter((row) => row.category === "Crypto")).toEqual([]);
    expect(await updateTransaction(pending.data.id, form({ pending: "false" }))).toMatchObject({ success: true });
    expect((await getAssets()).filter((row) => row.category === "Crypto")).toMatchObject([{ quantityExact: "0.125", currentValueCents: 1500 }]);
  });
});
