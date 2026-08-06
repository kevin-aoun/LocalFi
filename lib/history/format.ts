/**
 * Renders a reconstruction plan for a human to EYEBALL BEFORE ANYTHING IS
 * WRITTEN. Pure string building — no clock, no database, no network — so the
 * dry-run output is reproducible and testable.
 *
 * What it must make obvious, in this order:
 *   1. which half of each figure is exact (accounts) and which is estimated (holdings);
 *   2. when each holding started existing, and how that date was determined;
 *   3. whether the purchase day is continuous — the model's defining property;
 *   4. every reason a row would be labelled `reconstructed` rather than `recorded`;
 *   5. what a write would actually do, including how many real snapshots it would
 *      refuse to touch.
 */
import { formatMoney, negateCents, sumCents, type Cents } from "@/lib/money";
import type { DateKey } from "@/lib/dates";

import type { ReconstructionPlan, WriteReport } from "./run";

export type RenderOptions = {
  /** Print every single day instead of the head/tail/month-end digest. */
  allDays?: boolean;
  /** How many days to show at each end of the digest. */
  edge?: number;
};

function money(cents: Cents): string {
  return formatMoney(cents);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function isMonthEnd(dateKey: DateKey, next: DateKey | undefined): boolean {
  if (next === undefined) return true;
  return dateKey.slice(0, 7) !== next.slice(0, 7);
}

/**
 * Which days to print. A year is 405 rows; showing all of them by default buries
 * the parts that matter, so the digest keeps both ends in full and one row per
 * month in between. `--all-days` prints the lot.
 */
function selectDays(plan: ReconstructionPlan, options: RenderOptions): Array<{ index: number; elided: number }> {
  const { days } = plan;
  const edge = options.edge ?? 10;
  if (options.allDays || days.length <= edge * 2 + 4) {
    return days.map((_, index) => ({ index, elided: 0 }));
  }

  const wanted = new Set<number>();
  for (let i = 0; i < edge; i++) wanted.add(i);
  for (let i = days.length - edge; i < days.length; i++) wanted.add(i);
  for (let i = 0; i < days.length; i++) {
    if (isMonthEnd(days[i].dateKey, days[i + 1]?.dateKey)) wanted.add(i);
  }
  // Acquisition days: the whole point of the model is what happens on them.
  for (const holding of plan.holdings) {
    const at = days.findIndex((d) => d.dateKey === holding.acquiredOn);
    if (at >= 0) {
      if (at > 0) wanted.add(at - 1);
      wanted.add(at);
      if (at + 1 < days.length) wanted.add(at + 1);
    }
  }

  const sorted = [...wanted].sort((a, b) => a - b);
  const out: Array<{ index: number; elided: number }> = [];
  let previous = -1;
  for (const index of sorted) {
    out.push({ index, elided: index - previous - 1 });
    previous = index;
  }
  return out;
}

export function renderPlan(plan: ReconstructionPlan, options: RenderOptions = {}): string {
  const lines: string[] = [];
  const { days } = plan;

  lines.push("HISTORICAL NET-WORTH RECONSTRUCTION");
  lines.push(`  range        ${plan.fromKey} .. ${plan.toKey}  (${days.length} day(s))`);
  lines.push(`  today        ${plan.today}`);
  lines.push(`  ledger from  ${plan.ledgerFirstKey ?? "(no transactions)"}`);
  lines.push("");

  lines.push("PRICE SERIES (one request per symbol, for the whole window):");
  if (plan.series.length === 0) {
    lines.push("  none needed: no live-priced holding with a quantity");
  } else {
    for (const series of plan.series) {
      lines.push(
        `  ${padRight(series.symbol, 5)} ${padRight(series.coinGeckoId, 10)} ` +
          `${series.points} point(s)  ${series.firstKey} .. ${series.lastKey}` +
          (series.proxy ? "   [PROXY]" : ""),
      );
    }
  }
  lines.push("");

  lines.push("HOLDINGS (a day before the acquisition day contributes 0, not today's value):");
  for (const holding of plan.holdings) {
    const quantity = holding.quantity === null ? "—" : `${holding.quantity} ${holding.unit ?? ""}`.trim();
    lines.push(
      `  ${padRight(holding.label, 22)} ${padRight(holding.symbol ?? "hand-valued", 12)} ` +
        `${padRight(quantity, 16)} from ${holding.acquiredOn} ` +
        `(${holding.acquisitionSource === "ledger" ? `transaction #${holding.acquisitionTxId}` : "assets.created_at"})`,
    );
    lines.push(`      ${holding.valuationReason}`);
  }
  lines.push("");

  lines.push("PURCHASE-DAY CONTINUITY (buying is a conversion, so the day must not jump):");
  if (plan.continuity.length === 0) {
    lines.push("  no holding has a purchase transaction to check against");
  } else {
    for (const check of plan.continuity) {
      const verdict =
        check.residualCents === 0
          ? "CONTINUOUS (0 cents)"
          : `STEP of ${money(check.residualCents)}; see the warning below`;
      lines.push(
        `  ${padRight(check.label, 22)} ${check.dateKey}  paid ${money(check.paidCents)} ` +
          `vs valued ${money(check.valuedCents)}  ->  ${verdict}`,
      );
    }
  }
  lines.push("");

  if (plan.warnings.length > 0) {
    lines.push("WHY THESE ROWS ARE ESTIMATES:");
    for (const warning of plan.warnings) lines.push(`  [${warning.code}] ${warning.message}`);
    lines.push("");
  }

  const header =
    `  ${padRight("date", 12)}${pad("accounts", 14)}${pad("holdings", 14)}` +
    `${pad("net worth", 14)}${pad("Δ day", 12)}  existing`;
  lines.push("RECONSTRUCTED SERIES:");
  lines.push(header);
  lines.push(`  ${"-".repeat(header.length - 2)}`);

  const existingByDate = new Map(plan.existing.map((row) => [row.dateKey, row]));
  for (const { index, elided } of selectDays(plan, options)) {
    if (elided > 0) lines.push(`  ... ${elided} day(s) elided (use --all-days) ...`);
    const day = days[index];
    const previous = index > 0 ? days[index - 1] : null;
    const delta =
      previous === null ? null : sumCents([day.netWorthCents, negateCents(previous.netWorthCents)]);
    const existing = existingByDate.get(day.dateKey);
    lines.push(
      `  ${padRight(day.dateKey, 12)}${pad(money(day.accountsCents), 14)}` +
        `${pad(money(day.holdingsCents), 14)}${pad(money(day.netWorthCents), 14)}` +
        `${pad(delta === null ? "—" : money(delta), 12)}  ${existing ? existing.source : ""}`,
    );
  }
  lines.push("");

  const first = days[0];
  const last = days[days.length - 1];
  if (first && last) {
    lines.push(
      `Net worth ${first.dateKey} ${money(first.netWorthCents)}  ->  ` +
        `${last.dateKey} ${money(last.netWorthCents)}  ` +
        `(${money(sumCents([last.netWorthCents, negateCents(first.netWorthCents)]))} over ${days.length} day(s))`,
    );
  }

  const recorded = plan.existing.filter((row) => row.source !== "reconstructed").length;
  const reconstructed = plan.existing.length - recorded;
  lines.push(
    `Existing rows in range: ${plan.existing.length} (${recorded} recorded, never overwritten, ` +
      `${reconstructed} reconstructed: refreshed only if the figures changed).`,
  );

  return lines.join("\n");
}

export function renderWriteReport(report: WriteReport): string {
  return [
    "WRITE REPORT:",
    `  inserted          ${report.inserted}`,
    `  updated           ${report.updated}`,
    `  unchanged         ${report.unchanged}`,
    `  skipped (recorded)${pad(String(report.skippedRecorded), 3)}   <- real snapshots, left untouched`,
    `  days considered   ${report.total}`,
  ].join("\n");
}
