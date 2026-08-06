/**
 * Name resolution is the only thing standing between a free-text category from a
 * 26M model and the row the money lands on. These tests pin the ladder (exact ->
 * normalized -> unique prefix -> unique substring -> ask) and, above all, that a
 * tie is NEVER broken silently.
 */
import { describe, expect, it } from "vitest";

import {
  describeResolution,
  listNames,
  namesOf,
  normalizeName,
  resolveName,
  type Resolvable,
} from "../resolve";

const CATEGORIES: Resolvable[] = [
  { id: 1, name: "Groceries" },
  { id: 2, name: "Gifts" },
  { id: 3, name: "Dining Out" },
  { id: 4, name: "Kids' School-Fees" },
  { id: 5, name: "Café" },
  { id: 6, name: "Rent" },
];

describe("normalizeName", () => {
  it("folds case, punctuation, accents and inner whitespace", () => {
    expect(normalizeName("  Groceries  &  Household ")).toBe("groceries household");
    expect(normalizeName("Café")).toBe("cafe");
    expect(normalizeName("Kids' School-Fees")).toBe("kids school fees");
    expect(normalizeName("RENT")).toBe("rent");
  });

  it("returns an empty string for whitespace, so it cannot match everything", () => {
    expect(normalizeName("   ")).toBe("");
    expect(normalizeName("!!!")).toBe("");
  });
});

describe("resolveName: the ladder", () => {
  it("matches exactly, ignoring case and surrounding whitespace", () => {
    const result = resolveName("  groceries ", CATEGORIES);
    expect(result).toMatchObject({ status: "resolved", matchedOn: "exact" });
    if (result.status === "resolved") expect(result.row.id).toBe(1);
  });

  it("matches on the normalized form (punctuation, accents, inner spaces)", () => {
    const fees = resolveName("kids school fees", CATEGORIES);
    expect(fees).toMatchObject({ status: "resolved", matchedOn: "normalized" });
    if (fees.status === "resolved") expect(fees.row.id).toBe(4);

    const cafe = resolveName("cafe", CATEGORIES);
    expect(cafe).toMatchObject({ status: "resolved", matchedOn: "normalized" });
    if (cafe.status === "resolved") expect(cafe.row.id).toBe(5);
  });

  it("matches a UNIQUE prefix", () => {
    const result = resolveName("grocer", CATEGORIES);
    expect(result).toMatchObject({ status: "resolved", matchedOn: "prefix" });
    if (result.status === "resolved") expect(result.row.id).toBe(1);
  });

  it("matches a UNIQUE substring when no prefix does", () => {
    // "out" appears INSIDE "Dining Out" but does not start it, so the prefix
    // stage misses and the substring stage has to catch it.
    const inner = resolveName("out", CATEGORIES);
    expect(inner).toMatchObject({ status: "resolved", matchedOn: "substring" });
    if (inner.status === "resolved") expect(inner.row.id).toBe(3);
  });

  it("reports a leading fragment as a PREFIX, not a substring", () => {
    // "dining" starts "Dining Out", so the earlier stage of the ladder wins.
    // The stage that matched is reported, because the caller uses it to decide
    // how much to trust a fuzzy hit.
    const result = resolveName("dining", CATEGORIES);
    expect(result).toMatchObject({ status: "resolved", matchedOn: "prefix" });
    if (result.status === "resolved") expect(result.row.id).toBe(3);
  });

  it("prefers an exact match over a prefix of a longer name", () => {
    const rows: Resolvable[] = [
      { id: 1, name: "Gas" },
      { id: 2, name: "Gasoline & Tolls" },
    ];
    const result = resolveName("gas", rows);
    expect(result).toMatchObject({ status: "resolved", matchedOn: "exact" });
    if (result.status === "resolved") expect(result.row.id).toBe(1);
  });
});

