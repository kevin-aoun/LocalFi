/**
 * Tests for the net-worth-over-time series behind the dashboard chart.
 *
 * What these exist to prevent:
 *
 *  1. **A misleading flat line.** A brand-new database has zero or one snapshot.
 *     Rendering a chart from one point draws a horizontal line that reads as
 *     "your net worth has not moved", which is a statement about data that does
 *     not exist. `buildNetWorthSeries` reports `empty` / `single` so the UI can
 *     say "record a snapshot to start tracking" instead.
 *
 *  2. **The chart contradicting the headline.** Every figure here is ECHOED from
 *     the snapshot row (which `deriveNetWorth` wrote); nothing is re-subtracted,
 *     so the plotted point and the number on the same card cannot drift.
 *
 *  3. **Timezone day-shift.** Snapshot dates are 'YYYY-MM-DD' calendar days.
 *     Labelling them via `toISOString()` moves every point a day east of UTC.
 *     These label assertions must hold under `npm run test:tz`.
 *
 *  4. **A fabricated "vs. last month".** When there is no snapshot from before
 *     this month there is no comparison to make, and the answer is `null` — not
 *     0, not Infinity.
 */
import { describe, expect, it } from "vitest";
import { centsToDecimal, formatMoney } from "@/lib/money";
import {
  buildNetWorthSeries,
  describeSnapshotDrift,
  formatSnapshotLabel,
  liabilitiesForDisplay,
  netWorthCurrencies,
  netWorthDomain,
  netWorthChangeVsLastMonth,
  type NetWorthSnapshotRow,
} from "../net-worth-series";

const snap = (
  date: string,
  totalAssetsCents: number,
  totalLiabilitiesCents: number,
  netWorthCents?: number,
): NetWorthSnapshotRow => ({
  date,
  totalAssetsCents,
  totalLiabilitiesCents,
  netWorthCents: netWorthCents ?? totalAssetsCents - totalLiabilitiesCents,
});

describe("empty and single-snapshot history is reported, not drawn", () => {
  it("says there is nothing recorded yet rather than returning points", () => {
    const series = buildNetWorthSeries([]);
    expect(series.status).toBe("empty");
    expect(series.points).toEqual([]);
    expect(series.latest).toBeNull();
    expect(series.first).toBeNull();
    expect(series.spanChangeCents).toBeNull();
    expect(series.message).toMatch(/record/i);
  });

  it("reports a single snapshot as 'single' so no flat line is drawn", () => {
    const series = buildNetWorthSeries([snap("2026-07-28", 1_000_00, 250_00)]);
    expect(series.status).toBe("single");
    expect(series.points).toHaveLength(1);
    expect(series.latest?.netWorthCents).toBe(750_00);
    // A trend needs two points; the caller must not plot a line from one.
    expect(series.spanChangeCents).toBeNull();
    expect(series.message).toMatch(/record/i);
  });

  it("is 'ready' from two snapshots onwards, with no guidance message", () => {
    const series = buildNetWorthSeries([
      snap("2026-06-30", 1_000_00, 0),
      snap("2026-07-28", 1_500_00, 100_00),
    ]);
    expect(series.status).toBe("ready");
    expect(series.message).toBeNull();
    expect(series.spanChangeCents).toBe(400_00);
  });
});

