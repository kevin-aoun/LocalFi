import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTransactionMovements,
  correctLedgerEventInput,
  deleteLedgerEventInput,
  postLedgerEventRaw,
  registerLedgerAccount,
  verifyLedger,
} from "@/lib/ledger";
import {
  prepareInvestmentPurchase,
  postAssetOpeningPosition,
  projectInvestmentPurchase,
  projectPositionHolding,
  recordInstrumentObservation,
} from "@/lib/investments";
import { withDb } from "@/lib/db/client";
import { planNetWorthReconstruction } from "@/lib/history/run";

import { createTempDb, execOn, type TempDb } from "./support/temp-db";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { createAsset, deleteAsset, getInvestmentHistory, updateAsset } = await import("../assets");
const { snapshotNetWorth } = await import("../accounts");

let temp: TempDb;

beforeEach(async () => {
  temp = await createTempDb();
});

afterEach(async () => {
  await temp.cleanup();
});

function manualAssetForm(value: string, notes: string) {
  const form = new FormData();
  form.set("category", "Other");
  form.set("currentValue", value);
  form.set("currency", "USD");
  form.set("notes", notes);
  form.set("useLivePrice", "false");
  return form;
}

describe("DEC-013 manual valuation observations", () => {
  it("gives each manual asset a unique instrument and replaces its same-day valuation", async () => {
    const first = await createAsset(manualAssetForm("100", "Painting"));
    const second = await createAsset(manualAssetForm("50", "Watch"));
    if ("error" in first) throw new Error(first.error);
    if ("error" in second) throw new Error(second.error);

    expect(await updateAsset(first.data.id, manualAssetForm("125.50", "Painting")))
      .toMatchObject({ success: true });

    const instruments = temp.query(
      "SELECT id, kind, label FROM instruments WHERE kind = 'manual' ORDER BY label",
    );
    expect(instruments).toHaveLength(2);
    expect(new Set(instruments.map((row) => row.id)).size).toBe(2);
    expect(temp.query(
      `SELECT a.notes, o.observation_kind, o.amount_minor, o.currency
         FROM assets a
         JOIN instrument_observations o ON o.instrument_id = a.instrument_id
        ORDER BY a.id`,
    )).toEqual([
      { notes: "Painting", observation_kind: "valuation", amount_minor: 12_550, currency: "USD" },
      { notes: "Watch", observation_kind: "valuation", amount_minor: 5_000, currency: "USD" },
    ]);
    expect(temp.query(
      `SELECT p.quantity, p.book_amount_minor
         FROM instrument_positions p JOIN assets a ON a.instrument_id = p.instrument_id
        ORDER BY a.id`,
    )).toEqual([
      { quantity: "1", book_amount_minor: 12_550 },
      { quantity: "1", book_amount_minor: 5_000 },
    ]);
    expect(temp.query(
      `SELECT COUNT(*) AS events,
              SUM(CASE WHEN amends_event_id IS NOT NULL THEN 1 ELSE 0 END) AS corrections
         FROM ledger_events`,
    )).toEqual([{ events: 3, corrections: 1 }]);

    expect(await deleteAsset(second.data.id, { confirmed: true })).toMatchObject({ success: true });
    expect(temp.query(
      `SELECT quantity, book_amount_minor FROM instrument_positions
        WHERE instrument_id = '${second.data.instrumentId}'`,
    )).toEqual([{ quantity: "0", book_amount_minor: 0 }]);
    expect(temp.query("SELECT COUNT(*) AS events FROM ledger_events")).toEqual([{ events: 4 }]);
  });

  it("keeps opening provenance stable across balanced quantity-only corrections", async () => {
    const created = await createAsset(manualAssetForm("100.00", "Collectible"));
    if ("error" in created) throw new Error(created.error);

    await withDb((_db, raw) => {
      for (const quantity of ["2", "3"]) {
        postAssetOpeningPosition(raw, {
          assetId: created.data.id,
          instrumentId: created.data.instrumentId!,
          currency: "USD",
          quantity,
          bookAmountMinor: 10_000,
          effectiveDate: "2026-08-10",
          description: "Correct opening quantity",
          source: "manual-holding",
        });
      }
      projectPositionHolding(raw, created.data.instrumentId!, "USD");
    });

    const events = temp.query(
      `SELECT metadata_json FROM ledger_events ORDER BY sequence`,
    ).map((row) => JSON.parse(String(row.metadata_json)) as Record<string, unknown>);
    expect(events).toHaveLength(3);
    expect(events.map((metadata) => metadata.provenance)).toEqual([
      { source: "manual-holding" },
      { source: "manual-holding" },
      { source: "manual-holding" },
    ]);
    const correctionMovements = temp.query(
      `SELECT m.amount_minor, m.quantity_delta
         FROM ledger_movements m JOIN ledger_events e ON e.event_id = m.event_id
        WHERE e.sequence IN (2, 3) ORDER BY e.sequence, m.position`,
    );
    expect(correctionMovements).toHaveLength(4);
    expect(correctionMovements.filter((row) => row.quantity_delta !== null)).toEqual([
      { amount_minor: 0, quantity_delta: "1" },
      { amount_minor: 0, quantity_delta: "1" },
    ]);
    expect(temp.query("SELECT quantity, book_amount_minor FROM instrument_positions")).toEqual([
      { quantity: "3", book_amount_minor: 10_000 },
    ]);
  });
});

