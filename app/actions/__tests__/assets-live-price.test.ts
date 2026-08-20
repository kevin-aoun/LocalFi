
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDb, type TempDb } from "./support/temp-db";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const priceCents = vi.fn<(type: string, quantity: number, unit: string) => Promise<number | null>>();

vi.mock("../commodities", () => ({
  calculateCommodityValue: (type: string, quantity: number, unit: string) =>
    priceCents(type, quantity, unit),
}));

const {
  createAsset,
  deleteAsset,
  getAssets,
  setAssetArchived,
  updateAsset,
} = await import("../assets");
const { snapshotNetWorth } = await import("../accounts");

let temp: TempDb;

beforeEach(async () => {
  temp = await createTempDb();
  priceCents.mockReset();
});

afterEach(async () => {
  await temp.cleanup();
});

function assetForm(over: Record<string, string> = {}) {
  const fd = new FormData();
  fd.append("category", over.category ?? "Commodities");
  fd.append("currentValue", over.currentValue ?? "");
  fd.append("currency", over.currency ?? "USD");
  if (over.commodityType !== undefined || over.category !== "Savings") {
    fd.append("commodityType", over.commodityType ?? "Gold");
  }
  if (over.quantity !== undefined) fd.append("quantity", over.quantity);
  fd.append("unit", over.unit ?? "oz");
  fd.append("useLivePrice", over.useLivePrice ?? "true");
  return fd;
}

const storedValues = () =>
  temp.query("SELECT category, current_value_cents, quantity, use_live_price FROM assets ORDER BY id");

describe("a failed live-price fetch never persists a $0 asset", () => {
  it("refuses to create the asset and says why", async () => {
    priceCents.mockResolvedValue(null);

    const result = await createAsset(assetForm({ quantity: "10" }));

    expect(result).toMatchObject({
      error: expect.stringContaining("Could not fetch a live Gold price"),
    });
    expect(storedValues()).toEqual([]);
  });

  it("leaves an existing asset's value alone when the fetch fails", async () => {
    priceCents.mockResolvedValue(4_000_000);
    expect(await createAsset(assetForm({ quantity: "10" }))).toMatchObject({ success: true });
    const [gold] = await getAssets();
    expect(gold.currentValueCents).toBe(4_000_000);

    priceCents.mockResolvedValue(null);
    const result = await updateAsset(gold.id, assetForm({ quantity: "10" }));

    expect(result).toMatchObject({ error: expect.stringContaining("nothing was saved") });
    expect(storedValues()).toEqual([
      { category: "Commodities", current_value_cents: 4_000_000, quantity: 10, use_live_price: 1 },
    ]);
  });

  it("stores the live value when the fetch succeeds", async () => {
    priceCents.mockResolvedValue(123_456);
    expect(await createAsset(assetForm({ quantity: "2.5" }))).toMatchObject({ success: true });
    expect(storedValues()).toEqual([

      { category: "Commodities", current_value_cents: 123_455, quantity: 2.5, use_live_price: 1 },
    ]);
  });

  it("forces USD when the live provider result is submitted as EUR", async () => {
    priceCents.mockResolvedValue(123_456);
    const result = await createAsset(assetForm({ quantity: "2.5", currency: "EUR" }));
    expect(result).toMatchObject({ success: true, data: { currency: "USD" } });
  });
});

describe("holding retention lifecycle", () => {
  it("archives and restores without erasing daily history; confirmed delete cascades it", async () => {
    const created = await createAsset(
      assetForm({ category: "Savings", useLivePrice: "false", currentValue: "100" }),
    );
    if ("error" in created) throw new Error(created.error);
    expect(await snapshotNetWorth()).toMatchObject({ success: true });
    expect(temp.query("SELECT COUNT(*) AS count FROM asset_history")).toEqual([{ count: 1 }]);

    expect(await setAssetArchived(created.data.id, true)).toMatchObject({ success: true });
    expect(await getAssets()).toEqual([]);
    expect(await getAssets({ includeArchived: true })).toHaveLength(1);
    expect(temp.query("SELECT COUNT(*) AS count FROM asset_history")).toEqual([{ count: 1 }]);

    expect(await setAssetArchived(created.data.id, false)).toMatchObject({ success: true });
    expect(await getAssets()).toHaveLength(1);

    const survivor = await createAsset(
      assetForm({ category: "Other", useLivePrice: "false", currentValue: "25" }),
    );
    if ("error" in survivor) throw new Error(survivor.error);
    expect(await snapshotNetWorth()).toMatchObject({ success: true });
    expect(temp.query("SELECT COUNT(*) AS count FROM asset_history")).toEqual([{ count: 2 }]);

    expect(await deleteAsset(created.data.id)).toMatchObject({
      error: expect.stringMatching(/explicit confirmation/i),
    });
    expect(await deleteAsset(created.data.id, { confirmed: true })).toMatchObject({ success: true });
    expect(temp.query("SELECT asset_id FROM asset_history")).toEqual([
      { asset_id: survivor.data.id },
    ]);
  });
});

