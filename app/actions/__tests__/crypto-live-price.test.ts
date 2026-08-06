/**
 * The Bitcoin / Ethereum server actions, and the metals path they now share.
 *
 * `fetch` is stubbed for every test — no network call is ever made — and each
 * test gets a throwaway database in a temp dir (BUDGET_DB_PATH + mkdtemp), so
 * data/budget.db is never opened.
 *
 * The invariants under test are the ones that lost money before:
 *   - a failed price fetch must NEVER be persisted as $0; it must return
 *     { error } and leave the stored value exactly as it was;
 *   - a quantity of 0 is a quantity;
 *   - a live-priced holding records WHICH symbol prices it, so it can be
 *     refreshed later without guessing from a category name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDb, execOn, type TempDb } from "./support/temp-db";
import { GRAMS_PER_TROY_OUNCE } from "@/lib/prices";

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
const { calculateCommodityValue } = await import("../commodities");

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
  fd.append("priceSymbol", over.priceSymbol ?? "BTC");
  if (over.quantity !== undefined) fd.append("quantity", over.quantity);
  if (over.unit !== undefined) fd.append("unit", over.unit);
  fd.append("currency", over.currency ?? "USD");
  if (over.notes !== undefined) fd.append("notes", over.notes);
  if (over.linkedTransactionIds !== undefined) {
    fd.append("linkedTransactionIds", over.linkedTransactionIds);
  }
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
  it("stores a fractional bitcoin holding with its symbol, quantity and value", async () => {
    const result = await createLivePricedAsset(
      holdingForm({ quantity: "0.0345", notes: "cold wallet" }),
    );

    expect(result).toMatchObject({ success: true });
    expect(storedAssets()).toEqual([
      {
        id: 1,
        category: "Crypto",
        current_value_cents: 408_590, // 0.0345 x 118432 = 4085.904
        currency: "USD",
        commodity_type: null, // Bitcoin is NOT a commodity
        price_symbol: "BTC",
        quantity: 0.0345,
        unit: "coins",
        use_live_price: 1,
        priced_at: expect.any(Number),
      },
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
    expect(storedAssets()).toEqual([before]); // byte-for-byte the same row
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
