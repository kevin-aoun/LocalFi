
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDb, execOn, type TempDb } from "./support/temp-db";
import { GRAMS_PER_TROY_OUNCE } from "@/lib/prices";
import { postAssetOpeningPosition } from "@/lib/investments";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const COINGECKO_OK = {
  "pax-gold": { usd: 3315.58 },
  "kinesis-silver": { usd: 47.25 },
  bitcoin: { usd: 118_432 },
  ethereum: { usd: 3781.22 },
};

const {
  createLivePricedAsset,
  getLivePriceQuote,
  updateLivePricedAsset,
} = await import("../crypto");
const { recordNetWorthToday } = await import("../accounts");
const { calculateCommodityValue } = await import("../commodities");
const { getAssets } = await import("../assets");

let temp: TempDb;
let fetchMock: ReturnType<typeof vi.fn>;

function serve(overrides: { coingecko?: unknown; status?: number } = {}) {
  fetchMock.mockImplementation(async () => {
    const payload = overrides.coingecko ?? COINGECKO_OK;
    const status = overrides.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Service Unavailable",
      json: async () => payload,
    } as unknown as Response;
  });
}

beforeEach(async () => {
  temp = await createTempDb();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  serve();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await temp.cleanup();
});

const storedAssets = () =>
  temp.query(
    "SELECT id, category, current_value_cents, currency, commodity_type, price_symbol, quantity, unit, use_live_price, priced_at FROM assets ORDER BY id",
  );

function holdingForm(over: Record<string, string> = {}) {
  const fd = new FormData();
  const symbol = over.priceSymbol ?? "BTC";
  fd.append("priceSymbol", symbol);
  if (over.quantity !== undefined) fd.append("quantity", over.quantity);
  if (over.unit !== undefined) fd.append("unit", over.unit);
  fd.append("currency", over.currency ?? "USD");
  if ((symbol === "BTC" || symbol === "ETH") && over.paidAmount !== "") {
    fd.append("paidAmount", over.paidAmount ?? "100.00");
  }
  if (over.notes !== undefined) fd.append("notes", over.notes);
  return fd;
}

describe("getLivePriceQuote", () => {
  it("quotes proxied gold and bitcoin through the shared CoinGecko request", async () => {
    expect(await getLivePriceQuote("XAU")).toMatchObject({
      ok: true,
      quote: { provider: "coingecko", pricePerUnitUsd: 3315.58, priceUnit: "oz" },
    });
    expect(await getLivePriceQuote("BTC")).toMatchObject({
      ok: true,
      quote: { provider: "coingecko", pricePerUnitUsd: 118_432 },
    });
  });
});

describe("the legacy metals value wrapper", () => {
  it("calculateCommodityValue still returns integer cents, and null on failure", async () => {
    expect(await calculateCommodityValue("Gold", 1.1376, "oz")).toBe(377_180);
    expect(await calculateCommodityValue("Gold", 31.1035, "grams")).toBe(
      await calculateCommodityValue("Gold", 31.1035 / GRAMS_PER_TROY_OUNCE, "oz"),
    );

    serve({ status: 503 });
    expect(await calculateCommodityValue("Gold", 1.1376, "oz")).toBeNull();
  });
});

