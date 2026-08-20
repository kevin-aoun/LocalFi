
import { describe, expect, it } from "vitest";
import {
  occurrenceAt,
  occurrencesThrough,
  nextOccurrenceAfter,
  type RecurrenceRule,
} from "@/lib/recurrence";

const monthly = (startDate: string, interval = 1, endDate: string | null = null): RecurrenceRule => ({
  frequency: "monthly",
  interval,
  startDate,
  endDate,
});

describe("occurrenceAt", () => {
  it("returns the anchor for index 0 of every frequency", () => {
    for (const frequency of ["daily", "weekly", "monthly", "yearly"] as const) {
      expect(occurrenceAt({ frequency, interval: 1, startDate: "2026-03-15" }, 0)).toBe("2026-03-15");
    }
  });

  it("steps days, weeks, months and years", () => {
    expect(occurrenceAt({ frequency: "daily", interval: 1, startDate: "2026-01-01" }, 30)).toBe("2026-01-31");
    expect(occurrenceAt({ frequency: "weekly", interval: 1, startDate: "2026-01-01" }, 2)).toBe("2026-01-15");
    expect(occurrenceAt({ frequency: "monthly", interval: 1, startDate: "2026-01-15" }, 3)).toBe("2026-04-15");
    expect(occurrenceAt({ frequency: "yearly", interval: 1, startDate: "2026-01-15" }, 2)).toBe("2028-01-15");
  });

  it("honours an interval greater than one", () => {
    expect(occurrenceAt({ frequency: "daily", interval: 10, startDate: "2026-01-01" }, 3)).toBe("2026-01-31");
    expect(occurrenceAt({ frequency: "weekly", interval: 2, startDate: "2026-01-01" }, 2)).toBe("2026-01-29");
    expect(occurrenceAt({ frequency: "monthly", interval: 3, startDate: "2026-01-10" }, 2)).toBe("2026-07-10");
    expect(occurrenceAt({ frequency: "yearly", interval: 5, startDate: "2020-06-01" }, 2)).toBe("2030-06-01");
  });

  it("clamps the 31st into short months WITHOUT losing the anchor day", () => {

    const rule = monthly("2026-01-31");
    expect(occurrenceAt(rule, 0)).toBe("2026-01-31");
    expect(occurrenceAt(rule, 1)).toBe("2026-02-28");
    expect(occurrenceAt(rule, 2)).toBe("2026-03-31");
    expect(occurrenceAt(rule, 3)).toBe("2026-04-30");
    expect(occurrenceAt(rule, 4)).toBe("2026-05-31");
  });

  it("clamps the 31st into February of a LEAP year", () => {
    const rule = monthly("2024-01-31");
    expect(occurrenceAt(rule, 1)).toBe("2024-02-29");
    expect(occurrenceAt(rule, 2)).toBe("2024-03-31");
  });

  it("clamps the 30th and the 29th too", () => {
    expect(occurrenceAt(monthly("2026-01-30"), 1)).toBe("2026-02-28");
    expect(occurrenceAt(monthly("2026-01-29"), 1)).toBe("2026-02-28");
    expect(occurrenceAt(monthly("2024-01-29"), 1)).toBe("2024-02-29");
  });

  it("restores Feb 29 on the next leap year for a yearly rule", () => {
    const rule: RecurrenceRule = { frequency: "yearly", interval: 1, startDate: "2024-02-29" };
    expect(occurrenceAt(rule, 1)).toBe("2025-02-28");
    expect(occurrenceAt(rule, 2)).toBe("2026-02-28");
    expect(occurrenceAt(rule, 4)).toBe("2028-02-29");
  });

  it("crosses year boundaries", () => {
    expect(occurrenceAt(monthly("2025-11-30"), 3)).toBe("2026-02-28");
    expect(occurrenceAt(monthly("2025-12-31"), 14)).toBe("2027-02-28");
  });

  it("rejects a non-integer or negative index and a bad interval", () => {
    expect(() => occurrenceAt(monthly("2026-01-01"), -1)).toThrow(/index/i);
    expect(() => occurrenceAt(monthly("2026-01-01"), 1.5)).toThrow(/index/i);
    expect(() => occurrenceAt({ ...monthly("2026-01-01"), interval: 0 }, 1)).toThrow(/interval/i);
    expect(() => occurrenceAt({ ...monthly("2026-01-01"), interval: -2 }, 1)).toThrow(/interval/i);
  });

  it("rejects a malformed start date", () => {
    expect(() => occurrenceAt(monthly("2026-02-30"), 0)).toThrow();
    expect(() => occurrenceAt(monthly("not-a-date"), 0)).toThrow();
  });
});