describe("a quantity of 0 is a quantity, not an absent value", () => {
  it("still uses live pricing when the quantity is exactly 0", async () => {
    priceCents.mockResolvedValue(0);

    const result = await createAsset(assetForm({ quantity: "0", currentValue: "999" }));

    expect(result).toMatchObject({ success: true });

    expect(priceCents).toHaveBeenCalledWith("Gold", 0, "oz");
    expect(storedValues()).toEqual([
      { category: "Commodities", current_value_cents: 0, quantity: 0, use_live_price: 1 },
    ]);
  });

  it("refuses live pricing when the quantity really is absent", async () => {
    const result = await createAsset(assetForm({}));
    expect(result).toEqual({ error: "Enter a quantity before enabling live pricing." });
    expect(priceCents).not.toHaveBeenCalled();
    expect(storedValues()).toEqual([]);
  });

  it("rejects a non-numeric quantity instead of sending NaN to the feed", async () => {
    const result = await createAsset(assetForm({ quantity: "ten" }));
    expect(result).toMatchObject({ error: expect.stringContaining("not a valid quantity") });
    expect(priceCents).not.toHaveBeenCalled();
  });
});

describe("the manual Current Value path", () => {
  it("rejects an empty value rather than storing 0", async () => {
    const result = await createAsset(
      assetForm({ category: "Savings", useLivePrice: "false", currentValue: "" }),
    );
    expect(result).toEqual({ error: "Enter a current value." });
    expect(storedValues()).toEqual([]);
  });

  it("rejects an unparseable value", async () => {
    const result = await createAsset(
      assetForm({ category: "Savings", useLivePrice: "false", currentValue: "a lot" }),
    );
    expect(result).toMatchObject({ error: expect.stringContaining("not a valid amount") });
  });

  it("accepts a deliberate zero", async () => {
    expect(
      await createAsset(assetForm({ category: "Savings", useLivePrice: "false", currentValue: "0" })),
    ).toMatchObject({ success: true });
    expect(storedValues()[0].current_value_cents).toBe(0);
  });

  it("parses a grouped decimal without float drift", async () => {
    await createAsset(
      assetForm({ category: "Savings", useLivePrice: "false", currentValue: "1,234.56" }),
    );
    expect(storedValues()[0].current_value_cents).toBe(123456);
  });

  it("ignores live pricing entirely for a non-commodity category", async () => {
    priceCents.mockResolvedValue(999);
    await createAsset(assetForm({ category: "Savings", currentValue: "10", useLivePrice: "true" }));
    expect(priceCents).not.toHaveBeenCalled();
    expect(storedValues()[0].current_value_cents).toBe(1000);
  });
});

describe("the derived Cash asset stays derived", () => {
  it("refuses to create one by hand", async () => {
    const result = await createAsset(
      assetForm({ category: "Cash", useLivePrice: "false", currentValue: "100" }),
    );
    expect(result).toMatchObject({ error: expect.stringContaining("calculated from your transactions") });
    expect(storedValues()).toEqual([]);
  });

  it("refuses to edit or delete the derived one", async () => {

    const { execOn } = await import("./support/temp-db");
    execOn(temp, (db) => {
      db.run(
        "INSERT INTO assets (id, category, current_value_cents, currency) VALUES (1, 'Cash', 5000, 'USD')",
      );
    });

    expect(await updateAsset(1, assetForm({ category: "Savings", useLivePrice: "false", currentValue: "1" })))
      .toMatchObject({ error: expect.stringContaining("cannot be edited") });
    expect(await deleteAsset(1)).toMatchObject({
      error: expect.stringContaining("cannot be deleted"),
    });
    expect(storedValues()).toEqual([
      { category: "Cash", current_value_cents: 5000, quantity: null, use_live_price: 0 },
    ]);
  });
});