describe("resolveName: never guesses", () => {
  it("reports AMBIGUOUS when a prefix hits two different rows", () => {
    const result = resolveName("g", CATEGORIES);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.matchedOn).toBe("prefix");
      expect(result.candidates.map((row) => row.id)).toEqual([1, 2]);
    }
  });

  it("reports AMBIGUOUS when two rows carry the same name", () => {
    const rows: Resolvable[] = [
      { id: 7, name: "Travel" },
      { id: 8, name: "travel" },
    ];
    const result = resolveName("Travel", rows);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.matchedOn).toBe("exact");
  });

  it("reports NOT-FOUND with the closest candidates", () => {
    const result = resolveName("grocery shopping", CATEGORIES);
    expect(result.status).toBe("not-found");
    if (result.status === "not-found") {
      expect(result.suggestions.map((row) => row.name)).toContain("Groceries");
    }
  });

  it("reports NOT-FOUND with no suggestions when nothing is close", () => {
    const result = resolveName("zzzzzzzz", CATEGORIES);
    expect(result).toMatchObject({ status: "not-found", suggestions: [] });
  });

  it("treats a blank name as not-found rather than matching every row", () => {
    expect(resolveName("   ", CATEGORIES)).toMatchObject({ status: "not-found" });
    expect(resolveName("", CATEGORIES)).toMatchObject({ status: "not-found" });
  });

  it("returns not-found against an empty candidate list", () => {
    expect(resolveName("Groceries", [])).toMatchObject({ status: "not-found", suggestions: [] });
  });
});

describe("resolveName: aliases", () => {
  const HOLDINGS: Resolvable[] = [
    { id: 1, name: "Commodities (Gold bars)", aliases: ["Gold bars", "Gold", "Commodities", "XAU"] },
    { id: 2, name: "Vehicles (Car)", aliases: ["Car", null, "Vehicles", undefined] },
  ];

  it("resolves through an alias", () => {
    const gold = resolveName("gold", HOLDINGS);
    expect(gold).toMatchObject({ status: "resolved" });
    if (gold.status === "resolved") expect(gold.row.id).toBe(1);

    const symbol = resolveName("XAU", HOLDINGS);
    expect(symbol).toMatchObject({ status: "resolved" });
    if (symbol.status === "resolved") expect(symbol.row.id).toBe(1);
  });

  it("two aliases of the SAME row are not a tie", () => {
    // "Gold bars" matches the name AND two aliases; still one row.
    const result = resolveName("gold bars", HOLDINGS);
    expect(result).toMatchObject({ status: "resolved" });
    if (result.status === "resolved") expect(result.row.id).toBe(1);
  });

  it("drops null and undefined aliases", () => {
    expect(namesOf(HOLDINGS[1])).toEqual(["Vehicles (Car)", "Car", "Vehicles"]);
  });
});

describe("the question we ask", () => {
  it("lists the tie for an ambiguous name and says nothing was saved", () => {
    const resolution = resolveName("g", CATEGORIES);
    const reply = describeResolution(resolution, "category", CATEGORIES);
    expect(reply).toBe(
      '"g" matches more than one category: Groceries or Gifts. Which one? Nothing was saved.',
    );
  });

  it("suggests the closest name for an unknown one", () => {
    const resolution = resolveName("grocery shopping", CATEGORIES);
    expect(describeResolution(resolution, "category", CATEGORIES)).toBe(
      'I don\'t have a category called "grocery shopping". Did you mean Groceries? Nothing was saved.',
    );
  });

  it("lists what exists when nothing is close", () => {
    const resolution = resolveName("zzzzzzzz", CATEGORIES);
    const reply = describeResolution(resolution, "category", CATEGORIES);
    expect(reply).toContain("Your category options are");
    expect(reply).toContain("Groceries");
    expect(reply).toContain("Nothing was saved.");
  });

  it("says so when there are no rows at all", () => {
    const resolution = resolveName("Groceries", []);
    expect(describeResolution(resolution, "account", [])).toContain("there are no account rows yet");
  });

  it("returns an empty string for a resolved name", () => {
    expect(describeResolution(resolveName("Rent", CATEGORIES), "category", CATEGORIES)).toBe("");
  });
});

describe("listNames", () => {
  it("joins with a trailing 'or' and caps the list", () => {
    expect(listNames(CATEGORIES.slice(0, 1))).toBe("Groceries");
    expect(listNames(CATEGORIES.slice(0, 2))).toBe("Groceries or Gifts");
    expect(listNames(CATEGORIES.slice(0, 3))).toBe("Groceries, Gifts or Dining Out");
    expect(listNames(CATEGORIES, 2)).toBe("Groceries or Gifts (+4 more)");
  });
});
