
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
import { postLedgerEventRaw, registerLedgerAccount } from "@/lib/ledger";
import { prepareInvestmentPurchase, projectInvestmentPurchase } from "@/lib/investments";

let temp: DomainDb;

function secondsFor(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
}

function seedGoldHolding() {
  execOn(temp, (db) => {
    const purchase = prepareInvestmentPurchase(db, {
      symbol: "XAU",
      currency: "USD",
      quantity: "1.1376",
      unit: "oz",
      unitPriceMinor: 190_000,
      observedAt: secondsFor("2026-01-08"),
      observedDay: "2026-01-08",
      source: "test-exact-observation",
    });
    const bookTarget = registerLedgerAccount(db, {
      targetType: "system",
      targetRef: `instrument-book:${purchase.instrumentId}`,
      currency: "USD",
    });
    postLedgerEventRaw(db, {
      effectiveDate: "2026-01-10",
      description: "Exact gold position",
      metadata: { fixture: true, fact: "position" },
      movements: [
        {
          ledgerAccountId: purchase.instrumentTargetId,
          amountMinor: 380_000,
          currency: "USD",
          quantityDelta: purchase.quantityDelta,
        },
        { ledgerAccountId: bookTarget, amountMinor: -380_000, currency: "USD" },
      ],
      recordedAt: secondsFor("2026-01-10"),
    });
    projectInvestmentPurchase(db, purchase);
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
    const run = await runNetWorthReconstruction(RANGE);
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    expect(run.write).toBeNull();
    expect(snapshots()).toEqual([]);
    expect(run.plan.days).toHaveLength(8);
    expect(run.plan.continuity).toEqual([]);
    expect(run.plan.days.find((day) => day.dateKey === "2026-01-10"))
      .toMatchObject({ accountsCents: 620_000, holdingsCents: 216_144, netWorthCents: 836_144 });
  });

  it("renders a report that names the proxy, the acquisition source and the residual", async () => {
    seedGoldHolding();
    const planned = await planNetWorthReconstruction(RANGE);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const report = renderPlan(planned.plan);
    expect(report).toMatch(/PRICE SERIES/);
    expect(report).toMatch(/none needed/);
    expect(report).toMatch(/PURCHASE-DAY CONTINUITY/);
    expect(planned.plan.days[0].sourceNote).toMatch(/Exact ledger position replay/);
    expect(report).toMatch(/2026-01-08/);
  });
});

describe("writing", () => {
  it("inserts one labelled, annotated row per day", async () => {
    seedGoldHolding();
    const run = await runNetWorthReconstruction({ ...RANGE, apply: true });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    expect(run.write).toMatchObject({ inserted: 8, updated: 0, unchanged: 0, skippedRecorded: 0 });
    const rows = snapshots();
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.source === "reconstructed")).toBe(true);
    expect(rows.every((r) => typeof r.source_note === "string" && r.source_note.length > 0)).toBe(true);
    expect(String(rows[3].source_note)).toMatch(/Exact ledger position replay/);
    expect(renderWriteReport(run.write!)).toMatch(/inserted\s+8/);
    // The same transaction also writes the holding-level child ledger. Gold is
    // first held on Jan 10, so there are six values through Jan 15 and no fake
    // zeroes before acquisition.
    expect(Number(temp.scalar("SELECT COUNT(*) FROM asset_history"))).toBe(6);
  });

  it("is idempotent: a second run changes nothing, not even updated_at", async () => {
    seedGoldHolding();
    await runNetWorthReconstruction({ ...RANGE, apply: true });
    const before = snapshots();

    const again = await runNetWorthReconstruction({ ...RANGE, apply: true });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.write).toMatchObject({ inserted: 0, updated: 0, unchanged: 8 });
    expect(snapshots()).toEqual(before);
    expect(Number(temp.scalar("SELECT COUNT(*) FROM asset_history"))).toBe(6);
  });

  it("NEVER overwrites a recorded snapshot, and reports how many it skipped", async () => {
    seedGoldHolding();
    execOn(temp, (db) => {
      db.run(
        `INSERT INTO net_worth_snapshots (date, total_assets_cents, total_liabilities_cents, net_worth_cents, source)
         VALUES ('2026-01-12', 111111, 0, 111111, 'recorded')`,
      );
    });

    const run = await runNetWorthReconstruction({ ...RANGE, apply: true });
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
    const run = await runNetWorthReconstruction({ ...RANGE, apply: true });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.write).toMatchObject({ inserted: 7, updated: 1, skippedRecorded: 0 });
    expect(temp.scalar("SELECT net_worth_cents FROM net_worth_snapshots WHERE date = '2026-01-12'")).not.toBe(1);
  });
});