describe("createLivePricedAsset", () => {
  it("forces USD even when a caller tries to relabel the provider quote", async () => {
    const result = await createLivePricedAsset(
      holdingForm({ quantity: "1", currency: "EUR" }),
    );
    expect(result).toMatchObject({ success: true, data: { currency: "USD" } });
    expect(storedAssets()[0].currency).toBe("USD");
  });

  it("stores a fractional bitcoin holding with its symbol, quantity and value", async () => {
    const result = await createLivePricedAsset(
      holdingForm({ quantity: "0.0345", notes: "cold wallet" }),
    );

    expect(result).toMatchObject({ success: true });
    expect(storedAssets()).toEqual([
      {
        id: 1,
        category: "Crypto",
        current_value_cents: 408_590,
        currency: "USD",
        commodity_type: null,
        price_symbol: "BTC",
        quantity: 0.0345,
        unit: "coins",
        use_live_price: 1,
        priced_at: expect.any(Number),
      },
    ]);
    expect(temp.query("SELECT book_amount_minor FROM instrument_positions")).toEqual([
      { book_amount_minor: 10_000 },
    ]);
  });

  it("requires a crypto cost basis and preserves it while the live value changes", async () => {
    expect(await createLivePricedAsset(holdingForm({ quantity: "1", paidAmount: "" }))).toEqual({
      error: "Enter what you paid for this coin.",
    });
    await createLivePricedAsset(holdingForm({ quantity: "1", paidAmount: "90000" }));
    serve({ coingecko: { bitcoin: { usd: 100_000 } } });
    await updateLivePricedAsset(1, holdingForm({ quantity: "1", paidAmount: "90000" }));
    expect(temp.query("SELECT book_amount_minor FROM instrument_positions")).toEqual([
      { book_amount_minor: 9_000_000 },
    ]);
    expect(storedAssets()[0]).toMatchObject({ current_value_cents: 10_000_000 });
    expect(await getAssets()).toMatchObject([
      { category: "Crypto", costBasisCents: 9_000_000, profitLossCents: 1_000_000 },
    ]);
  });

  it("files a metal under Commodities and keeps commodity_type working", async () => {
    expect(
      await createLivePricedAsset(holdingForm({ priceSymbol: "XAU", quantity: "1.1376", unit: "oz" })),
    ).toMatchObject({ success: true });

    expect(storedAssets()[0]).toMatchObject({
      category: "Commodities",
      commodity_type: "Gold",
      price_symbol: "XAU",
      current_value_cents: 377_180,
      unit: "oz",
    });
  });

  it("stores nothing at all when the price fetch fails", async () => {
    serve({ status: 503 });
    const result = await createLivePricedAsset(holdingForm({ quantity: "0.0345" }));

    expect(result).toMatchObject({ error: expect.stringContaining("Bitcoin") });
    expect(result).toMatchObject({ error: expect.stringContaining("nothing was saved") });
    expect(storedAssets()).toEqual([]);
  });

  it("stores nothing when the machine is offline", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await createLivePricedAsset(holdingForm({ quantity: "1" }));
    expect(result).toMatchObject({ error: expect.stringMatching(/offline|unreachable/i) });
    expect(storedAssets()).toEqual([]);
  });

  it("accepts a quantity of exactly 0 and stores $0.00 deliberately", async () => {
    const result = await createLivePricedAsset(holdingForm({ quantity: "0" }));
    expect(result).toMatchObject({ success: true });
    expect(storedAssets()[0]).toMatchObject({
      price_symbol: "BTC",
      quantity: 0,
      current_value_cents: 0,
    });
  });

  it("refuses an absent or unparseable quantity before touching the network", async () => {
    expect(await createLivePricedAsset(holdingForm({}))).toEqual({
      error: "Enter a quantity before enabling live pricing.",
    });
    expect(await createLivePricedAsset(holdingForm({ quantity: "  " }))).toMatchObject({
      error: "Enter a quantity before enabling live pricing.",
    });
    expect(await createLivePricedAsset(holdingForm({ quantity: "one bitcoin" }))).toMatchObject({
      error: expect.stringContaining("not a valid quantity"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedAssets()).toEqual([]);
  });

  it("refuses an unknown symbol", async () => {
    expect(await createLivePricedAsset(holdingForm({ priceSymbol: "DOGE", quantity: "1" })))
      .toMatchObject({ error: expect.stringContaining("live price") });
    expect(storedAssets()).toEqual([]);
  });
});

describe("updateLivePricedAsset", () => {
  it("re-prices an existing holding", async () => {
    await createLivePricedAsset(holdingForm({ quantity: "0.0345" }));
    const [before] = storedAssets();

    serve({ coingecko: { bitcoin: { usd: 100_000 }, ethereum: { usd: 3000 } } });
    const result = await updateLivePricedAsset(Number(before.id), holdingForm({ quantity: "0.05" }));

    expect(result).toMatchObject({ success: true });
    expect(storedAssets()[0]).toMatchObject({ quantity: 0.05, current_value_cents: 500_000 });
  });

  it("leaves the stored value untouched when the refresh fails", async () => {
    await createLivePricedAsset(holdingForm({ quantity: "0.0345" }));
    const [before] = storedAssets();
    expect(before.current_value_cents).toBe(408_590);

    serve({ status: 503 });
    const result = await updateLivePricedAsset(Number(before.id), holdingForm({ quantity: "0.0345" }));

    expect(result).toMatchObject({ error: expect.stringContaining("nothing was saved") });
    expect(storedAssets()).toEqual([before]);
  });

  it("refuses to touch a missing asset or the derived Cash row", async () => {
    expect(await updateLivePricedAsset(999, holdingForm({ quantity: "1" }))).toMatchObject({
      error: expect.stringContaining("no longer exists"),
    });

    execOn(temp, (db) => {
      db.run(
        "INSERT INTO assets (id, category, current_value_cents, currency) VALUES (1, 'Cash', 449618, 'USD')",
      );
    });
    expect(await updateLivePricedAsset(1, holdingForm({ quantity: "1" }))).toMatchObject({
      error: expect.stringContaining("calculated from your transactions"),
    });
    expect(storedAssets()[0]).toMatchObject({ current_value_cents: 449_618, price_symbol: null });
  });
});

describe("recordNetWorthToday", () => {
  it("refreshes two independently imported BTC positions in one batched request", async () => {
    execOn(temp, (raw) => {
      for (const [assetId, quantity, value] of [
        [41, "0.01", 118_432],
        [42, "0.02", 236_864],
      ] as const) {
        const instrumentId = `instrument:legacy-asset:${assetId}`;
        raw.run(
          `INSERT INTO instruments
            (id, kind, label, symbol, unit, category, price_source, price_currency, created_at)
           VALUES (?, 'security', 'Bitcoin', 'BTC', 'coins', 'Crypto',
                   'legacy-live-price', 'USD', 1767398400)`,
          [instrumentId],
        );
        raw.run(
          `INSERT INTO assets
            (id, category, current_value_cents, currency, instrument_id, notes, quantity,
             unit, price_symbol, use_live_price, created_at, updated_at)
           VALUES (?, 'Crypto', ?, 'USD', ?, ?, ?, 'coins', 'BTC', 1,
                   1767398400, 1767398400)`,
          [assetId, value, instrumentId, `Imported wallet ${assetId}`, Number(quantity)],
        );
        postAssetOpeningPosition(raw, {
          assetId,
          instrumentId,
          currency: "USD",
          quantity,
          bookAmountMinor: value,
          effectiveDate: "2026-01-03",
          recordedAt: 1767398400 + assetId,
          description: "Imported BTC opening",
          source: "manual-live-holding",
        });
      }
    });
    const journalBefore = JSON.stringify({
      events: temp.query("SELECT * FROM ledger_events ORDER BY sequence"),
      movements: temp.query("SELECT * FROM ledger_movements ORDER BY event_id, position"),
    });
    fetchMock.mockClear();
    serve({ coingecko: { bitcoin: { usd: 100_000 } } });

    expect(await recordNetWorthToday()).toMatchObject({
      success: true,
      data: { prices: { refreshed: 2, failed: [] } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(temp.query(
      "SELECT id, current_value_cents, quantity, instrument_id FROM assets ORDER BY id",
    )).toEqual([
      { id: 41, current_value_cents: 100_000, quantity: 0.01,
        instrument_id: "instrument:legacy-asset:41" },
      { id: 42, current_value_cents: 200_000, quantity: 0.02,
        instrument_id: "instrument:legacy-asset:42" },
    ]);
    expect(temp.query(
      `SELECT instrument_id, amount_minor FROM instrument_observations
        WHERE observation_kind = 'price' ORDER BY instrument_id`,
    )).toEqual([
      { instrument_id: "instrument:legacy-asset:41", amount_minor: 10_000_000 },
      { instrument_id: "instrument:legacy-asset:42", amount_minor: 10_000_000 },
    ]);
    expect(JSON.stringify({
      events: temp.query("SELECT * FROM ledger_events ORDER BY sequence"),
      movements: temp.query("SELECT * FROM ledger_movements ORDER BY event_id, position"),
    })).toBe(journalBefore);
  });

  it("refreshes every live-priced commodity and crypto holding in one request", async () => {
    await createLivePricedAsset(
      holdingForm({ priceSymbol: "XAU", quantity: "1", unit: "oz", notes: "Gold" }),
    );
    await createLivePricedAsset(
      holdingForm({ priceSymbol: "XAG", quantity: "10", unit: "oz", notes: "Silver" }),
    );
    await createLivePricedAsset(
      holdingForm({ priceSymbol: "BTC", quantity: "0.5", notes: "Bitcoin" }),
    );
    await createLivePricedAsset(
      holdingForm({ priceSymbol: "ETH", quantity: "2", notes: "Ethereum" }),
    );

    fetchMock.mockClear();
    serve({
      coingecko: {
        "pax-gold": { usd: 2000 },
        "kinesis-silver": { usd: 20 },
        bitcoin: { usd: 100_000 },
        ethereum: { usd: 3000 },
      },
    });

    const result = await recordNetWorthToday();
    expect(result).toMatchObject({
      success: true,
      data: {
        netWorthCents: 5_820_000,
        prices: { ok: true, refreshed: 4, skipped: 0, failed: [], unpriceable: [] },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storedAssets().map((asset) => asset.current_value_cents)).toEqual([
      200_000,
      20_000,
      5_000_000,
      600_000,
    ]);
    expect(
      temp.query("SELECT asset_id, value_cents FROM asset_history ORDER BY asset_id"),
    ).toEqual([
      { asset_id: 1, value_cents: 200_000 },
      { asset_id: 2, value_cents: 20_000 },
      { asset_id: 3, value_cents: 5_000_000 },
      { asset_id: 4, value_cents: 600_000 },
    ]);
  });

  it("keeps only the sixth and latest recording when run six times in one day", async () => {
    await createLivePricedAsset(
      holdingForm({ priceSymbol: "BTC", quantity: "1", notes: "Bitcoin" }),
    );
    fetchMock.mockClear();
    const openingEvents = temp.query("SELECT COUNT(*) AS count FROM ledger_events");
    const openingJournal = JSON.stringify({
      events: temp.query("SELECT * FROM ledger_events ORDER BY sequence"),
      movements: temp.query("SELECT * FROM ledger_movements ORDER BY event_id, position"),
    });
    const openingPosition = temp.query(
      "SELECT quantity, book_amount_minor, current_event_id FROM instrument_positions",
    );

    for (let run = 1; run <= 6; run += 1) {
      serve({ coingecko: { bitcoin: { usd: 100_000 + run } } });
      expect(await recordNetWorthToday()).toMatchObject({ success: true });
    }

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(temp.query("SELECT COUNT(*) AS count FROM ledger_events")).toEqual(openingEvents);
    expect(JSON.stringify({
      events: temp.query("SELECT * FROM ledger_events ORDER BY sequence"),
      movements: temp.query("SELECT * FROM ledger_movements ORDER BY event_id, position"),
    })).toBe(openingJournal);
    expect(temp.query(
      "SELECT quantity, book_amount_minor, current_event_id FROM instrument_positions",
    )).toEqual(openingPosition);
    expect(temp.query("SELECT COUNT(*) AS count FROM net_worth_snapshots")).toEqual([
      { count: 1 },
    ]);
    expect(temp.query("SELECT net_worth_cents FROM net_worth_snapshots")).toEqual([
      { net_worth_cents: 10_000_600 },
    ]);
    expect(temp.query("SELECT asset_id, value_cents FROM asset_history")).toEqual([
      { asset_id: 1, value_cents: 10_000_600 },
    ]);
    expect(temp.query(
      `SELECT observation_kind, amount_minor, currency
         FROM instrument_observations`,
    )).toEqual([
      { observation_kind: "price", amount_minor: 10_000_600, currency: "USD" },
    ]);
  });

  it("records the last stored value when the live quote is unavailable", async () => {
    await createLivePricedAsset(
      holdingForm({ priceSymbol: "BTC", quantity: "1", notes: "Bitcoin" }),
    );
    fetchMock.mockClear();
    serve({ status: 503 });

    const result = await recordNetWorthToday();

    expect(result).toMatchObject({
      success: true,
      data: {
        netWorthCents: 11_843_200,
        prices: {
          ok: true,
          refreshed: 0,
          failed: [{ id: 1, label: "Bitcoin", error: expect.any(String) }],
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storedAssets()[0]).toMatchObject({ current_value_cents: 11_843_200 });
    expect(temp.query("SELECT asset_id, value_cents FROM asset_history")).toEqual([
      { asset_id: 1, value_cents: 11_843_200 },
    ]);
  });
});
