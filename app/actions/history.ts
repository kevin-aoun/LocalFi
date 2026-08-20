"use server";

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

  series: Array<{
    dateKey: DateKey;
    currency: string;
    netWorthCents: number;
    totalAssetsCents: number;
    totalLiabilitiesCents: number;
  }>;
  warnings: ReconstructionPlan["warnings"];
  continuity: ReconstructionPlan["continuity"];
  holdings: ReconstructionPlan["holdings"];

  recordedDays: number;

  report: string;
};

function preview(plan: ReconstructionPlan): ReconstructionPreview {
  return {
    fromKey: plan.fromKey,
    toKey: plan.toKey,
    dayCount: plan.days.length,
    series: plan.days.map((day) => ({
      dateKey: day.dateKey,
      currency: day.currency,
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
