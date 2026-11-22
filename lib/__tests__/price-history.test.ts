import { describe, expect, it, vi } from "vitest";
import { firstPriceGap } from "@/lib/investments";
import { fetchDailyCloses, historyTicker, parseDailyCloses } from "@/lib/prices";

const epoch = (day: string, hourUtc = 0) => Date.parse(`${day}T${String(hourUtc).padStart(2, "0")}:00:00Z`) / 1000;
const chart = (meta: Record<string, unknown>, timestamp: number[], close: Array<number | null>) =>
  ({ chart: { error: null, result: [{ meta: { currency: "USD", ...meta }, timestamp, indicators: { quote: [{ close }] } }] } });

describe("daily price history", () => {
  it("maps holdings to keyless Yahoo tickers, gold through its PAXG proxy", () => {
    expect(historyTicker("XAU")).toBe("PAXG-USD");
    expect(historyTicker("BTC")).toBe("BTC-USD");
    expect(historyTicker("STOCK:CSPX")).toBe("CSPX.L");
    expect(historyTicker("STOCK:NVDA")).toBe("NVDA");
    expect(historyTicker("XAG")).toBeNull();
  });

  it("dates each close in the exchange's calendar and skips missing closes", () => {
    // A New York close stamped 13:30 UTC stays on its own day; gmtoffset is -4h.
    const closes = parseDailyCloses(chart({ symbol: "NVDA", gmtoffset: -14_400 },
      [epoch("2026-09-14", 13), epoch("2026-09-15", 13), epoch("2026-09-16", 2)],
      [180.12346, null, 190]), "NVDA");
    expect(closes).toEqual([
      { day: "2026-09-14", observedAt: epoch("2026-09-14", 13), unitPrice: "180.1235" },
      { day: "2026-09-15", observedAt: epoch("2026-09-16", 2), unitPrice: "190" },
    ]);
  });

  it("refuses another ticker or currency, and returns nothing when the request fails", async () => {
    expect(parseDailyCloses(chart({ symbol: "AAPL" }, [], []), "NVDA")).toBeNull();
    expect(parseDailyCloses(chart({ symbol: "NVDA", currency: "EUR" }, [], []), "NVDA")).toBeNull();
    await expect(fetchDailyCloses("XAU", 0, { fetchImpl: vi.fn().mockRejectedValue(new Error("offline")) })).resolves.toEqual([]);
    await expect(fetchDailyCloses("XAG", 0, { fetchImpl: vi.fn() })).resolves.toEqual([]);
  });

  it("finds the first run of more than four unpriced days, up to today", () => {
    expect(firstPriceGap([], "2026-09-20")).toBeNull();
    // Friday to Monday is a weekend, not a gap.
    expect(firstPriceGap(["2026-09-11", "2026-09-14", "2026-09-18"], "2026-09-20")).toBeNull();
    expect(firstPriceGap(["2025-09-30", "2026-09-19"], "2026-09-20")).toBe("2025-09-30");
    expect(firstPriceGap(["2026-09-01", "2026-09-02"], "2026-09-20")).toBe("2026-09-02");
    expect(firstPriceGap(["2026-09-02", "2026-09-20"], "2026-09-20")).toBe("2026-09-02");
  });
});
