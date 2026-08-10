/**
 * End-to-end wiring for the dashboard headline and its net-worth chart.
 *
 * The bug this defends against spanned two files that each looked right on their
 * own: the home page printed `deriveCashBalanceCents(...)` (the ledger counted
 * from zero, no opening balances, no liabilities) while /accounts printed
 * `getNetWorth()`. The two pages showed different numbers for the same database.
 *
 * These tests therefore run the REAL actions against a throwaway database and
 * assert that what `snapshotNetWorth()` writes is exactly what the chart plots,
 * and that the chart's last point is the figure the headline prints. The pure
 * series logic is unit-tested separately in net-worth-series.test.ts.
 *
 * data/budget.db (the user's real financial history) is never opened: the fixture
 * creates its own file under mkdtemp and points BUDGET_DB_PATH at it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDomainDb,
  seedAccount,
  seedAsset,
  seedCategory,
  type DomainDb,
} from "@/app/actions/__tests__/support/domain-fixture";
import {
  getAccountBalances,
  getNetWorth,
  getNetWorthHistory,
  snapshotNetWorth,
} from "@/app/actions/accounts";
import { endOfMonth, toDateKey, todayKey } from "@/lib/dates";
import {
  buildNetWorthSeries,
  describeSnapshotDrift,
  liabilitiesForDisplay,
  netWorthChangeVsLastMonth,
} from "../net-worth-series";

let temp: DomainDb;
const projectRoot = path.resolve(__dirname, "..", "..", "..");

beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 1, name: "Food", type: "Expense" });
  seedCategory(temp, { id: 2, name: "Salary", type: "Income" });
});

afterEach(async () => {
  await temp.cleanup();
});

describe("record-today entry points", () => {
  it("routes both buttons and the scheduled endpoint through one service", () => {
    const sources = [
      "components/dashboard/net-worth-section.tsx",
      "app/(dashboard)/accounts/accounts-client.tsx",
      "app/api/snapshot/route.ts",
    ].map((file) => readFileSync(path.join(projectRoot, file), "utf8"));

    for (const source of sources) {
      expect(source).toMatch(/await recordNetWorthToday\(\)/);
    }
    expect(sources[2]).not.toMatch(/refreshLivePricedAssets/);
  });
});

/** Last day of the month before `now` — always before the 1st of this month. */
function endOfLastMonthKey(now = new Date()): string {
  return toDateKey(endOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
}

function seedDatedAccount(values: Parameters<typeof seedAccount>[1], openingBalanceDate: string) {
  seedAccount(temp, { ...values, openingBalanceDate });
}

describe("a brand-new database", () => {
  it("reports an empty history instead of drawing a flat line", async () => {
    const series = buildNetWorthSeries(await getNetWorthHistory());
    expect(series.status).toBe("empty");
    expect(series.points).toEqual([]);
    expect(series.message).toMatch(/record a snapshot/i);
  });

  it("reports 'single' after the very first snapshot, not a trend", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 250_000 });
    expect(await snapshotNetWorth()).toMatchObject({ success: true });

    const series = buildNetWorthSeries(await getNetWorthHistory());
    expect(series.status).toBe("single");
    expect(series.latest?.dateKey).toBe(todayKey());
    expect(series.spanChangeCents).toBeNull();
  });
});

