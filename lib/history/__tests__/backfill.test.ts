/**
 * End to end, against a real (throwaway) database: plan → write → re-run.
 *
 * The rules being defended:
 *   - a dry run writes NOTHING;
 *   - a written row is labelled `reconstructed` and carries a note saying why;
 *   - a day that already holds a RECORDED snapshot is skipped, never replaced;
 *   - re-running changes nothing at all — no duplicates, no drift, not even
 *     `updated_at`;
 *   - a price-fetch failure leaves the table exactly as it was.
 *
 * Every test gets its own mkdtemp database via the shared domain fixture, so
 * data/budget.db is never opened, and every fetch is injected or stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDomainDb,
  execOn,
  seedCategory,
  seedTransaction,
  type DomainDb,
} from "@/app/actions/__tests__/support/domain-fixture";
import { applyNetWorthReconstruction, neededSymbols, planNetWorthReconstruction, runNetWorthReconstruction } from "../run";
import { renderPlan, renderWriteReport } from "../format";
import { previewNetWorthReconstruction } from "@/app/actions/history";
import type { PriceFetchLike } from "@/lib/prices";

let temp: DomainDb;

/** Local-midnight unix seconds — matches how the fixture stores dates. */
function secondsFor(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
}

/** A CoinGecko market_chart body for a flat $1,900.00/oz week. */
function goldBody() {
  const prices: Array<[number, number]> = [];
  for (let day = 8; day <= 15; day++) {
    prices.push([Date.UTC(2026, 0, day), 1900]);
  }
  return { prices, market_caps: [], total_volumes: [] };
}

const goldFetch: PriceFetchLike = async () => ({ ok: true, status: 200, json: async () => goldBody() });

const failingFetch: PriceFetchLike = async () => {
  throw new Error("getaddrinfo ENOTFOUND api.coingecko.com");
};

function seedGoldHolding() {
  execOn(temp, (db) => {
    db.run(
      `INSERT INTO assets (id, category, current_value_cents, currency, commodity_type, quantity, unit,
                           price_symbol, use_live_price, created_at, updated_at)
       VALUES (2, 'Commodities', 400000, 'USD', 'Gold', 1.1376, 'oz', 'XAU', 1, ?, ?)`,
      [secondsFor("2026-01-20"), secondsFor("2026-01-20")],
    );
    // The derived Cash row: must never be counted (it IS the ledger).
    db.run(
      `INSERT INTO assets (id, category, current_value_cents, currency, notes, created_at, updated_at)
       VALUES (1, 'Cash', 620000, 'USD', 'Auto-calculated from transactions', ?, ?)`,
      [secondsFor("2026-01-01"), secondsFor("2026-01-01")],
    );
  });
}

const RANGE = { fromKey: "2026-01-08", toKey: "2026-01-15", today: "2026-01-15" } as const;

function snapshots() {
  return temp.query(
    "SELECT date, total_assets_cents, net_worth_cents, source, source_note, updated_at FROM net_worth_snapshots ORDER BY date",
  );
}

beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 1, name: "Salary", type: "Income" });
  seedCategory(temp, { id: 3, name: "Commodities", type: "Investment" });
  // Account 1 ("Main", opening 0) is created by migration 0003 itself.
  seedTransaction(temp, { id: 1, dateKey: "2026-01-01", categoryId: 1, accountId: 1, amountCents: 1_000_000 });
  seedTransaction(temp, {
    id: 2,
    dateKey: "2026-01-10",
    categoryId: 3,
    accountId: 1,
    amountCents: 380_000,
    comment: "Gold (1oz)",
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await temp.cleanup();
});

describe("migration 0005 in a freshly replayed database", () => {
  it("gives net_worth_snapshots a source column that defaults to 'recorded'", () => {
    const columns = temp.query("PRAGMA table_info(net_worth_snapshots)");
    const names = columns.map((c) => String(c.name));
    expect(names).toContain("source");
    expect(names).toContain("source_note");
    expect(columns.find((c) => c.name === "source")?.notnull).toBe(1);

    execOn(temp, (db) => {
      db.run(
        "INSERT INTO net_worth_snapshots (date, total_assets_cents, total_liabilities_cents, net_worth_cents) VALUES ('2026-01-01', 1, 0, 1)",
      );
    });
    expect(temp.scalar("SELECT source FROM net_worth_snapshots WHERE date = '2026-01-01'")).toBe("recorded");
  });
});