describe("occurrencesThrough", () => {
  it("returns every occurrence up to and including the through date", () => {
    expect(occurrencesThrough(monthly("2026-01-15"), "2026-04-15")).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
      "2026-04-15",
    ]);
  });

  it("excludes occurrences after the through date", () => {
    expect(occurrencesThrough(monthly("2026-01-15"), "2026-03-14")).toEqual([
      "2026-01-15",
      "2026-02-15",
    ]);
  });

  it("returns nothing when the rule has not started yet", () => {
    expect(occurrencesThrough(monthly("2026-09-01"), "2026-07-28")).toEqual([]);
  });

  it("stops at the end date even when the through date is later", () => {
    expect(occurrencesThrough(monthly("2026-01-10", 1, "2026-03-31"), "2026-12-31")).toEqual([
      "2026-01-10",
      "2026-02-10",
      "2026-03-10",
    ]);
  });

  it("treats an end date that falls exactly on an occurrence as inclusive", () => {
    expect(occurrencesThrough(monthly("2026-01-10", 1, "2026-03-10"), "2026-12-31")).toEqual([
      "2026-01-10",
      "2026-02-10",
      "2026-03-10",
    ]);
  });

  it("skips everything up to and including `afterKey` (the catch-up cursor)", () => {

    const caught = occurrencesThrough(monthly("2026-01-01"), "2026-07-28", { afterKey: "2026-02-01" });
    expect(caught).toEqual(["2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01"]);
  });

  it("returns nothing when the cursor is already at the through date", () => {
    expect(occurrencesThrough(monthly("2026-01-01"), "2026-07-01", { afterKey: "2026-07-01" })).toEqual([]);
  });

  it("catches up a whole year of missed months in one call", () => {
    const caught = occurrencesThrough(monthly("2025-01-31"), "2026-01-31");
    expect(caught).toHaveLength(13);
    expect(caught[0]).toBe("2025-01-31");
    expect(caught[1]).toBe("2025-02-28");
    expect(caught[12]).toBe("2026-01-31");
  });

  it("handles a daily rule across several missed months without drift", () => {
    const caught = occurrencesThrough(
      { frequency: "daily", interval: 1, startDate: "2026-01-01" },
      "2026-03-01",
    );
    expect(caught).toHaveLength(60);
    expect(caught[59]).toBe("2026-03-01");
  });

  it("respects an explicit limit and reports truncation via the returned length", () => {
    const caught = occurrencesThrough(monthly("2020-01-01"), "2026-07-28", { limit: 3 });
    expect(caught).toEqual(["2020-01-01", "2020-02-01", "2020-03-01"]);
  });

  it("never yields duplicates", () => {
    const caught = occurrencesThrough(monthly("2024-01-31"), "2026-07-28");
    expect(new Set(caught).size).toBe(caught.length);
  });

  it("yields strictly increasing dates", () => {
    const caught = occurrencesThrough(monthly("2024-01-31"), "2026-07-28");
    for (let i = 1; i < caught.length; i++) {
      expect(caught[i] > caught[i - 1]).toBe(true);
    }
  });
});

describe("nextOccurrenceAfter", () => {
  it("returns the anchor when nothing has been generated yet", () => {
    expect(nextOccurrenceAfter(monthly("2026-01-31"), null)).toBe("2026-01-31");
  });

  it("returns the following occurrence, month-end clamped", () => {
    expect(nextOccurrenceAfter(monthly("2026-01-31"), "2026-01-31")).toBe("2026-02-28");
    expect(nextOccurrenceAfter(monthly("2026-01-31"), "2026-02-28")).toBe("2026-03-31");
  });

  it("returns null once the end date has passed", () => {
    expect(nextOccurrenceAfter(monthly("2026-01-10", 1, "2026-03-31"), "2026-03-10")).toBeNull();
  });

  it("jumps forward from a cursor that is not itself an occurrence", () => {
    expect(nextOccurrenceAfter(monthly("2026-01-15"), "2026-04-02")).toBe("2026-04-15");
  });
});