describe("the chart plots what the headline prints", () => {
  it("agrees with getNetWorth() for the day it was recorded", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 500_000 });
    seedAccount(temp, {
      name: "Mortgage",
      kind: "liability",
      type: "Mortgage",
      openingBalanceCents: 25_000_000,
    });
    seedAsset(temp, { category: "Properties", currentValueCents: 30_000_000 });

    await snapshotNetWorth();
    const live = await getNetWorth();
    const series = buildNetWorthSeries(await getNetWorthHistory());

    // $5,000 cash + $300,000 house − $250,000 mortgage.
    expect(live.totalAssetsCents).toBe(30_500_000);
    expect(live.totalLiabilitiesCents).toBe(25_000_000);
    expect(live.netWorthCents).toBe(5_500_000);

    expect(series.latest?.netWorthCents).toBe(live.netWorthCents);
    expect(series.latest?.totalAssetsCents).toBe(live.totalAssetsCents);
    expect(series.latest?.totalLiabilitiesCents).toBe(live.totalLiabilitiesCents);
    // Same input, no contradiction to disclose.
    expect(describeSnapshotDrift(live.netWorthCents, series.latest)).toBeNull();
  });

  it("keeps the mortgage visible AND subtracted (it used to be neither)", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 500_000 });
    seedAccount(temp, {
      name: "Mortgage",
      kind: "liability",
      type: "Mortgage",
      openingBalanceCents: 25_000_000,
    });

    const live = await getNetWorth();
    const listed = liabilitiesForDisplay(await getAccountBalances({ includeArchived: true }));

    expect(listed.map((row) => row.name)).toEqual(["Mortgage"]);
    expect(listed[0].owedCents).toBe(25_000_000);
    // Gross assets would have read +$5,000; net worth is −$245,000.
    expect(live.netWorthCents).toBe(-24_500_000);
    expect(live.netWorthCents).toBeLessThan(live.totalAssetsCents);
  });

  it("excludes the derived Cash asset from the standalone side (no double count)", async () => {
    seedDatedAccount(
      { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 100_000 },
      "2000-01-01",
    );
    // What `syncCashAsset` writes: the ledger, mirrored into the assets table.
    seedAsset(temp, { category: "Cash", currentValueCents: 100_000 });
    seedAsset(temp, { category: "Savings", currentValueCents: 25_000 });

    const live = await getNetWorth();
    await snapshotNetWorth();
    const series = buildNetWorthSeries(await getNetWorthHistory());

    expect(live.standaloneAssetsCents).toBe(25_000);
    expect(live.netWorthCents).toBe(125_000);
    expect(series.latest?.netWorthCents).toBe(125_000);
  });

  it("says so when the live figure has moved since the last snapshot", async () => {
    seedDatedAccount(
      { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 100_000 },
      "2000-01-01",
    );
    await snapshotNetWorth({ dateKey: endOfLastMonthKey() });

    // A new account appears after that snapshot: net worth has moved since.
    seedAccount(temp, { name: "Savings", kind: "asset", type: "Savings", openingBalanceCents: 50_000 });

    const live = await getNetWorth();
    const series = buildNetWorthSeries(await getNetWorthHistory());
    expect(live.netWorthCents).toBe(150_000);

    const drift = describeSnapshotDrift(live.netWorthCents, series.latest);
    expect(drift).toContain("$1,000.00");
    expect(drift).toContain("$1,500.00");
  });
});

describe("history accrues into a plottable trend", () => {
  it("becomes 'ready' with two days, oldest first, and spans the real change", async () => {
    seedDatedAccount(
      { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 100_000 },
      "2000-01-01",
    );
    await snapshotNetWorth({ dateKey: endOfLastMonthKey() });
    seedAccount(temp, { name: "Savings", kind: "asset", type: "Savings", openingBalanceCents: 50_000 });
    await snapshotNetWorth();

    const rows = await getNetWorthHistory();
    const series = buildNetWorthSeries(rows);

    expect(series.status).toBe("ready");
    expect(series.message).toBeNull();
    expect(series.points).toHaveLength(2);
    expect(series.points[0].dateKey < series.points[1].dateKey).toBe(true);
    expect(series.first?.netWorthCents).toBe(100_000);
    expect(series.latest?.netWorthCents).toBe(150_000);
    expect(series.spanChangeCents).toBe(50_000);
  });

  it("does not duplicate a day when the snapshot is re-run", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 100_000 });
    await snapshotNetWorth();
    await snapshotNetWorth();
    await snapshotNetWorth();

    const series = buildNetWorthSeries(await getNetWorthHistory());
    // Three recordings on one day are ONE point; otherwise the chart would show a
    // vertical stack of identical points and imply movement.
    expect(series.points).toHaveLength(1);
    expect(series.status).toBe("single");
  });

  it("computes 'vs. last month' from a real prior-month snapshot", async () => {
    seedDatedAccount(
      { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 100_000 },
      "2000-01-01",
    );
    await snapshotNetWorth({ dateKey: endOfLastMonthKey() });
    seedAccount(temp, { name: "Savings", kind: "asset", type: "Savings", openingBalanceCents: 50_000 });

    const live = await getNetWorth();
    const change = netWorthChangeVsLastMonth(await getNetWorthHistory(), live.netWorthCents);

    expect(change?.baselineCents).toBe(100_000);
    expect(change?.changeCents).toBe(50_000);
    expect(change?.changePercent).toBeCloseTo(50, 10);
  });

  it("has nothing to say about last month when only today is recorded", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 100_000 });
    await snapshotNetWorth();

    const live = await getNetWorth();
    expect(netWorthChangeVsLastMonth(await getNetWorthHistory(), live.netWorthCents)).toBeNull();
  });

  it("stores integer cents, so the chart never plots a drifted figure", async () => {
    seedAccount(temp, { name: "Checking", kind: "asset", type: "Checking", openingBalanceCents: 10_010 });
    await snapshotNetWorth();

    const series = buildNetWorthSeries(await getNetWorthHistory());
    for (const point of series.points) {
      expect(Number.isInteger(point.netWorthCents)).toBe(true);
      expect(Number.isInteger(point.totalAssetsCents)).toBe(true);
      expect(Number.isInteger(point.totalLiabilitiesCents)).toBe(true);
    }
    expect(series.latest?.netWorthCents).toBe(10_010);
  });
});