describe("neededSymbols", () => {
  it("asks only for symbols a holding can actually be valued with", () => {
    expect(
      neededSymbols([
        { id: 1, category: "Cash", currentValueCents: 1, priceSymbol: "XAU", quantity: 1, createdAt: 0 },
        { id: 2, category: "Commodities", currentValueCents: 1, priceSymbol: "XAU", quantity: 1.1, createdAt: 0 },
        { id: 3, category: "Crypto", currentValueCents: 1, priceSymbol: "BTC", quantity: null, createdAt: 0 },
        { id: 4, category: "Properties", currentValueCents: 1, createdAt: 0 },
      ]),
    ).toEqual(["XAU"]);
  });
});

describe("the dry run", () => {
  it("computes the whole series and writes absolutely nothing", async () => {
    seedGoldHolding();
    const run = await runNetWorthReconstruction({ ...RANGE, fetchImpl: goldFetch });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    expect(run.write).toBeNull();
    expect(snapshots()).toEqual([]);
    expect(run.plan.days).toHaveLength(8);
    // Continuous purchase day: 1.1376 oz at $1,900.00 is $2,161.44 against
    // $3,800.00 paid, so this ledger does NOT balance — and it says so.
    expect(run.plan.continuity[0]).toMatchObject({ dateKey: "2026-01-10", paidCents: 380_000 });
  });

  it("renders a report that names the proxy, the acquisition source and the residual", async () => {
    seedGoldHolding();
    const planned = await planNetWorthReconstruction({ ...RANGE, fetchImpl: goldFetch });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const report = renderPlan(planned.plan);
    expect(report).toMatch(/PRICE SERIES/);
    expect(report).toMatch(/pax-gold/);
    expect(report).toMatch(/\[PROXY\]/);
    expect(report).toMatch(/PURCHASE-DAY CONTINUITY/);
    expect(report).toMatch(/transaction #2/);
    expect(report).toMatch(/2026-01-08/);
  });
});

describe("writing", () => {
  it("inserts one labelled, annotated row per day", async () => {
    seedGoldHolding();
    const run = await runNetWorthReconstruction({ ...RANGE, fetchImpl: goldFetch, apply: true });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    expect(run.write).toMatchObject({ inserted: 8, updated: 0, unchanged: 0, skippedRecorded: 0 });
    const rows = snapshots();
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.source === "reconstructed")).toBe(true);
    expect(rows.every((r) => typeof r.source_note === "string" && r.source_note.length > 0)).toBe(true);
    expect(String(rows[3].source_note)).toMatch(/pax-gold proxy/);
    expect(renderWriteReport(run.write!)).toMatch(/inserted\s+8/);
    // The same transaction also writes the holding-level child ledger. Gold is
    // first held on Jan 10, so there are six values through Jan 15 and no fake
    // zeroes before acquisition.
    expect(Number(temp.scalar("SELECT COUNT(*) FROM asset_history WHERE asset_id = 2"))).toBe(6);
  });

  it("is idempotent: a second run changes nothing, not even updated_at", async () => {
    seedGoldHolding();
    await runNetWorthReconstruction({ ...RANGE, fetchImpl: goldFetch, apply: true });
    const before = snapshots();

    const again = await runNetWorthReconstruction({ ...RANGE, fetchImpl: goldFetch, apply: true });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.write).toMatchObject({ inserted: 0, updated: 0, unchanged: 8 });
    expect(snapshots()).toEqual(before);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM asset_history WHERE asset_id = 2"))).toBe(6);
  });

  it("NEVER overwrites a recorded snapshot, and reports how many it skipped", async () => {
    seedGoldHolding();
    execOn(temp, (db) => {
      db.run(
        `INSERT INTO net_worth_snapshots (date, total_assets_cents, total_liabilities_cents, net_worth_cents, source)
         VALUES ('2026-01-12', 111111, 0, 111111, 'recorded')`,
      );
    });

    const run = await runNetWorthReconstruction({ ...RANGE, fetchImpl: goldFetch, apply: true });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.write).toMatchObject({ inserted: 7, skippedRecorded: 1 });

    const kept = temp.query("SELECT * FROM net_worth_snapshots WHERE date = '2026-01-12'");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ source: "recorded", net_worth_cents: 111111, source_note: null });
  });

  it("refreshes a reconstructed row when the figures change", async () => {
    seedGoldHolding();
    execOn(temp, (db) => {
      db.run(
        `INSERT INTO net_worth_snapshots (date, total_assets_cents, total_liabilities_cents, net_worth_cents, source, source_note)
         VALUES ('2026-01-12', 1, 0, 1, 'reconstructed', 'stale')`,
      );
    });
    const run = await runNetWorthReconstruction({ ...RANGE, fetchImpl: goldFetch, apply: true });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.write).toMatchObject({ inserted: 7, updated: 1, skippedRecorded: 0 });
    expect(temp.scalar("SELECT net_worth_cents FROM net_worth_snapshots WHERE date = '2026-01-12'")).not.toBe(1);
  });
});

