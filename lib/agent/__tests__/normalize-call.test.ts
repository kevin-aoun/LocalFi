/**
 * The one class of model error zod cannot catch.
 *
 * Probed against the real model with the real tool payload, "10 groceries"
 * produced `{"date":"2023-10-27"}` — the model has no clock, so it emitted a
 * structurally valid date from its training distribution. zod accepts it
 * happily, and the row would land in October 2023 where nobody would find it.
 *
 * Every test here fixes `today` explicitly, so the suite is timezone-agnostic and
 * `npm run test:tz` passes at UTC+14 and UTC-11.
 */
import { describe, expect, it } from "vitest";

import {
  hasDateEvidence,
  normalizeModelCall,
  resolveRelativeDate,
} from "@/lib/agent/normalize-call";
import type { DateKey } from "@/lib/dates";

// 2026-07-28 is a Tuesday.
const TODAY: DateKey = "2026-07-28";

const call = (args: Record<string, unknown>) => ({ name: "add_transaction", arguments: args });

describe("hallucinated dates", () => {
  it("DROPS a model date when the message contains no date at all", () => {
    // The exact observed failure.
    const { call: out, notes } = normalizeModelCall(
      call({ amount: "10", category: "groceries", date: "2023-10-27" }),
      "10 groceries",
      TODAY,
    );
    expect(out.arguments).not.toHaveProperty("date");
    expect(notes.join(" ")).toMatch(/invented/i);
  });

  it("drops a FUTURE date even when the message mentions a day", () => {
    const { call: out, notes } = normalizeModelCall(
      call({ amount: "10", category: "x", date: "2099-01-01" }),
      "10 groceries yesterday",
      TODAY,
    );
    // "yesterday" wins over the model's fantasy.
    expect(out.arguments.date).toBe("2026-07-27");
    expect(notes.length).toBeGreaterThan(0);
  });

  it("drops a date over a year old rather than backfilling silently", () => {
    const { call: out, notes } = normalizeModelCall(
      call({ amount: "10", category: "x", date: "2019-03-03" }),
      "10 groceries on 2019-03-03",
      TODAY,
    );
    expect(out.arguments).not.toHaveProperty("date");
    expect(notes.join(" ")).toMatch(/over a year old|future/i);
  });

  it("keeps a plausible explicit date the user really wrote", () => {
    const { call: out } = normalizeModelCall(
      call({ amount: "10", category: "x", date: "2026-07-04" }),
      "10 groceries on 2026-07-04",
      TODAY,
    );
    expect(out.arguments.date).toBe("2026-07-04");
  });

  it("leaves a call with no date argument alone", () => {
    const { call: out, notes } = normalizeModelCall(
      call({ amount: "10", category: "x" }),
      "10 groceries",
      TODAY,
    );
    expect(out.arguments).not.toHaveProperty("date");
    expect(notes).toEqual([]);
  });

  it("never mutates the input call", () => {
    const original = call({ amount: "10", category: "x", date: "2023-01-01" });
    normalizeModelCall(original, "10 groceries", TODAY);
    expect(original.arguments.date).toBe("2023-01-01");
  });
});

