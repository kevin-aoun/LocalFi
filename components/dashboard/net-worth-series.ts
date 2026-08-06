/**
 * Net worth over time — the series behind the dashboard's headline chart.
 *
 * WHY THIS FILE EXISTS
 *
 * 1. **Nothing read the history.** `net_worth_snapshots` existed and
 *    `snapshotNetWorth()` wrote it (idempotently, one row per calendar day), but
 *    no page ever read it back, so the app had no net-worth-over-time chart at
 *    all — the one chart every comparable app leads with.
 *
 * 2. **An empty history must not look like a flat line.** A brand-new database
 *    has zero or one snapshot. Plotting one point draws a horizontal line, which
 *    reads as "your net worth has not moved" — a claim about data that does not
 *    exist. `buildNetWorthSeries` therefore reports `empty` / `single` and the UI
 *    says "record a snapshot to start tracking" instead of drawing anything.
 *
 * 3. **The chart must not contradict the card it sits on.** Every figure here is
 *    ECHOED from the snapshot row that `deriveNetWorth` produced; this module
 *    performs no balance arithmetic and never re-subtracts liabilities from
 *    assets, so a plotted point and the printed headline cannot drift apart. The
 *    only arithmetic is `sumCents`-based differencing for the "vs. last month"
 *    figure, and the single float conversion at the Recharts boundary.
 *
 * 4. **Snapshot dates are CALENDAR DAYS.** They are stored as 'YYYY-MM-DD' and
 *    every label goes through lib/dates, never `toISOString()`, which would move
 *    every point a day for anyone east of UTC.
 *
 * There is no jsdom in this repo, so all of this lives outside the component and
 * is covered by __tests__/net-worth-series.test.ts — the same arrangement as
 * cash-series.ts.
 */
import { normalizeCurrency } from "@/components/assets/currency-totals";
import { fromDateKey, isDateKey, startOfMonth, toDateKey, type DateKey } from "@/lib/dates";
import { centsToDecimal, formatMoney, negateCents, sumCents, type Cents } from "@/lib/money";

/** The columns of a `net_worth_snapshots` row this module needs. */
export type NetWorthSnapshotRow = {
  /** 'YYYY-MM-DD' local calendar day. */
  date: string;
  totalAssetsCents: Cents;
  /** Positive magnitude of everything owed. */
  totalLiabilitiesCents: Cents;
  /** As stored by `deriveNetWorth`. Echoed, never recomputed here. */
  netWorthCents: Cents;
};

export type NetWorthPoint = {
  dateKey: DateKey;
  /** Local-calendar label for the x-axis. */
  label: string;
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
  /** CHARTING BOUNDARY ONLY — floats for Recharts. Never used for arithmetic. */
  netWorth: number;
  assets: number;
  liabilities: number;
};

export type NetWorthSeriesStatus =
  /** No snapshot at all: there is nothing to plot and nothing to imply. */
  | "empty"
  /** Exactly one day recorded: a line would be a lie, so show the figure only. */
  | "single"
  /** Two or more days: a trend exists. */
  | "ready";

export type NetWorthSeries = {
  status: NetWorthSeriesStatus;
  /** Oldest first. Empty for `status: "empty"`. */
  points: NetWorthPoint[];
  /** Honest guidance while there is too little history to draw a trend. */
  message: string | null;
  /** Rows skipped because their stored date was not a real calendar day. */
  droppedCount: number;
  first: NetWorthPoint | null;
  latest: NetWorthPoint | null;
  /** latest − first, or null when fewer than two points exist. */
  spanChangeCents: Cents | null;
};

/**
 * 'YYYY-MM-DD' -> a short local-calendar label. Falls back to the raw key rather
 * than throwing, so one bad row can never blank the whole chart.
 */
export function formatSnapshotLabel(key: string, options?: { withYear?: boolean }): string {
  if (!isDateKey(key)) return key;
  return fromDateKey(key).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(options?.withYear ? { year: "numeric" } : {}),
  });
}

/**
 * Snapshots -> chart points, oldest first.
 *
 * Rows are sorted by their date KEY (lexicographic order on 'YYYY-MM-DD' is
 * chronological order, in every timezone). Rows whose date is not a real calendar
 * day are dropped and counted, so the UI can admit to them instead of silently
 * plotting a wrong x position.
 */
export function buildNetWorthSeries(
  rows: readonly NetWorthSnapshotRow[],
): NetWorthSeries {
  const usable = rows.filter((row) => isDateKey(row.date));
  const droppedCount = rows.length - usable.length;

  const sorted = [...usable].sort((a, b) => a.date.localeCompare(b.date));

  // Only show years once the history actually spans more than one — otherwise
  // "Jul 28, 2026" wastes axis width on every tick.
  const years = new Set(sorted.map((row) => row.date.slice(0, 4)));
  const withYear = years.size > 1;

  const points: NetWorthPoint[] = sorted.map((row) => ({
    dateKey: row.date,
    label: formatSnapshotLabel(row.date, { withYear }),
    totalAssetsCents: row.totalAssetsCents,
    totalLiabilitiesCents: row.totalLiabilitiesCents,
    netWorthCents: row.netWorthCents,
    netWorth: centsToDecimal(row.netWorthCents),
    assets: centsToDecimal(row.totalAssetsCents),
    liabilities: centsToDecimal(row.totalLiabilitiesCents),
  }));

  const first = points[0] ?? null;
  const latest = points[points.length - 1] ?? null;

  const status: NetWorthSeriesStatus =
    points.length === 0 ? "empty" : points.length === 1 ? "single" : "ready";

  const message =
    status === "empty"
      ? "No net-worth history yet: record a snapshot to start tracking."
      : status === "single"
        ? `Only ${formatSnapshotLabel(first!.dateKey, { withYear: true })} is recorded. ` +
          "Record another day to see how your net worth moves."
        : null;

  return {
    status,
    points,
    message,
    droppedCount,
    first,
    latest,
    spanChangeCents:
      points.length >= 2 && first && latest
        ? sumCents([latest.netWorthCents, negateCents(first.netWorthCents)])
        : null,
  };
}

