import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { Cents } from "@/lib/money";

/**
 * Net worth over time: one aggregate row per calendar day. `asset_history` is
 * the holding-level child ledger written by the same snapshot/backfill paths.
 *
 * Day resolution, stored as a text DateKey ('YYYY-MM-DD') rather than a timestamp
 * for two reasons: a calendar day is what the chart's x-axis actually is (so no
 * timezone can shift a point into the previous day), and the UNIQUE index on it
 * makes "snapshot today" an UPSERT. Re-running the snapshot action any number of
 * times in one day updates that day's row instead of accruing duplicates that
 * would double-count in a chart.
 *
 * Both halves are stored, not just the net figure, so the chart can show the
 * asset and liability stacks without re-deriving history.
 */

/**
 * How a row got here (migration 0005).
 *
 *   'recorded'      — MEASURED. `snapshotNetWorth()` wrote today's derived
 *                     figures on the day they were true.
 *   'reconstructed' — INFERRED. lib/history/** computed what net worth was on a
 *                     past day: the cash side exactly, by replaying the ledger,
 *                     the holdings side from historical prices (a PAX Gold proxy
 *                     for XAU, prices carried across weekends, acquisition dates
 *                     taken from `assets.created_at` where the ledger is silent).
 *
 * An estimate and an observation must never be indistinguishable, which is why
 * this is NOT NULL with a 'recorded' default: every pre-0005 row was recorded,
 * and nothing can be written without choosing a side.
 */
export const netWorthSources = ["recorded", "reconstructed"] as const;
export type NetWorthSource = (typeof netWorthSources)[number];

export const netWorthSnapshots = sqliteTable(
  "net_worth_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 'YYYY-MM-DD' local calendar day. Unique. */
    date: text("date").notNull(),
    /** Asset accounts + unassigned ledger + standalone assets, in integer cents. */
    totalAssetsCents: integer("total_assets_cents").notNull().$type<Cents>(),
    /** Positive magnitude of everything owed, in integer cents. */
    totalLiabilitiesCents: integer("total_liabilities_cents").notNull().$type<Cents>(),
    /** totalAssetsCents − totalLiabilitiesCents, stored so a chart need not recompute. */
    netWorthCents: integer("net_worth_cents").notNull().$type<Cents>(),
    /** 'recorded' = measured on the day; 'reconstructed' = computed afterwards. */
    source: text("source", { enum: netWorthSources }).notNull().default("recorded"),
    /**
     * WHY a reconstructed row is an estimate, in words the owner can read a year
     * from now ("XAU via pax-gold proxy priced on 2025-11-02; BTC price carried
     * forward from 2025-11-01"). NULL for a recorded row — nothing to disclose.
     */
    sourceNote: text("source_note"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    dateUnique: uniqueIndex("net_worth_snapshots_date_unique").on(table.date),
  }),
);

export type NetWorthSnapshot = typeof netWorthSnapshots.$inferSelect;
export type NewNetWorthSnapshot = typeof netWorthSnapshots.$inferInsert;