describe("relative dates are resolved by us, not the model", () => {
  it("resolves the words the model echoed back verbatim", () => {
    // Observed: {"date":"yesterday"} — not a date at all.
    const { call: out } = normalizeModelCall(
      call({ amount: "43.50", category: "pharmacy", date: "yesterday" }),
      "spent 43.50 at the pharmacy yesterday",
      TODAY,
    );
    expect(out.arguments.date).toBe("2026-07-27");
  });

  it.each([
    ["today", "2026-07-28"],
    ["yesterday", "2026-07-27"],
    ["last night", "2026-07-27"],
    ["3 days ago", "2026-07-25"],
    ["day before yesterday", "2026-07-26"],
    // Tuesday the 28th: last Friday is the 24th.
    ["last friday", "2026-07-24"],
    // Naming today's weekday without "last" means today.
    ["tuesday", "2026-07-28"],
    // With "last", it means a week back.
    ["last tuesday", "2026-07-21"],
  ])("resolves %s", (phrase, expected) => {
    expect(resolveRelativeDate(phrase, TODAY)).toBe(expected);
  });

  it("returns null for a phrase it does not recognize, rather than guessing", () => {
    for (const junk of ["whenever", "", "the other day", "at some point"]) {
      expect(resolveRelativeDate(junk, TODAY)).toBeNull();
    }
  });

  it("still resolves a weekday buried in sloppy phrasing", () => {
    // "sometime last Tuesday-ish" really does name a day; resolving it is right.
    expect(resolveRelativeDate("sometime last Tuesday-ish", TODAY)).toBe("2026-07-21");
  });

  it("falls back to today when the message hints at a date it cannot parse", () => {
    const { call: out, notes } = normalizeModelCall(
      call({ amount: "10", category: "x", date: "whenever" }),
      "10 groceries last month sometime",
      TODAY,
    );
    expect(out.arguments).not.toHaveProperty("date");
    expect(notes.join(" ")).toMatch(/could not read|used today/i);
  });
});

describe("date evidence detection", () => {
  it("finds evidence in the forms a chat message actually uses", () => {
    for (const m of [
      "10 groceries yesterday",
      "spent 5 on 2026-07-04",
      "12 lunch 04/07",
      "45 dinner last friday",
      "30 fuel 3 days ago",
      "20 books in Jul",
      "paid rent last month",
    ]) {
      expect(hasDateEvidence(m)).toBe(true);
    }
  });

  it("finds none in a plain capture", () => {
    for (const m of ["10 groceries", "spent 43.50 at the pharmacy", "how much do I have", "45 dinner with Rita"]) {
      expect(hasDateEvidence(m)).toBe(false);
    }
  });

  it("is not fooled by the amount itself looking date-ish", () => {
    // "10.50" must not read as a day/month pair.
    expect(hasDateEvidence("10.50 groceries")).toBe(false);
  });
});

describe("the OMITTED-date case (the finetuned model never emits a date)", () => {
  it("injects a date the model left out when the message clearly states one", () => {
    // Observed live: "43.50 on food yesterday" -> {amount, category}, no date.
    // Without injection the schema defaults to today and the row files on the
    // wrong day with nothing said to the user.
    const { call: out, notes } = normalizeModelCall(
      { name: "add_transaction", arguments: { amount: "43.50", category: "Food" } },
      "43.50 on food yesterday",
      TODAY,
    );
    expect(out.arguments.date).toBe("2026-07-27");
    expect(notes.join(" ")).toMatch(/dated 2026-07-27/i);
  });

  it.each([
    ["20 food 3 days ago", "2026-07-25"],
    ["35 transport last friday", "2026-07-24"],
    ["14 food day before yesterday", "2026-07-26"],
  ])("injects for %s", (msg, expected) => {
    const { call: out } = normalizeModelCall(
      { name: "add_transaction", arguments: { amount: "1", category: "Food" } },
      msg,
      TODAY,
    );
    expect(out.arguments.date).toBe(expected);
  });

  it("stays quiet when the message means today — no pointless note", () => {
    const { call: out, notes } = normalizeModelCall(
      { name: "add_transaction", arguments: { amount: "10", category: "Food" } },
      "10 food today",
      TODAY,
    );
    // Today is the schema default anyway, so injecting adds nothing.
    expect(out.arguments.date).toBeUndefined();
    expect(notes).toEqual([]);
  });

  it("does NOT invent a date when the message has none", () => {
    const { call: out, notes } = normalizeModelCall(
      { name: "add_transaction", arguments: { amount: "10", category: "Food" } },
      "10 food",
      TODAY,
    );
    expect(out.arguments).not.toHaveProperty("date");
    expect(notes).toEqual([]);
  });

  it("does not inject from an unresolvable hint", () => {
    const { call: out } = normalizeModelCall(
      { name: "add_transaction", arguments: { amount: "10", category: "Food" } },
      "10 food at some point last month",
      TODAY,
    );
    // "last month" is a period, not a day — better to file today than guess.
    expect(out.arguments).not.toHaveProperty("date");
  });
});
