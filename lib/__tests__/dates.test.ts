import { describe, expect, it } from "vitest";

import {
  endOfMonth,
  fromDateKey,
  fromMonthKey,
  isDateKey,
  monthKey,
  parseExcelSerial,
  parseFlexibleDate,
  startOfDay,
  startOfMonth,
  toDateKey,
  todayKey,
} from "@/lib/dates";

function localKey(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const TZ = process.env.TZ ?? "(system default)";

describe(`toDateKey (TZ=${TZ})`, () => {
  it("formats from LOCAL components, zero-padded", () => {
    expect(toDateKey(new Date(2026, 6, 28))).toBe("2026-07-28");
    expect(toDateKey(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(toDateKey(new Date(2026, 11, 31))).toBe("2026-12-31");
    expect(toDateKey(new Date(1999, 8, 9))).toBe("1999-09-09");
  });

  it("REGRESSION (bug 1): a Date at local midnight keeps its own calendar day", () => {
    // transaction-dialog.tsx used date.toISOString().split("T")[0] on a Date at
    // local midnight. East of UTC that yields the PREVIOUS calendar day.
    const picked = new Date(2026, 6, 28); // user picked July 28 in the date picker
    expect(toDateKey(picked)).toBe("2026-07-28");
    expect(toDateKey(picked)).toBe(localKey(picked));
  });

  it("REGRESSION (bug 1): every day of a 4-year span survives the round trip", () => {
    for (let year = 2024; year <= 2027; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        const last = new Date(year, month + 1, 0).getDate();
        for (let day = 1; day <= last; day += 1) {
          const d = new Date(year, month, day); // local midnight
          const key = toDateKey(d);
          expect(key).toBe(localKey(d));
          const back = fromDateKey(key);
          expect(toDateKey(back)).toBe(key);
          expect(back.getFullYear()).toBe(year);
          expect(back.getMonth()).toBe(month);
          expect(back.getDate()).toBe(day);
        }
      }
    }
  });

  it("REGRESSION (bug 1): month-end spend is filed in the right budget month", () => {
    for (let month = 0; month < 12; month += 1) {
      const lastDay = new Date(2026, month + 1, 0).getDate();
      const lastMidnight = new Date(2026, month, lastDay);
      const firstMidnight = new Date(2026, month, 1);
      const expected = `2026-${String(month + 1).padStart(2, "0")}`;
      expect(monthKey(lastMidnight)).toBe(expected);
      expect(monthKey(firstMidnight)).toBe(expected);
      expect(toDateKey(lastMidnight)).toBe(`${expected}-${String(lastDay).padStart(2, "0")}`);
    }
  });

  it("keys the local calendar day regardless of the time of day", () => {
    expect(toDateKey(new Date(2026, 6, 28, 0, 0, 0))).toBe("2026-07-28");
    expect(toDateKey(new Date(2026, 6, 28, 12, 0, 0))).toBe("2026-07-28");
    expect(toDateKey(new Date(2026, 6, 28, 23, 59, 59, 999))).toBe("2026-07-28");
    expect(toDateKey(new Date(2026, 6, 29, 0, 0, 0, 1))).toBe("2026-07-29");
  });

  it("never uses toISOString (proof: it disagrees with the local day off-UTC)", () => {
    const midnight = new Date(2026, 0, 1); // Jan 1, 00:00 local
    const lateEvening = new Date(2026, 0, 1, 23, 0); // Jan 1, 23:00 local
    expect(toDateKey(midnight)).toBe("2026-01-01");
    expect(toDateKey(lateEvening)).toBe("2026-01-01");

    const offsetMinutes = midnight.getTimezoneOffset();
    if (offsetMinutes < 0) {
      // East of UTC: local midnight ISO-shifts BACK to Dec 31 (the shipped bug:
      // a user in Beirut/UTC+3 picking the 28th stored the 27th).
      expect(midnight.toISOString().slice(0, 10)).toBe("2025-12-31");
      expect(midnight.toISOString().slice(0, 10)).not.toBe(toDateKey(midnight));
    } else if (offsetMinutes > 0) {
      // West of UTC: a late-evening local time ISO-shifts FORWARD to Jan 2.
      expect(lateEvening.toISOString().slice(0, 10)).toBe("2026-01-02");
      expect(lateEvening.toISOString().slice(0, 10)).not.toBe(toDateKey(lateEvening));
    }
  });

  it("throws on an invalid Date instead of emitting 'NaN-NaN-NaN'", () => {
    expect(() => toDateKey(new Date(NaN))).toThrow(Error);
    expect(() => toDateKey("2026-07-28" as unknown as Date)).toThrow(Error);
  });
});

describe(`fromDateKey (TZ=${TZ})`, () => {
  it("returns local midnight", () => {
    const d = fromDateKey("2026-07-28");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(28);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });

  it("round-trips with toDateKey", () => {
    for (const key of [
      "2026-07-28",
      "2026-01-01",
      "2026-12-31",
      "2024-02-29",
      "2000-02-29",
      "1970-01-01",
      "2026-03-08",
      "2026-11-01",
    ]) {
      expect(toDateKey(fromDateKey(key))).toBe(key);
    }
  });

  it("rejects malformed or impossible keys", () => {
    for (const bad of [
      "",
      "2026-7-28",
      "28-07-2026",
      "2026/07/28",
      "2026-13-01",
      "2026-00-01",
      "2026-02-30",
      "2023-02-29",
      "abc",
      "2026-07-28T00:00:00Z",
    ]) {
      expect(() => fromDateKey(bad), `expected "${bad}" to throw`).toThrow(Error);
    }
  });
});

describe(`isDateKey / todayKey (TZ=${TZ})`, () => {
  it("validates date keys", () => {
    expect(isDateKey("2026-07-28")).toBe(true);
    expect(isDateKey("2024-02-29")).toBe(true);
    expect(isDateKey("2023-02-29")).toBe(false);
    expect(isDateKey("2026-7-28")).toBe(false);
    expect(isDateKey("")).toBe(false);
    expect(isDateKey(null)).toBe(false);
    expect(isDateKey(42)).toBe(false);
  });

  it("todayKey matches the local calendar day", () => {
    expect(todayKey()).toBe(localKey(new Date()));
    expect(isDateKey(todayKey())).toBe(true);
  });
});

describe(`parseExcelSerial (TZ=${TZ})`, () => {
  it("converts modern serials to the right local-midnight day", () => {
    expect(toDateKey(parseExcelSerial(45678))).toBe("2025-01-21");
    expect(toDateKey(parseExcelSerial(44927))).toBe("2023-01-01");
    expect(toDateKey(parseExcelSerial(45292))).toBe("2024-01-01");
    expect(toDateKey(parseExcelSerial(45930))).toBe("2025-09-30");
    expect(toDateKey(parseExcelSerial(46000))).toBe("2025-12-09");
  });

  it("returns local midnight, not a UTC instant", () => {
    const d = parseExcelSerial(45678);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });

  it("truncates fractional (time-of-day) serials to the day", () => {
    expect(toDateKey(parseExcelSerial(45678.0001))).toBe("2025-01-21");
    expect(toDateKey(parseExcelSerial(45678.5))).toBe("2025-01-21");
    expect(toDateKey(parseExcelSerial(45678.99999))).toBe("2025-01-21");
    expect(parseExcelSerial(45678.75).getHours()).toBe(0);
  });

  it("handles the Excel 1900 leap-year bug at the boundary", () => {
    expect(toDateKey(parseExcelSerial(1))).toBe("1900-01-01");
    expect(toDateKey(parseExcelSerial(59))).toBe("1900-02-28");
    // Serial 60 is Excel's phantom 1900-02-29; it is clamped to 1900-02-28.
    expect(toDateKey(parseExcelSerial(60))).toBe("1900-02-28");
    expect(toDateKey(parseExcelSerial(61))).toBe("1900-03-01");
    expect(toDateKey(parseExcelSerial(367))).toBe("1901-01-01");
    // Excel's zero date.
    expect(toDateKey(parseExcelSerial(0))).toBe("1899-12-31");
  });

  it("round-trips days: consecutive serials are consecutive days", () => {
    for (let s = 45600; s < 45700; s += 1) {
      const a = parseExcelSerial(s);
      const b = parseExcelSerial(s + 1);
      const nextDay = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 1);
      expect(toDateKey(b)).toBe(toDateKey(nextDay));
    }
  });

  it("rejects nonsense serials loudly", () => {
    expect(() => parseExcelSerial(-1)).toThrow(Error);
    expect(() => parseExcelSerial(NaN)).toThrow(Error);
    expect(() => parseExcelSerial(Infinity)).toThrow(Error);
    expect(() => parseExcelSerial(1e9)).toThrow(Error);
    expect(() => parseExcelSerial("45678" as unknown as number)).toThrow(Error);
  });
});

describe(`parseFlexibleDate (TZ=${TZ})`, () => {
  it("parses ISO-style YYYY-MM-DD and YYYY/MM/DD", () => {
    expect(toDateKey(parseFlexibleDate("2026-07-28")!)).toBe("2026-07-28");
    expect(toDateKey(parseFlexibleDate("2026/07/28")!)).toBe("2026-07-28");
    expect(toDateKey(parseFlexibleDate("2026.07.28")!)).toBe("2026-07-28");
    expect(toDateKey(parseFlexibleDate("2026-7-8")!)).toBe("2026-07-08");
  });

  it("takes the literal date part of a timestamp string (no UTC shifting)", () => {
    expect(toDateKey(parseFlexibleDate("2026-07-28 13:45:00")!)).toBe("2026-07-28");
    expect(toDateKey(parseFlexibleDate("2026-07-28T00:00:00")!)).toBe("2026-07-28");
    expect(toDateKey(parseFlexibleDate("2026-07-28T23:00:00.000Z")!)).toBe("2026-07-28");
    expect(parseFlexibleDate("2026-07-28T23:00:00.000Z")!.getHours()).toBe(0);
  });

  it("REGRESSION (bug 2): unambiguous DD/MM/YYYY is never misread as MM/DD", () => {
    // 25 cannot be a month, so this is Dec 25 regardless of the dayFirst flag.
    expect(toDateKey(parseFlexibleDate("25/12/2026")!)).toBe("2026-12-25");
    expect(toDateKey(parseFlexibleDate("25/12/2026", { dayFirst: false })!)).toBe("2026-12-25");
    expect(toDateKey(parseFlexibleDate("25/12/2026", { dayFirst: true })!)).toBe("2026-12-25");
    expect(toDateKey(parseFlexibleDate("31-01-2026")!)).toBe("2026-01-31");
    expect(toDateKey(parseFlexibleDate("13.06.2026")!)).toBe("2026-06-13");
  });

  it("keeps unambiguous MM/DD/YYYY correct too", () => {
    expect(toDateKey(parseFlexibleDate("12/25/2026")!)).toBe("2026-12-25");
    expect(toDateKey(parseFlexibleDate("12/25/2026", { dayFirst: true })!)).toBe("2026-12-25");
    expect(toDateKey(parseFlexibleDate("01/31/2026", { dayFirst: true })!)).toBe("2026-01-31");
  });

  it("resolves ambiguous 01/02/2026 by the dayFirst flag (default US MM/DD)", () => {
    expect(toDateKey(parseFlexibleDate("01/02/2026")!)).toBe("2026-01-02");
    expect(toDateKey(parseFlexibleDate("01/02/2026", { dayFirst: false })!)).toBe("2026-01-02");
    expect(toDateKey(parseFlexibleDate("01/02/2026", { dayFirst: true })!)).toBe("2026-02-01");
    expect(toDateKey(parseFlexibleDate("03/04/2026", { dayFirst: true })!)).toBe("2026-04-03");
    expect(toDateKey(parseFlexibleDate("03/04/2026", { dayFirst: false })!)).toBe("2026-03-04");
  });

  it("expands 2-digit years (00-68 -> 2000s, 69-99 -> 1900s)", () => {
    expect(toDateKey(parseFlexibleDate("25/12/26")!)).toBe("2026-12-25");
    expect(toDateKey(parseFlexibleDate("01/02/26", { dayFirst: true })!)).toBe("2026-02-01");
    expect(toDateKey(parseFlexibleDate("01/02/99")!)).toBe("1999-01-02");
    expect(toDateKey(parseFlexibleDate("01/02/68")!)).toBe("2068-01-02");
  });

  it("accepts Excel serial numbers and numeric strings", () => {
    expect(toDateKey(parseFlexibleDate(45678)!)).toBe("2025-01-21");
    expect(toDateKey(parseFlexibleDate("45678")!)).toBe("2025-01-21");
    expect(toDateKey(parseFlexibleDate(45678.5)!)).toBe("2025-01-21");
  });

  it("accepts Date instances and normalizes them to local midnight", () => {
    const src = new Date(2026, 6, 28, 17, 30, 12, 345);
    const out = parseFlexibleDate(src)!;
    expect(toDateKey(out)).toBe("2026-07-28");
    expect(out.getHours()).toBe(0);
    expect(out).not.toBe(src); // does not mutate the caller's Date
    expect(src.getHours()).toBe(17);
  });

  it("tolerates surrounding whitespace", () => {
    expect(toDateKey(parseFlexibleDate("  2026-07-28  ")!)).toBe("2026-07-28");
    expect(toDateKey(parseFlexibleDate(" 25/12/2026 ")!)).toBe("2026-12-25");
  });

  it("returns null (never a wrong-but-plausible date, never Invalid Date)", () => {
    for (const bad of [
      "",
      "   ",
      "abc",
      "not a date",
      "13/13/2026",
      "32/01/2026",
      "00/01/2026",
      "01/00/2026",
      "2026-02-30",
      "2023-02-29",
      "31/02/2026",
      "2026",
      "07/2026",
      "2026-07-28-01",
      "July 28, 2026",
      "28 Jul 2026",
      null,
      undefined,
      NaN,
      Infinity,
      -5,
      {},
      [],
      true,
      new Date(NaN),
    ] as unknown[]) {
      const out = parseFlexibleDate(bad as string);
      expect(out, `expected ${JSON.stringify(String(bad))} -> null`).toBeNull();
    }
  });

  it("accepts real leap days and rejects fake ones", () => {
    expect(toDateKey(parseFlexibleDate("29/02/2024", { dayFirst: true })!)).toBe("2024-02-29");
    expect(toDateKey(parseFlexibleDate("02/29/2024")!)).toBe("2024-02-29");
    expect(parseFlexibleDate("29/02/2023", { dayFirst: true })).toBeNull();
    expect(parseFlexibleDate("2100-02-29")).toBeNull();
  });
});

describe(`month and day helpers (TZ=${TZ})`, () => {
  it("monthKey uses local components", () => {
    expect(monthKey(new Date(2026, 0, 1))).toBe("2026-01");
    expect(monthKey(new Date(2026, 0, 31, 23, 59))).toBe("2026-01");
    expect(monthKey(new Date(2026, 11, 31))).toBe("2026-12");
    expect(monthKey(fromDateKey("2026-07-01"))).toBe("2026-07");
    expect(() => monthKey(new Date(NaN))).toThrow(Error);
  });

  it("fromMonthKey returns the first local midnight of that month", () => {
    const d = fromMonthKey("2026-07");
    expect(toDateKey(d)).toBe("2026-07-01");
    expect(d.getHours()).toBe(0);
    expect(monthKey(d)).toBe("2026-07");
    expect(() => fromMonthKey("2026-13")).toThrow(Error);
    expect(() => fromMonthKey("2026-7")).toThrow(Error);
    expect(() => fromMonthKey("2026-07-01")).toThrow(Error);
  });

  it("startOfMonth / endOfMonth stay inside the same local month", () => {
    const mid = new Date(2026, 6, 15, 13, 45, 30, 500);
    expect(toDateKey(startOfMonth(mid))).toBe("2026-07-01");
    expect(startOfMonth(mid).getHours()).toBe(0);
    expect(toDateKey(endOfMonth(mid))).toBe("2026-07-31");
    expect(endOfMonth(mid).getHours()).toBe(23);
    expect(endOfMonth(mid).getMinutes()).toBe(59);
    expect(endOfMonth(mid).getSeconds()).toBe(59);
    expect(endOfMonth(mid).getMilliseconds()).toBe(999);
    expect(monthKey(startOfMonth(mid))).toBe("2026-07");
    expect(monthKey(endOfMonth(mid))).toBe("2026-07");
  });

  it("endOfMonth knows month lengths and leap years", () => {
    expect(toDateKey(endOfMonth(new Date(2024, 1, 10)))).toBe("2024-02-29");
    expect(toDateKey(endOfMonth(new Date(2026, 1, 10)))).toBe("2026-02-28");
    expect(toDateKey(endOfMonth(new Date(2000, 1, 10)))).toBe("2000-02-29");
    expect(toDateKey(endOfMonth(new Date(1900, 1, 10)))).toBe("1900-02-28");
    expect(toDateKey(endOfMonth(new Date(2026, 3, 10)))).toBe("2026-04-30");
    expect(toDateKey(endOfMonth(new Date(2026, 11, 10)))).toBe("2026-12-31");
  });

  it("startOfMonth / endOfMonth are correct for every month of a 3-year span", () => {
    for (let year = 2024; year <= 2026; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        const anchor = new Date(year, month, 15, 9, 30);
        const start = startOfMonth(anchor);
        const end = endOfMonth(anchor);
        expect(start.getDate()).toBe(1);
        expect(start.getMonth()).toBe(month);
        expect(end.getMonth()).toBe(month);
        expect(end.getDate()).toBe(new Date(year, month + 1, 0).getDate());
        expect(monthKey(start)).toBe(monthKey(end));
        expect(start.getTime()).toBeLessThan(end.getTime());
      }
    }
  });

  it("startOfDay strips the time without shifting the day", () => {
    const d = new Date(2026, 6, 28, 23, 59, 59, 999);
    const s = startOfDay(d);
    expect(toDateKey(s)).toBe("2026-07-28");
    expect(s.getHours()).toBe(0);
    expect(s.getMilliseconds()).toBe(0);
    expect(toDateKey(startOfDay(new Date(2026, 6, 28, 0, 0, 0)))).toBe("2026-07-28");
    expect(d.getHours()).toBe(23); // input not mutated
    expect(() => startOfDay(new Date(NaN))).toThrow(Error);
  });
});