describe("buildNetWorthSeries", () => {
  it("orders points oldest-first even if the rows arrive shuffled", () => {
    const series = buildNetWorthSeries([
      snap("2026-07-28", 300_00, 0),
      snap("2026-05-01", 100_00, 0),
      snap("2026-06-15", 200_00, 0),
    ]);
    expect(series.points.map((p) => p.dateKey)).toEqual([
      "2026-05-01",
      "2026-06-15",
      "2026-07-28",
    ]);
    expect(series.first?.dateKey).toBe("2026-05-01");
    expect(series.latest?.dateKey).toBe("2026-07-28");
  });

  it("ECHOES the stored net worth instead of re-deriving assets − liabilities", () => {
    // A deliberately inconsistent row: if this module did its own subtraction the
    // chart could disagree with the snapshot table it is drawn from.
    const series = buildNetWorthSeries([snap("2026-01-01", 100_00, 40_00, 55_00)]);
    expect(series.points[0].netWorthCents).toBe(55_00);
    expect(series.points[0].totalAssetsCents).toBe(100_00);
    expect(series.points[0].totalLiabilitiesCents).toBe(40_00);
  });

  it("converts to plain numbers ONLY at the charting boundary", () => {
    const series = buildNetWorthSeries([
      snap("2026-06-30", 123_45, 23_45),
      snap("2026-07-31", 200_00, 50_00),
    ]);
    for (const point of series.points) {
      expect(point.netWorth).toBe(centsToDecimal(point.netWorthCents));
      expect(point.assets).toBe(centsToDecimal(point.totalAssetsCents));
      expect(point.liabilities).toBe(centsToDecimal(point.totalLiabilitiesCents));
      // Cents stay integers, so arithmetic elsewhere is still exact.
      expect(Number.isInteger(point.netWorthCents)).toBe(true);
    }
  });

  it("keeps a liability reducing net worth (a mortgage is visible, not absent)", () => {
    const series = buildNetWorthSeries([
      snap("2026-06-30", 300_000_00, 250_000_00),
      snap("2026-07-31", 310_000_00, 248_000_00),
    ]);
    expect(series.points[0].netWorthCents).toBe(50_000_00);
    expect(series.latest?.totalLiabilitiesCents).toBe(248_000_00);
    expect(series.latest?.netWorthCents).toBe(62_000_00);
  });

  it("drops rows whose stored date is not a real calendar day, and counts them", () => {
    const series = buildNetWorthSeries([
      snap("2026-07-01", 100_00, 0),
      snap("2026-02-30", 999_00, 0), // not a real day
      snap("nonsense", 999_00, 0),
    ]);
    expect(series.points.map((p) => p.dateKey)).toEqual(["2026-07-01"]);
    expect(series.droppedCount).toBe(2);
  });

  it("labels points in the LOCAL calendar (must hold at UTC+14 and UTC-11)", () => {
    const series = buildNetWorthSeries([
      snap("2026-07-28", 100_00, 0),
      snap("2026-07-31", 100_00, 0),
    ]);
    expect(series.points[0].label).toBe("Jul 28");
    expect(series.points[1].label).toBe("Jul 31");
  });

  it("includes the year once the history spans more than one", () => {
    const series = buildNetWorthSeries([
      snap("2025-12-31", 100_00, 0),
      snap("2026-07-28", 200_00, 0),
    ]);
    expect(series.points[0].label).toContain("2025");
    expect(series.points[1].label).toContain("2026");
  });
});

describe("formatSnapshotLabel", () => {
  it("never shifts the day (no toISOString)", () => {
    expect(formatSnapshotLabel("2026-01-01")).toBe("Jan 1");
    expect(formatSnapshotLabel("2026-12-31")).toBe("Dec 31");
    expect(formatSnapshotLabel("2026-12-31", { withYear: true })).toBe("Dec 31, 2026");
  });

  it("returns the raw key rather than throwing on a malformed one", () => {
    expect(formatSnapshotLabel("whenever")).toBe("whenever");
  });
});

describe("netWorthChangeVsLastMonth", () => {
  const now = new Date(2026, 6, 20); // 20 July 2026

  it("compares the live figure against the last snapshot before this month", () => {
    const change = netWorthChangeVsLastMonth(
      [snap("2026-05-31", 800_00, 0), snap("2026-06-30", 1_000_00, 0)],
      1_250_00,
      now,
    );
    expect(change).not.toBeNull();
    expect(change?.baselineDateKey).toBe("2026-06-30");
    expect(change?.baselineCents).toBe(1_000_00);
    expect(change?.changeCents).toBe(250_00);
    expect(change?.changePercent).toBeCloseTo(25, 10);
  });

  it("returns null — never a fabricated 0 — when there is no earlier snapshot", () => {
    expect(netWorthChangeVsLastMonth([], 1_000_00, now)).toBeNull();
    // A snapshot from THIS month is not a baseline for "vs. last month".
    expect(
      netWorthChangeVsLastMonth([snap("2026-07-01", 500_00, 0)], 1_000_00, now),
    ).toBeNull();
  });

  it("returns null percent (not Infinity, not 0) when the baseline was zero", () => {
    const change = netWorthChangeVsLastMonth([snap("2026-06-30", 0, 0)], 40_000, now);
    expect(change?.baselineCents).toBe(0);
    expect(change?.changeCents).toBe(40_000);
    expect(change?.changePercent).toBeNull();
  });

  it("reports a fall as negative, and measures against the magnitude of a debt", () => {
    const down = netWorthChangeVsLastMonth([snap("2026-06-30", 1_000_00, 0)], 900_00, now);
    expect(down?.changeCents).toBe(-100_00);
    expect(down?.changePercent).toBeCloseTo(-10, 10);

    // Baseline underwater: −$1,000 -> −$500 is an IMPROVEMENT of $500, i.e. +50%.
    const negative = netWorthChangeVsLastMonth(
      [snap("2026-06-30", 0, 1_000_00)],
      -500_00,
      now,
    );
    expect(negative?.changeCents).toBe(500_00);
    expect(negative?.changePercent).toBeCloseTo(50, 10);
  });

  it("ignores rows with an unusable date", () => {
    expect(netWorthChangeVsLastMonth([snap("2026-02-30", 100_00, 0)], 200_00, now)).toBeNull();
  });
});