describe("failure cannot corrupt anything", () => {
  it("writes nothing when the price API is unreachable", async () => {
    seedGoldHolding();
    const run = await runNetWorthReconstruction({ ...RANGE, fetchImpl: failingFetch, apply: true });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe("price_fetch_failed");
    expect(run.error.message).toMatch(/NOTHING was written/);
    expect(snapshots()).toEqual([]);
  });

  it("leaves an earlier successful backfill intact when a later run fails", async () => {
    seedGoldHolding();
    await runNetWorthReconstruction({ ...RANGE, fetchImpl: goldFetch, apply: true });
    const before = snapshots();

    const failed = await runNetWorthReconstruction({ ...RANGE, fetchImpl: failingFetch, apply: true });
    expect(failed.ok).toBe(false);
    expect(snapshots()).toEqual(before);
  });

  it("refuses a day it cannot price rather than writing a guess", async () => {
    seedGoldHolding();
    // The window starts on the 8th; ask for the 1st, when the gold was already held.
    execOn(temp, (db) => db.run("UPDATE assets SET created_at = ? WHERE id = 2", [secondsFor("2026-01-01")]));
    execOn(temp, (db) => db.run("DELETE FROM transactions WHERE id = 2"));

    const run = await runNetWorthReconstruction({
      fromKey: "2026-01-01",
      toKey: "2026-01-15",
      today: "2026-01-15",
      fetchImpl: goldFetch,
      apply: true,
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe("no_price_for_day");
    expect(snapshots()).toEqual([]);
  });
});

describe("range defaults", () => {
  it("starts at the earliest transaction and never runs past today", async () => {
    seedGoldHolding();
    const planned = await planNetWorthReconstruction({
      today: "2026-01-15",
      toKey: "2027-01-01",
      fromKey: "2026-01-08",
      fetchImpl: goldFetch,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.toKey).toBe("2026-01-15");
    expect(planned.plan.ledgerFirstKey).toBe("2026-01-01");
  });
});

describe("the server action", () => {
  it("previews without writing, using the ambient fetch", async () => {
    seedGoldHolding();
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => goldBody() }));

    const result = await previewNetWorthReconstruction(RANGE);
    expect("success" in result).toBe(true);
    if (!("success" in result)) return;
    expect(result.data.dayCount).toBe(8);
    expect(result.data.series[0].dateKey).toBe("2026-01-08");
    expect(result.data.report).toMatch(/RECONSTRUCTED SERIES/);
    expect(snapshots()).toEqual([]);
  });

  it("reports a fetch failure as an error instead of throwing", async () => {
    seedGoldHolding();
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    const result = await previewNetWorthReconstruction(RANGE);
    expect("error" in result).toBe(true);
    expect(snapshots()).toEqual([]);
  });
});

describe("applyNetWorthReconstruction on a plan with no days", () => {
  it("is a no-op", async () => {
    seedGoldHolding();
    const planned = await planNetWorthReconstruction({
      fromKey: "2026-01-15",
      toKey: "2026-01-15",
      today: "2026-01-15",
      fetchImpl: goldFetch,
    });
    if (!planned.ok) throw new Error(planned.error.message);
    const report = await applyNetWorthReconstruction({ ...planned.plan, days: [] });
    expect(report).toMatchObject({ inserted: 0, total: 0 });
    expect(snapshots()).toEqual([]);
  });
});