export type NetWorthChange = {
  /** Net worth as at the baseline snapshot. */
  baselineCents: Cents;
  /** The day that baseline was recorded. */
  baselineDateKey: DateKey;
  /** currentCents − baselineCents, in exact cents (signed). */
  changeCents: Cents;
  /** Percentage change, or null when the baseline was exactly zero. */
  changePercent: number | null;
};

/**
 * "vs. last month" for net worth: the live figure against the most recent
 * snapshot recorded BEFORE the first of the current month.
 *
 * Returns `null` when no such snapshot exists. That is the whole point: the
 * dashboard used to print a hardcoded `0` here, and "no change" is a very
 * different statement from "nothing to compare against". The caller hides the
 * block rather than inventing a number.
 *
 * The percentage is a ratio, not money, so plain division is correct. It is
 * measured against the MAGNITUDE of the baseline, so climbing out of debt
 * (−$1,000 -> −$500) reads as a positive move, and it is `null` rather than
 * Infinity when the baseline was zero.
 */
export function netWorthChangeVsLastMonth(
  rows: readonly NetWorthSnapshotRow[],
  currentCents: Cents,
  now: Date = new Date(),
): NetWorthChange | null {
  const firstOfThisMonth = toDateKey(startOfMonth(now));
  const earlier = rows
    .filter((row) => isDateKey(row.date) && row.date < firstOfThisMonth)
    .sort((a, b) => a.date.localeCompare(b.date));

  const baseline = earlier[earlier.length - 1];
  if (!baseline) return null;

  const changeCents = sumCents([currentCents, negateCents(baseline.netWorthCents)]);
  return {
    baselineCents: baseline.netWorthCents,
    baselineDateKey: baseline.date,
    changeCents,
    changePercent:
      baseline.netWorthCents === 0
        ? null
        : (changeCents / Math.abs(baseline.netWorthCents)) * 100,
  };
}

/**
 * A snapshot is a record of a past day; the headline is live. When the two differ
 * the page says so, because a chart that ends below the printed figure otherwise
 * looks like a bug in one of them.
 *
 * Returns null when there is no history, or when the last snapshot still matches
 * the live figure exactly — in which case there is nothing to disclose.
 */
export function describeSnapshotDrift(
  liveNetWorthCents: Cents,
  latest: NetWorthPoint | null,
  currency = "USD",
): string | null {
  if (!latest) return null;
  if (latest.netWorthCents === liveNetWorthCents) return null;
  const code = normalizeCurrency(currency);
  return (
    `Last recorded ${formatMoney(latest.netWorthCents, code)} on ${latest.label}; ` +
    `live figure is ${formatMoney(liveNetWorthCents, code)}. Record today to add it to the chart.`
  );
}

/**
 * Y-axis bounds for the net-worth line, as DECIMALS (pixel-space, not money).
 *
 * Zero is always included once anything is negative, so an underwater net worth
 * reads as below the axis line rather than as a small positive number. A flat
 * series still gets a non-zero height, or Recharts collapses the axis.
 */
export function netWorthDomain(points: readonly NetWorthPoint[]): [number, number] {
  if (points.length === 0) return [0, 100];

  const values = points.map((point) => point.netWorth);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min < 0) max = Math.max(max, 0);
  if (max > 0) min = Math.min(min, 0);

  const span = max - min;
  const pad = span === 0 ? Math.max(Math.abs(max) * 0.1, 1) : span * 0.1;
  return [min - pad, max + pad];
}

/** The account fields the liability list needs. */
export type LiabilityRow = {
  id: number;
  name: string;
  kind: string;
  owedCents: Cents;
};

/**
 * The liabilities to list under the summary, largest debt first.
 *
 * Selected by `kind`, NEVER by the sign of a balance: an overpaid credit card has
 * a positive balance and is still a card, and a mortgage that happens to be
 * fully paid should still be visible rather than silently dropped. The dashboard
 * showed no liabilities at all before, so a mortgage was simply absent from the
 * home page while it quietly reduced the figure on /accounts.
 */
export function liabilitiesForDisplay<T extends LiabilityRow>(
  accounts: readonly T[],
): T[] {
  return accounts
    .filter((account) => account.kind === "liability")
    .sort((a, b) => b.owedCents - a.owedCents || a.name.localeCompare(b.name, "en") || a.id - b.id);
}

/**
 * Which currency the net-worth totals may honestly be labelled with.
 *
 * There is no FX source in this app and `deriveNetWorth` adds every account and
 * standalone asset together regardless of currency. When they all agree, the
 * total is labelled with that code; when they do not, `mixed` is set so the page
 * shows the caveat rather than stamping one symbol on a cross-currency sum.
 */
export function netWorthCurrencies(
  rows: readonly { currency?: string | null }[],
): { currency: string; mixed: boolean; currencies: string[] } {
  const codes = [...new Set(rows.map((row) => normalizeCurrency(row.currency)))].sort();
  if (codes.length === 0) return { currency: "USD", mixed: false, currencies: [] };
  return {
    currency: codes.length === 1 ? codes[0] : "USD",
    mixed: codes.length > 1,
    currencies: codes,
  };
}
