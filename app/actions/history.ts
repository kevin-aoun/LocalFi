"use server";

/**
 * Historical net-worth reconstruction, as server actions.
 *
 * These are thin: every decision lives in lib/history/** (pure, unit-tested, and
 * runnable from scripts/backfill-history.ts without Next). What is enforced HERE
 * is the shape of the contract with the UI:
 *
 *   - `previewNetWorthReconstruction` NEVER writes. It is what a "preview"
 *     button calls, and what the script's default `--dry-run` mode is built on.
 *   - `applyNetWorthReconstructionAction` writes only when called explicitly, and
 *     only after a successful plan — if CoinGecko is unreachable the action
 *     returns an error and the table is untouched.
 *   - Neither one can overwrite a `recorded` snapshot. That rule is in the writer,
 *     not here, so a future caller cannot route around it.
 *
 * Note that this does NOT weaken `snapshotNetWorth()` in app/actions/accounts.ts.
 * That action still refuses to file today's figures under a past date, which is
 * correct. These actions do the different, legitimate thing: they COMPUTE the
 * past and label every row they write `source = 'reconstructed'`.
 */
import { revalidate } from "@/lib/revalidate";
import type { DateKey } from "@/lib/dates";

import { renderPlan } from "@/lib/history/format";
import {
  applyNetWorthReconstruction,
  planNetWorthReconstruction,
  type ReconstructionPlan,
  type WriteReport,
} from "@/lib/history/run";

export type HistoryActionResult<T> = { success: true; data: T } | { error: string };

/** Serializable options — no fetch injection across the server-action boundary. */
export type ReconstructionRequest = {
  fromKey?: DateKey;
  toKey?: DateKey;
  today?: DateKey;
  days?: number;
  carryUnpriced?: boolean;
};

export type ReconstructionPreview = {
  fromKey: DateKey;
  toKey: DateKey;
  dayCount: number;
  /** Enough to draw a chart without shipping every holding breakdown. */
  series: Array<{ dateKey: DateKey; netWorthCents: number; totalAssetsCents: number; totalLiabilitiesCents: number }>;
  warnings: ReconstructionPlan["warnings"];
  continuity: ReconstructionPlan["continuity"];
  holdings: ReconstructionPlan["holdings"];
  /** How many days already carry a REAL snapshot and would therefore be skipped. */
  recordedDays: number;
  /** The same thing a human would read in the terminal. */
  report: string;
};

function preview(plan: ReconstructionPlan): ReconstructionPreview {
  return {
    fromKey: plan.fromKey,
    toKey: plan.toKey,
    dayCount: plan.days.length,
    series: plan.days.map((day) => ({
      dateKey: day.dateKey,
      netWorthCents: day.netWorthCents,
      totalAssetsCents: day.totalAssetsCents,
      totalLiabilitiesCents: day.totalLiabilitiesCents,
    })),
    warnings: plan.warnings,
    continuity: plan.continuity,
    holdings: plan.holdings,
    recordedDays: plan.existing.filter((row) => row.source !== "reconstructed").length,
    report: renderPlan(plan),
  };
}

/** Compute the history and return it. Writes nothing, ever. */
export async function previewNetWorthReconstruction(
  request: ReconstructionRequest = {},
): Promise<HistoryActionResult<ReconstructionPreview>> {
  try {
    const planned = await planNetWorthReconstruction(request);
    if (!planned.ok) return { error: planned.error.message };
    return { success: true, data: preview(planned.plan) };
  } catch (error) {
    console.error("Failed to reconstruct net-worth history:", error);
    return { error: (error as Error).message || "Failed to reconstruct net-worth history" };
  }
}

/**
 * Compute the history AND persist it as `reconstructed` rows.
 *
 * Everything that can fail happens before the write: if the price fetch fails the
 * database is not opened for writing at all.
 */
export async function applyNetWorthReconstructionAction(
  request: ReconstructionRequest = {},
): Promise<HistoryActionResult<ReconstructionPreview & { write: WriteReport }>> {
  try {
    const planned = await planNetWorthReconstruction(request);
    if (!planned.ok) return { error: planned.error.message };

    const write = await applyNetWorthReconstruction(planned.plan);
    revalidate("/", "/accounts");
    return { success: true, data: { ...preview(planned.plan), write } };
  } catch (error) {
    console.error("Failed to write reconstructed net-worth history:", error);
    return { error: (error as Error).message || "Failed to write reconstructed net-worth history" };
  }
}
