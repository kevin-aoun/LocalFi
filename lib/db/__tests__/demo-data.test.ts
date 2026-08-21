import { afterEach, describe, expect, it } from "vitest";

import { createTempDb, type TempDb } from "@/app/actions/__tests__/support/temp-db";
import { readDb, withDb } from "@/lib/db/client";
import { verifyLedgerRaw } from "@/lib/ledger";

import { DEMO_ANCHOR_DATE, populateDemoDataWithin } from "../demo-data";

const snapshotTables = [
  "accounts",
  "asset_history",
  "assets",
  "budget_reallocations",
  "budgets",
  "categories",
  "instrument_observations",
  "instrument_positions",
  "instruments",
  "ledger_accounts",
  "ledger_events",
  "ledger_movements",
  "ledger_projection_state",
  "localfi_schema_journal",
  "net_worth_snapshots",
  "quick_commands",
  "recurring_transactions",
  "settings",
  "transaction_allocations",
  "transactions",
  "travel_checkpoints",
  "visited_countries",
] as const;

async function populate(temp: TempDb) {
  process.env.BUDGET_DB_PATH = temp.file;
  const summary = await withDb((db, raw) => populateDemoDataWithin(db, raw));
  const state = await readDb((_db, raw) => ({
    verification: verifyLedgerRaw(raw),
    snapshot: JSON.stringify(Object.fromEntries(snapshotTables.map((table) => {
      const result = raw.exec(`SELECT * FROM ${table} ORDER BY 1, 2`)[0];
      return [table, { columns: result?.columns ?? [], values: result?.values ?? [] }];
    }))),
    livePriceRows: Number(raw.exec(
      "SELECT COUNT(*) FROM instruments WHERE price_source IS NOT NULL",
    )[0]?.values[0]?.[0] ?? 0),
    userName: String(raw.exec("SELECT user_name FROM settings")[0]?.values[0]?.[0] ?? ""),
    placeholderWordingRows: Number(raw.exec(
      `SELECT COUNT(*) FROM (
         SELECT name AS value FROM accounts
         UNION ALL SELECT name FROM categories
         UNION ALL SELECT notes FROM assets
         UNION ALL SELECT label FROM instruments
         UNION ALL SELECT comment FROM transactions
         UNION ALL SELECT name FROM recurring_transactions
         UNION ALL SELECT comment FROM recurring_transactions
         UNION ALL SELECT command FROM quick_commands
         UNION ALL SELECT category_name FROM quick_commands
         UNION ALL SELECT comment FROM quick_commands
         UNION ALL SELECT goal_name FROM budgets
         UNION ALL SELECT source_note FROM net_worth_snapshots
         UNION ALL SELECT city_name FROM travel_checkpoints
         UNION ALL SELECT description FROM ledger_events
         UNION ALL SELECT metadata_json FROM ledger_events
       ) WHERE lower(COALESCE(value, '')) LIKE '%demo%'
          OR lower(COALESCE(value, '')) LIKE '%fictional%'
          OR lower(COALESCE(value, '')) LIKE '%fixture%'`,
    )[0]?.values[0]?.[0] ?? 0),
    easterEgg: raw.exec(
      `SELECT t.amount_cents, t.pending, t.current_event_id, e.description
         FROM transactions t
         JOIN ledger_events e ON e.event_id = t.current_event_id
        WHERE t.comment = 'Corniche coffee and kaak'`,
    )[0]?.values[0] ?? [],
  }));
  return { summary, ...state };
}

describe.sequential("fictional demo data", () => {
  let temp: TempDb | null = null;

  afterEach(async () => {
    if (temp) await temp.cleanup();
    temp = null;
  });

  it("creates a broad useful profile whose confirmed facts verify against the ledger", async () => {
    temp = await createTempDb();
    const result = await populate(temp);

    expect(result.summary).toEqual({
      anchorDate: DEMO_ANCHOR_DATE,
      accounts: 4,
      assets: 4,
      budgets: 9,
      categories: 12,
      confirmedTransactions: 26,
      ledgerEvents: 28,
      pendingTransactions: 2,
      snapshots: 8,
    });
    expect(result.verification).toMatchObject({
      ok: true,
      counts: { events: 28, movements: 59, instruments: 3 },
      failures: [],
    });
    expect(result.livePriceRows).toBe(0);
    expect(result.userName).toBe("Khalil Mansour");
    expect(result.placeholderWordingRows).toBe(0);
    expect(result.easterEgg).toEqual([1_750, 0, expect.any(String), "Corniche coffee and kaak"]);
    expect(temp.query("SELECT name FROM accounts ORDER BY id").map((row) => row.name)).toEqual([
      "Olive Checking",
      "Mountain Savings",
      "Cedar Credit Card",
      "Wallet Cash",
    ]);
    expect(temp.query("SELECT COUNT(*) AS count FROM recurring_transactions")[0].count).toBe(4);
    expect(temp.query("SELECT COUNT(*) AS count FROM travel_checkpoints")[0].count).toBe(3);
    expect(temp.query(
      "SELECT COUNT(*) AS count FROM net_worth_snapshots WHERE source = 'reconstructed'",
    )[0].count).toBe(8);
  });

  it("produces the same logical database image on repeated runs", async () => {
    temp = await createTempDb();
    const first = await populate(temp);
    await temp.cleanup();
    temp = await createTempDb();
    const second = await populate(temp);

    expect(second.summary).toEqual(first.summary);
    expect(second.snapshot).toBe(first.snapshot);
  });

  it("refuses to mix demo rows into a non-pristine database", async () => {
    temp = await createTempDb();
    process.env.BUDGET_DB_PATH = temp.file;
    await withDb((db, raw) => populateDemoDataWithin(db, raw));

    await expect(withDb((db, raw) => populateDemoDataWithin(db, raw))).rejects.toThrow(
      /requires an empty database|requires a pristine newly migrated database/,
    );
  });
});