describe("the chart and the headline agree for the same input", () => {
  it("plots exactly the figure the headline prints, and reports no drift", () => {
    const rows = [snap("2026-06-30", 1_000_00, 200_00), snap("2026-07-28", 1_400_00, 150_00)];
    const series = buildNetWorthSeries(rows);
    const liveNetWorthCents = 1_250_00; // == the latest snapshot

    const plotted = series.points[series.points.length - 1];
    expect(plotted.netWorth).toBe(centsToDecimal(liveNetWorthCents));
    expect(formatMoney(plotted.netWorthCents)).toBe(formatMoney(liveNetWorthCents));
    expect(describeSnapshotDrift(liveNetWorthCents, series.latest)).toBeNull();
  });

  it("says so out loud when the live figure has moved since the last snapshot", () => {
    const series = buildNetWorthSeries([snap("2026-07-28", 1_000_00, 0)]);
    const drift = describeSnapshotDrift(1_100_00, series.latest);
    expect(drift).not.toBeNull();
    expect(drift).toContain(formatMoney(1_000_00));
    expect(drift).toContain(formatMoney(1_100_00));
    expect(drift).toContain("Jul 28");
  });

  it("has nothing to say when there is no snapshot at all", () => {
    expect(describeSnapshotDrift(1_000_00, null)).toBeNull();
  });

  it("labels the drift note in the given currency", () => {
    const series = buildNetWorthSeries([snap("2026-07-28", 1_000_00, 0)]);
    expect(describeSnapshotDrift(1_100_00, series.latest, "EUR")).toContain(
      formatMoney(1_000_00, "EUR"),
    );
  });
});

describe("netWorthDomain", () => {
  it("returns a padded range that contains every plotted value", () => {
    const series = buildNetWorthSeries([
      snap("2026-06-30", 1_000_00, 0),
      snap("2026-07-31", 2_000_00, 0),
    ]);
    const [min, max] = netWorthDomain(series.points);
    expect(min).toBeLessThanOrEqual(1_000);
    expect(max).toBeGreaterThanOrEqual(2_000);
  });

  it("always includes zero when net worth is negative, so the sign is readable", () => {
    const series = buildNetWorthSeries([
      snap("2026-06-30", 0, 1_000_00),
      snap("2026-07-31", 0, 500_00),
    ]);
    const [min, max] = netWorthDomain(series.points);
    expect(min).toBeLessThan(-1_000);
    expect(max).toBeGreaterThanOrEqual(0);
  });

  it("does not collapse to a zero-height axis for a flat series", () => {
    const series = buildNetWorthSeries([
      snap("2026-06-30", 1_000_00, 0),
      snap("2026-07-31", 1_000_00, 0),
    ]);
    const [min, max] = netWorthDomain(series.points);
    expect(max).toBeGreaterThan(min);
  });

  it("is a safe [0, 100] for no points at all", () => {
    expect(netWorthDomain([])).toEqual([0, 100]);
  });
});

describe("liabilitiesForDisplay", () => {
  const account = (id: number, name: string, kind: string, owedCents: number) => ({
    id,
    name,
    kind,
    owedCents,
  });

  it("lists a mortgage — the dashboard used to show no liabilities at all", () => {
    const rows = liabilitiesForDisplay([
      account(1, "Checking", "asset", 0),
      account(2, "Visa", "liability", 60_000),
      account(3, "Mortgage", "liability", 250_000_00),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Mortgage", "Visa"]);
  });

  it("keeps a paid-off or overpaid liability visible (grouped by kind, not sign)", () => {
    const rows = liabilitiesForDisplay([
      account(1, "Paid loan", "liability", 0),
      account(2, "Card", "liability", 10_00),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Card", "Paid loan"]);
  });

  it("never lists an asset account", () => {
    expect(liabilitiesForDisplay([account(1, "Savings", "asset", 0)])).toEqual([]);
  });

  it("orders equal debts by name, then id, so the list is stable", () => {
    const rows = liabilitiesForDisplay([
      account(9, "b card", "liability", 500),
      account(4, "a card", "liability", 500),
    ]);
    expect(rows.map((r) => r.id)).toEqual([4, 9]);
  });
});

describe("netWorthCurrencies", () => {
  it("names the single currency when everything agrees", () => {
    const result = netWorthCurrencies([{ currency: "usd" }, { currency: "USD" }]);
    expect(result).toEqual({ currency: "USD", mixed: false, currencies: ["USD"] });
  });

  it("flags a mixed set instead of stamping one symbol on the sum", () => {
    const result = netWorthCurrencies([{ currency: "USD" }, { currency: "EUR" }]);
    expect(result.mixed).toBe(true);
    expect(result.currencies).toEqual(["EUR", "USD"]);
  });

  it("treats a blank currency as USD, as the column default does", () => {
    expect(netWorthCurrencies([{ currency: "" }, { currency: null }]).mixed).toBe(false);
  });

  it("defaults to USD with nothing to inspect", () => {
    expect(netWorthCurrencies([])).toEqual({ currency: "USD", mixed: false, currencies: [] });
  });
});
