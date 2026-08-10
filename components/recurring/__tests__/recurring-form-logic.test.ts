/**
 * Unit tests for the pure logic behind the Recurring Transactions UI.
 *
 * There is no jsdom/RTL harness in this repo, so everything the dialog and the
 * list decide — form -> FormData mapping, validation, frequency wording, the
 * "what will post" preview and the generation report copy — lives in
 * `recurring-form-logic.ts` where it can be asserted directly, including under
 * the extreme timezones `bun run test:tz` runs at.
 */
import { describe, expect, it } from "vitest";

import { fromDateKey } from "@/lib/dates";
import type { RecurrenceRule } from "@/lib/recurrence";

import {
  buildRecurringFormValues,
  centsToInputValue,
  formatDateKey,
  frequencyLabel,
  groupUpcomingByDate,
  monthEndNote,
  parseInterval,
  previewOccurrences,
  scheduleStatus,
  summarizeGenerationReport,
  toRecurringFormData,
  upcomingThroughKey,
  upcomingTotals,
  validateRecurringForm,
  type GenerationReportLike,
  type RecurringFormState,
} from "../recurring-form-logic";

function state(overrides: Partial<RecurringFormState> = {}): RecurringFormState {
  return {
    name: "Rent",
    accountId: "1",
    transferAccountId: "",
    categoryId: "2",
    amount: "1200",
    comment: "Monthly rent",
    frequency: "monthly",
    interval: "1",
    startDate: fromDateKey("2026-01-31"),
    endDate: null,
    archived: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A 0 amount is a real value, not "absent"
// ---------------------------------------------------------------------------

describe("a zero amount", () => {
  it("is valid", () => {
    expect(validateRecurringForm(state({ amount: "0" }))).toBeNull();
    expect(validateRecurringForm(state({ amount: "0.00" }))).toBeNull();
  });

  it("is still SENT to the server, never dropped as falsy", () => {
    const values = buildRecurringFormValues(state({ amount: "0" }));
    expect(Object.keys(values)).toContain("amount");
    expect(values.amount).toBe("0");

    const formData = toRecurringFormData(state({ amount: "0" }));
    expect(formData.has("amount")).toBe(true);
    expect(formData.get("amount")).toBe("0");
  });

  it("round-trips 0 cents into the input value", () => {
    expect(centsToInputValue(0)).toBe("0");
    expect(centsToInputValue(-4550)).toBe("-45.5");
    expect(centsToInputValue(120_000)).toBe("1200");
  });

  it("distinguishes an EMPTY amount from zero", () => {
    expect(validateRecurringForm(state({ amount: "" }))).toMatch(/amount/i);
    expect(validateRecurringForm(state({ amount: "   " }))).toMatch(/amount/i);
    expect(validateRecurringForm(state({ amount: "abc" }))).toMatch(/amount/i);
  });
});

// ---------------------------------------------------------------------------
// The month-end trap: a monthly template anchored on the 31st
// ---------------------------------------------------------------------------

describe("a monthly template starting on the 31st", () => {
  const rule: RecurrenceRule = {
    frequency: "monthly",
    interval: 1,
    startDate: "2026-01-31",
    endDate: null,
  };

  it("previews the clamp-and-restore sequence the engine really produces", () => {
    const preview = previewOccurrences(rule, { throughKey: "2026-05-31" });
    expect(preview.error).toBeNull();
    expect(preview.occurrences).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
    // The anchor day is never mutated: the 31st comes back in every long month.
    expect(preview.exhausted).toBe(false);
    expect(preview.nextDue).toBe("2026-01-31");
  });

  it("clamps to Feb 29 in a leap year", () => {
    const preview = previewOccurrences(
      { ...rule, startDate: "2028-01-31" },
      { throughKey: "2028-03-31" },
    );
    expect(preview.occurrences).toEqual(["2028-01-31", "2028-02-29", "2028-03-31"]);
  });

  it("explains the clamp in the UI copy", () => {
    const note = monthEndNote(rule);
    expect(note).not.toBeNull();
    expect(note).toMatch(/31/);
    expect(note).toMatch(/last day/i);
  });

  it("says nothing for an anchor day that exists in every month", () => {
    expect(monthEndNote({ ...rule, startDate: "2026-01-15" })).toBeNull();
    expect(monthEndNote({ ...rule, startDate: "2026-01-28" })).toBeNull();
    // Daily/weekly rules have no month-end behaviour to explain.
    expect(monthEndNote({ ...rule, frequency: "weekly", startDate: "2026-01-31" })).toBeNull();
  });

  it("explains the Feb 29 case for a yearly rule", () => {
    const note = monthEndNote({
      frequency: "yearly",
      interval: 1,
      startDate: "2028-02-29",
      endDate: null,
    });
    expect(note).toMatch(/29/);
  });

  it("truncates a long preview instead of rendering hundreds of rows", () => {
    const preview = previewOccurrences(
      { frequency: "daily", interval: 1, startDate: "2026-01-01", endDate: null },
      { throughKey: "2026-12-31", limit: 5 },
    );
    expect(preview.occurrences).toHaveLength(5);
    expect(preview.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// An end date that lands before the next due occurrence
// ---------------------------------------------------------------------------

describe("an end date before the next due date", () => {
  const rule: RecurrenceRule = {
    frequency: "monthly",
    interval: 1,
    startDate: "2026-01-31",
    // Feb 28 is the next occurrence, so this end date kills the rule.
    endDate: "2026-02-15",
  };

  it("previews as exhausted, with nothing left to post", () => {
    const preview = previewOccurrences(rule, {
      throughKey: "2026-12-31",
      afterKey: "2026-01-31",
    });
    expect(preview.occurrences).toEqual([]);
    expect(preview.nextDue).toBeNull();
    expect(preview.exhausted).toBe(true);
    expect(preview.error).toBeNull();
  });

  it("renders as finished rather than as an empty next-due cell", () => {
    const status = scheduleStatus(
      { nextDue: null, endDate: "2026-02-15", archived: false, lastGenerated: "2026-01-31" },
      "2026-02-20",
    );
    expect(status.tone).toBe("finished");
    expect(status.label).toMatch(/finished/i);
    expect(status.detail).toMatch(/Feb 15, 2026/);
  });

  it("still blocks an end date before the START date, as the server does", () => {
    const bad = validateRecurringForm(
      state({ startDate: fromDateKey("2026-03-01"), endDate: fromDateKey("2026-02-01") }),
    );
    expect(bad).toMatch(/end date/i);
    // Same day is fine: a one-off occurrence.
    expect(
      validateRecurringForm(
        state({ startDate: fromDateKey("2026-03-01"), endDate: fromDateKey("2026-03-01") }),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Frequency wording, especially interval > 1
// ---------------------------------------------------------------------------

describe("frequencyLabel", () => {
  it("drops the count when the interval is 1", () => {
    expect(frequencyLabel("daily", 1)).toBe("every day");
    expect(frequencyLabel("weekly", 1)).toBe("every week");
    expect(frequencyLabel("monthly", 1)).toBe("every month");
    expect(frequencyLabel("yearly", 1)).toBe("every year");
  });

  it("pluralises for an interval above 1", () => {
    expect(frequencyLabel("daily", 3)).toBe("every 3 days");
    expect(frequencyLabel("weekly", 2)).toBe("every 2 weeks");
    expect(frequencyLabel("monthly", 6)).toBe("every 6 months");
    expect(frequencyLabel("yearly", 2)).toBe("every 2 years");
  });
});

describe("parseInterval", () => {
  it("accepts whole numbers of 1 or more", () => {
    expect(parseInterval("1")).toBe(1);
    expect(parseInterval(" 3 ")).toBe(3);
  });

  it("rejects anything the server would reject", () => {
    expect(parseInterval("")).toBeNull();
    expect(parseInterval("0")).toBeNull();
    expect(parseInterval("-2")).toBeNull();
    expect(parseInterval("1.5")).toBeNull();
    expect(parseInterval("abc")).toBeNull();
  });

  it("is surfaced as a validation message, not silently coerced", () => {
    expect(validateRecurringForm(state({ interval: "0" }))).toMatch(/interval/i);
    expect(validateRecurringForm(state({ interval: "1.5" }))).toMatch(/interval/i);
  });
});

// ---------------------------------------------------------------------------
// form -> FormData mapping
// ---------------------------------------------------------------------------

describe("buildRecurringFormValues", () => {
  it("serialises calendar days with toDateKey, never toISOString", () => {
    const values = buildRecurringFormValues(
      state({ startDate: fromDateKey("2026-01-31"), endDate: fromDateKey("2026-12-31") }),
    );
    expect(values.startDate).toBe("2026-01-31");
    expect(values.endDate).toBe("2026-12-31");
  });

  it("sends endDate as an EMPTY string when open-ended, so an edit can clear it", () => {
    const values = buildRecurringFormValues(state({ endDate: null }));
    expect(Object.keys(values)).toContain("endDate");
    expect(values.endDate).toBe("");
  });

  it("passes through the rest of the template", () => {
    expect(buildRecurringFormValues(state())).toEqual({
      name: "Rent",
      accountId: "1",
      transferAccountId: "",
      categoryId: "2",
      amount: "1200",
      comment: "Monthly rent",
      frequency: "monthly",
      interval: "1",
      startDate: "2026-01-31",
      endDate: "",
      archived: "false",
    });
  });

  it("clears the category when the template is a transfer", () => {
    const values = buildRecurringFormValues(
      state({ transferAccountId: "7", categoryId: "2" }),
    );
    expect(values.transferAccountId).toBe("7");
    expect(values.categoryId).toBe("");
  });

  it("keeps the archived flag as an explicit boolean string", () => {
    expect(buildRecurringFormValues(state({ archived: true })).archived).toBe("true");
  });
});

describe("validateRecurringForm", () => {
  it("requires a name", () => {
    expect(validateRecurringForm(state({ name: "  " }))).toMatch(/name/i);
  });

  it("mirrors the server's transfer rules", () => {
    expect(validateRecurringForm(state({ accountId: "1", transferAccountId: "1" }))).toMatch(
      /different/i,
    );
    // A transfer with a category is rejected by the server; catch it in the dialog.
    expect(
      validateRecurringForm(state({ accountId: "1", transferAccountId: "2", categoryId: "5" })),
    ).toBeNull(); // the builder drops the category, so this is not an error
  });

  it("accepts a valid template", () => {
    expect(validateRecurringForm(state())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Presentation of dates and status
// ---------------------------------------------------------------------------

describe("formatDateKey", () => {
  it("formats a key without going through UTC", () => {
    expect(formatDateKey("2026-01-31")).toBe("Jan 31, 2026");
    expect(formatDateKey("2026-12-31")).toBe("Dec 31, 2026");
    expect(formatDateKey("2026-01-01")).toBe("Jan 1, 2026");
  });

  it("has a placeholder for null", () => {
    expect(formatDateKey(null)).toBe("—");
  });
});

describe("scheduleStatus", () => {
  const base = { endDate: null, archived: false, lastGenerated: null };

  it("marks an archived template as paused", () => {
    const status = scheduleStatus({ ...base, nextDue: "2026-08-01", archived: true }, "2026-07-28");
    expect(status.tone).toBe("paused");
    expect(status.label).toMatch(/paused/i);
  });

  it("marks today's occurrence as due", () => {
    expect(scheduleStatus({ ...base, nextDue: "2026-07-28" }, "2026-07-28").tone).toBe("due");
  });

  it("marks a past occurrence as overdue", () => {
    const status = scheduleStatus({ ...base, nextDue: "2026-06-01" }, "2026-07-28");
    expect(status.tone).toBe("due");
    expect(status.label).toMatch(/overdue/i);
  });

  it("marks a future occurrence as scheduled", () => {
    const status = scheduleStatus({ ...base, nextDue: "2026-09-01" }, "2026-07-28");
    expect(status.tone).toBe("scheduled");
    expect(status.label).toBe("Next Sep 1, 2026");
  });
});

describe("upcomingThroughKey", () => {
  it("walks calendar days, crossing months and years", () => {
    expect(upcomingThroughKey("2026-01-31", 30)).toBe("2026-03-02");
    expect(upcomingThroughKey("2026-02-27", 1)).toBe("2026-02-28");
    expect(upcomingThroughKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(upcomingThroughKey("2026-07-28", 0)).toBe("2026-07-28");
  });
});

// ---------------------------------------------------------------------------
// Upcoming preview
// ---------------------------------------------------------------------------

describe("upcoming preview", () => {
  const items = [
    {
      id: 1,
      name: "Rent",
      amountCents: 120_000,
      nextDue: "2026-08-01",
      due: ["2026-08-01", "2026-09-01"],
    },
    {
      id: 2,
      name: "Netflix",
      amountCents: 0,
      nextDue: "2026-08-01",
      due: ["2026-08-01"],
    },
    {
      id: 3,
      name: "Broken",
      amountCents: 500,
      nextDue: null,
      due: [],
      error: "Invalid recurrence interval",
    },
  ];

  it("groups occurrences by calendar day, in calendar order", () => {
    const days = groupUpcomingByDate(items);
    expect(days.map((d) => d.key)).toEqual(["2026-08-01", "2026-09-01"]);
    expect(days[0].entries.map((e) => e.name)).toEqual(["Rent", "Netflix"]);
    // A 0-amount occurrence is a real occurrence and must appear.
    expect(days[0].entries[1].amountCents).toBe(0);
    expect(days[0].totalCents).toBe(120_000);
  });

  it("totals honestly, and surfaces broken templates instead of hiding them", () => {
    const totals = upcomingTotals(items, "2026-08-15");
    expect(totals.occurrences).toBe(3);
    expect(totals.dueNow).toBe(2);
    expect(totals.later).toBe(1);
    // Every OCCURRENCE counts, not every template: rent posts twice.
    // The broken template contributes nothing because it has no due days.
    expect(totals.totalCents).toBe(240_000);
    expect(totals.errors).toEqual(["Broken: Invalid recurrence interval"]);
  });
});

// ---------------------------------------------------------------------------
// Generation report copy — both numbers, always
// ---------------------------------------------------------------------------

describe("summarizeGenerationReport", () => {
  function report(overrides: Partial<GenerationReportLike> = {}): GenerationReportLike {
    return {
      throughKey: "2026-07-28",
      posted: 0,
      skipped: 0,
      templates: [],
      ...overrides,
    };
  }

  it("says plainly that nothing was due", () => {
    const summary = summarizeGenerationReport(report());
    expect(summary.posted).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.headline).toMatch(/nothing/i);
  });

  it("reports a re-run as skipped, not as success with nothing behind it", () => {
    const summary = summarizeGenerationReport(
      report({
        skipped: 3,
        templates: [
          {
            id: 1,
            name: "Rent",
            posted: [],
            skipped: ["2026-05-31", "2026-06-30", "2026-07-31"],
            lastGenerated: "2026-07-31",
            nextDue: "2026-08-31",
          },
        ],
      }),
    );
    expect(summary.headline).toMatch(/already/i);
    expect(summary.headline).toMatch(/3/);
    expect(summary.lines[0].tone).toBe("skipped");
    expect(summary.lines[0].text).toMatch(/May 31, 2026/);
  });

  it("reports both counts when a run both posted and skipped", () => {
    const summary = summarizeGenerationReport(
      report({
        posted: 2,
        skipped: 1,
        templates: [
          {
            id: 1,
            name: "Rent",
            posted: ["2026-07-31"],
            skipped: ["2026-06-30"],
            lastGenerated: "2026-07-31",
            nextDue: "2026-08-31",
          },
          {
            id: 2,
            name: "Salary",
            posted: ["2026-07-28"],
            skipped: [],
            lastGenerated: "2026-07-28",
            nextDue: "2026-08-28",
          },
        ],
      }),
    );
    expect(summary.headline).toMatch(/2/);
    expect(summary.headline).toMatch(/1/);
    expect(summary.lines).toHaveLength(2);
    expect(summary.lines[0].tone).toBe("posted");
  });

  it("surfaces a per-template error", () => {
    const summary = summarizeGenerationReport(
      report({
        templates: [
          {
            id: 1,
            name: "Rent",
            posted: [],
            skipped: [],
            lastGenerated: null,
            nextDue: null,
            error: "Invalid recurrence interval",
          },
        ],
      }),
    );
    expect(summary.errors).toEqual(["Rent: Invalid recurrence interval"]);
    expect(summary.lines[0].tone).toBe("error");
  });
});