describe("journal-native replay", () => {
  it("includes an event-backed unassigned account exactly once", async () => {
    seedTransaction(temp, {
      id: 90,
      dateKey: "2026-01-05",
      categoryId: 1,
      accountId: null,
      amountCents: 12_345,
    });
    const planned = await planNetWorthReconstruction({
      fromKey: "2026-01-08",
      toKey: "2026-01-08",
      today: "2026-01-15",
    });
    expect(planned).toMatchObject({
      ok: true,
      plan: { days: [{ accountsCents: 1_012_345, netWorthCents: 1_012_345 }] },
    });
  });

  it("does not call an injected price API", async () => {
    seedGoldHolding();
    const fetchImpl = vi.fn(async () => { throw new Error("must not fetch"); });
    const run = await runNetWorthReconstruction({ ...RANGE, fetchImpl, apply: true });
    expect(run.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(snapshots()).toHaveLength(8);
  });

  it("is unchanged when a later run is given a failing fetch implementation", async () => {
    seedGoldHolding();
    await runNetWorthReconstruction({ ...RANGE, apply: true });
    const before = snapshots();

    const fetchImpl = vi.fn(async () => { throw new Error("must not fetch"); });
    const replayed = await runNetWorthReconstruction({ ...RANGE, fetchImpl, apply: true });
    expect(replayed.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(snapshots()).toEqual(before);
  });

  it("contributes zero before the exact position exists", async () => {
    seedGoldHolding();
    const run = await runNetWorthReconstruction({
      fromKey: "2026-01-01",
      toKey: "2026-01-15",
      today: "2026-01-15",
      apply: true,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.plan.days.find((day) => day.dateKey === "2026-01-09")?.holdingsCents).toBe(0);
  });
});

describe("range defaults", () => {
  it("starts at the earliest transaction and never runs past today", async () => {
    seedGoldHolding();
    const planned = await planNetWorthReconstruction({
      today: "2026-01-15",
      toKey: "2027-01-01",
      fromKey: "2026-01-08",
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.toKey).toBe("2026-01-15");
    expect(planned.plan.ledgerFirstKey).toBe("2026-01-01");
  });
});

describe("the server action", () => {
  it("previews without writing", async () => {
    seedGoldHolding();
    const result = await previewNetWorthReconstruction(RANGE);
    expect("success" in result).toBe(true);
    if (!("success" in result)) return;
    expect(result.data.dayCount).toBe(8);
    expect(result.data.series[0].dateKey).toBe("2026-01-08");
    expect(result.data.report).toMatch(/RECONSTRUCTED SERIES/);
    expect(snapshots()).toEqual([]);
  });

  it("ignores an unavailable ambient fetch because observations are journal-native", async () => {
    seedGoldHolding();
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    const result = await previewNetWorthReconstruction(RANGE);
    expect("success" in result).toBe(true);
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
    });
    if (!planned.ok) throw new Error(planned.error.message);
    const report = await applyNetWorthReconstruction({ ...planned.plan, days: [] });
    expect(report).toMatchObject({ inserted: 0, total: 0 });
    expect(snapshots()).toEqual([]);
  });
});