describe("CONTRACT-013 exact automatic positions", () => {
  it("values a positioned instrument at zero before its first observation", async () => {
    await withDb((_db, raw) => {
      raw.run(
        `INSERT INTO categories (id, name, type, icon, color)
         VALUES (997, 'Unobserved position', 'Investment', 'Bitcoin', '#f59e0b')`,
      );
      const accountTargetId = registerLedgerAccount(raw, {
        targetType: "real_account", targetRef: 1, currency: "USD",
      });
      const categoryTargetId = registerLedgerAccount(raw, {
        targetType: "category", targetRef: 997, currency: "USD",
      });
      const purchase = prepareInvestmentPurchase(raw, {
        symbol: "BTC",
        currency: "USD",
        quantity: "0.1",
        unitPriceMinor: 10_000_000,
        observedAt: 1_785_600_000,
        observedDay: "2026-08-01",
        source: "test",
      });
      postLedgerEventRaw(raw, {
        effectiveDate: "2026-08-01",
        description: "Buy before first retained observation",
        metadata: { type: "purchase" },
        movements: buildTransactionMovements({
          direction: "outflow",
          amountMinor: 1_000_000,
          currency: "USD",
          accountTargetId,
          categoryTargetId,
          instrumentTargetId: purchase.instrumentTargetId,
          instrumentBookCounterTargetId: purchase.instrumentBookCounterTargetId,
          quantityDelta: purchase.quantityDelta,
        }),
      });
      projectInvestmentPurchase(raw, purchase);
      raw.run("DELETE FROM instrument_observations WHERE instrument_id = ?", [purchase.instrumentId]);
      recordInstrumentObservation(raw, {
        instrumentId: purchase.instrumentId,
        observationKind: "price",
        observedDay: "2026-08-03",
        observedAt: 1_785_772_800,
        amountMinor: 20_000_000,
        currency: "USD",
        source: "test",
      });
      projectInvestmentPurchase(raw, purchase);
    });

    expect(temp.query("SELECT current_value_cents FROM assets"))
      .toEqual([{ current_value_cents: 2_000_000 }]);
    const planned = await planNetWorthReconstruction({
      fromKey: "2026-08-02",
      toKey: "2026-08-02",
      today: "2026-08-09",
    });
    expect(planned).toMatchObject({
      ok: true,
      plan: { days: [{ holdingsCents: 0, totalAssetsCents: 0, totalLiabilitiesCents: 1_000_000 }] },
    });
    expect(await snapshotNetWorth({ dateKey: "2026-08-02" })).toMatchObject({
      success: true,
      data: { totalAssetsCents: 0, totalLiabilitiesCents: 1_000_000 },
    });
    expect(temp.query("SELECT value_cents FROM asset_history WHERE recorded_day = '2026-08-02'"))
      .toEqual([{ value_cents: 0 }]);
  });

  it("replays exact quantities against observations without inventing daily prices", async () => {
    await withDb((_db, raw) => {
      raw.run(
        `INSERT INTO categories (id, name, type, icon, color)
         VALUES (998, 'History purchase', 'Investment', 'Bitcoin', '#f59e0b')`,
      );
      const accountTargetId = registerLedgerAccount(raw, {
        targetType: "real_account", targetRef: 1, currency: "USD",
      });
      const categoryTargetId = registerLedgerAccount(raw, {
        targetType: "category", targetRef: 998, currency: "USD",
      });
      const purchase = prepareInvestmentPurchase(raw, {
        symbol: "BTC",
        currency: "USD",
        quantity: "0.1",
        unitPriceMinor: 10_000_000,
        observedAt: 1_785_600_000,
        observedDay: "2026-08-01",
        source: "test",
      });
      postLedgerEventRaw(raw, {
        effectiveDate: "2026-08-01",
        description: "Buy BTC",
        metadata: { type: "purchase" },
        movements: buildTransactionMovements({
          direction: "outflow",
          amountMinor: 1_000_000,
          currency: "USD",
          accountTargetId,
          categoryTargetId,
          instrumentTargetId: purchase.instrumentTargetId,
          instrumentBookCounterTargetId: purchase.instrumentBookCounterTargetId,
          quantityDelta: purchase.quantityDelta,
        }),
      });
      projectInvestmentPurchase(raw, purchase);
      recordInstrumentObservation(raw, {
        instrumentId: purchase.instrumentId,
        observationKind: "price",
        observedDay: "2026-08-03",
        observedAt: 1_785_772_800,
        amountMinor: 20_000_000,
        currency: "USD",
        source: "test",
      });
    });

    expect((await getInvestmentHistory()).map((row) => [row.dateKey, row.valueCents])).toEqual([
      ["2026-08-01", 1_000_000],
      ["2026-08-03", 2_000_000],
    ]);
  });

  it("discovers BTC once and projects create, edit, and delete movements into one holding", async () => {
    await withDb((_db, raw) => {
      raw.run(
        `INSERT INTO categories (id, name, type, icon, color)
         VALUES (999, 'Investment test purchase', 'Investment', 'Bitcoin', '#f59e0b')`,
      );
      const accountTargetId = registerLedgerAccount(raw, {
        targetType: "real_account",
        targetRef: 1,
        currency: "USD",
      });
      const categoryTargetId = registerLedgerAccount(raw, {
        targetType: "category",
        targetRef: 999,
        currency: "USD",
      });

      const firstPurchase = prepareInvestmentPurchase(raw, {
        symbol: "btc",
        currency: "USD",
        quantity: "0.10000000",
        unit: "coins",
        unitPriceMinor: 10_000_000,
        observedAt: 1_786_291_200,
        observedDay: "2026-08-09",
        source: "test",
      });
      const firstMovements = buildTransactionMovements({
        direction: "outflow",
        amountMinor: 1_000_000,
        currency: "USD",
        accountTargetId,
        categoryTargetId,
        instrumentTargetId: firstPurchase.instrumentTargetId,
        instrumentBookCounterTargetId: firstPurchase.instrumentBookCounterTargetId,
        quantityDelta: firstPurchase.quantityDelta,
      });
      const firstEvent = postLedgerEventRaw(raw, {
        effectiveDate: "2026-08-09",
        description: "Buy BTC",
        metadata: { type: "purchase" },
        movements: firstMovements,
        recordedAt: 1_786_291_200,
      });
      projectInvestmentPurchase(raw, firstPurchase);

      const correctedMovements = buildTransactionMovements({
        direction: "outflow",
        amountMinor: 1_200_000,
        currency: "USD",
        accountTargetId,
        categoryTargetId,
        instrumentTargetId: firstPurchase.instrumentTargetId,
        instrumentBookCounterTargetId: firstPurchase.instrumentBookCounterTargetId,
        quantityDelta: "0.12",
      });
      const correctedEvent = postLedgerEventRaw(
        raw,
        correctLedgerEventInput(firstEvent.eventId, firstMovements, correctedMovements, {
          effectiveDate: "2026-08-09",
          description: "Correct BTC purchase",
          metadata: { type: "purchase-correction" },
          recordedAt: 1_786_291_201,
        }),
      );
      expect(projectInvestmentPurchase(raw, firstPurchase)).toMatchObject({
        quantity: "0.12",
        bookAmountMinor: 1_200_000,
        valueMinor: 1_200_000,
      });

      postLedgerEventRaw(
        raw,
        deleteLedgerEventInput(correctedEvent.eventId, correctedMovements, {
          effectiveDate: "2026-08-09",
          description: "Delete BTC purchase",
          metadata: { type: "purchase-deletion" },
          recordedAt: 1_786_291_202,
        }),
      );
      projectInvestmentPurchase(raw, firstPurchase);
    });

    expect(temp.query(
      "SELECT symbol, unit, price_currency FROM instruments WHERE symbol = 'BTC'",
    )).toEqual([{ symbol: "BTC", unit: "coins", price_currency: "USD" }]);
    expect(temp.query(
      "SELECT quantity, book_amount_minor FROM instrument_positions",
    )).toEqual([{ quantity: "0", book_amount_minor: 0 }]);
    expect(temp.query(
      `SELECT category, current_value_cents, quantity, price_symbol, instrument_id
         FROM assets`,
    )).toEqual([]);

    execOn(temp, (raw) => raw.run(
      `INSERT INTO assets
        (category, current_value_cents, currency, instrument_id, quantity, price_symbol)
       VALUES ('Crypto', 0, 'USD', 'instrument:security:BTC', 0, 'BTC')`,
    ));
    expect((await verifyLedger()).failures.map((failure) => failure.invariant))
      .toContain("projection.asset_zero_visible");
  });

  it("keeps one latest same-day observation and refuses an older late arrival", () => {
    execOn(temp, (raw) => {
      const purchase = prepareInvestmentPurchase(raw, {
        symbol: "XAU",
        currency: "USD",
        quantity: "1",
        unit: "oz",
        unitPriceMinor: 300_000,
        observedAt: 1_786_291_200,
        observedDay: "2026-08-09",
      });
      recordInstrumentObservation(raw, {
        instrumentId: purchase.instrumentId,
        observationKind: "price",
        observedDay: "2026-08-09",
        observedAt: 1_786_291_300,
        amountMinor: 310_000,
        currency: "USD",
        source: "latest",
      });
      recordInstrumentObservation(raw, {
        instrumentId: purchase.instrumentId,
        observationKind: "price",
        observedDay: "2026-08-09",
        observedAt: 1_786_291_250,
        amountMinor: 305_000,
        currency: "USD",
        source: "late-old-write",
      });
    });

    expect(temp.query(
      `SELECT observation_kind, observed_day, observed_at, amount_minor, currency, source
         FROM instrument_observations`,
    )).toEqual([
      {
        observation_kind: "price",
        observed_day: "2026-08-09",
        observed_at: 1_786_291_300,
        amount_minor: 310_000,
        currency: "USD",
        source: "latest",
      },
    ]);
  });
});
