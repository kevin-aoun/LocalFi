/**
 * Tests for the em-dash codemod's transformation rules.
 *
 * Almost every fixture below is REAL TEXT copied out of this repository, with
 * the file it came from named above it. That matters: the rules were derived
 * from this codebase's prose, so a rule that only works on invented examples
 * has not been tested at all.
 *
 * The properties that must hold everywhere, whatever the rule, are pinned in
 * the last three describes: no dash survives a site the script claims to have
 * changed, no doubled or trailing whitespace is introduced, the line count is
 * preserved, and a second run is a no-op.
 */

import { describe, expect, it } from "vitest";
import {
  EM_DASH,
  EN_DASH,
  HORIZONTAL_BAR,
  type SiteKind,
  applyEdits,
  collisionProbes,
  findSegments,
  planSource,
} from "../strip-em-dashes-logic";

/** Transform a source string; `.tsx` when the fixture contains JSX. */
function run(source: string, fileName = "fixture.ts"): string {
  return planSource(source, fileName).transformed;
}

function rulesOf(source: string, fileName = "fixture.ts"): string[] {
  return planSource(source, fileName).changes.map((c) => c.rule);
}

function kindsOf(source: string, fileName = "fixture.ts"): SiteKind[] {
  return planSource(source, fileName).changes.map((c) => c.kind);
}

function skipsOf(source: string, fileName = "fixture.ts"): string[] {
  return planSource(source, fileName).skips.map((s) => s.reason);
}

/* ========================================================================== */
/* One test per replacement rule, using real text from this repo              */
/* ========================================================================== */

describe("rule 7: appositive -> colon", () => {
  // lib/reports.ts:70
  it("turns a trailing explanation into a colon", () => {
    const source = "/** The report period lengths — the same set budgets use, deliberately. */\n";
    expect(run(source)).toBe("/** The report period lengths: the same set budgets use, deliberately. */\n");
    expect(rulesOf(source)).toEqual(["appositive-colon"]);
  });

  it("is the default for anything the word lists do not recognise", () => {
    const source = "// Live metal prices — now a thin wrapper over the provider registry.\n";
    expect(run(source)).toBe("// Live metal prices: now a thin wrapper over the provider registry.\n");
  });
});

describe("rule 6: independent clause -> semicolon", () => {
  // The example from the brief.
  it("does not comma-splice two independent clauses", () => {
    const source = "// Nothing is re-derived here — that is what keeps this page honest\n";
    expect(run(source)).toBe("// Nothing is re-derived here; that is what keeps this page honest\n");
    expect(rulesOf(source)).toEqual(["clause-semicolon"]);
  });

  // app/actions/accounts.ts:6
  it("recognises a pronoun subject", () => {
    const source = " * The balance arithmetic is NOT here — it is in lib/cash-balance.ts\n";
    expect(run(`/**\n${source} */\n`)).toContain("is NOT here; it is in lib/cash-balance.ts");
  });

  // app/(dashboard)/page.tsx:388
  it("recognises an imperative aside", () => {
    const source = "// not part of this figure — see net worth instead\n";
    expect(run(source)).toBe("// not part of this figure; see net worth instead\n");
    expect(rulesOf(source)).toEqual(["clause-semicolon"]);
  });
});

describe("rule 5: connective -> comma", () => {
  // app/(dashboard)/recurring/recurring-client.tsx:646
  it("treats a contrast as a comma", () => {
    const source = "// posted on the day it was due — not lumped onto today.\n";
    expect(run(source)).toBe("// posted on the day it was due, not lumped onto today.\n");
    expect(rulesOf(source)).toEqual(["connective-comma"]);
  });

  // app/(dashboard)/page.tsx:348
  it("treats a coordinating conjunction as a comma", () => {
    const source = "// opening balances included — so this page agrees with /accounts\n";
    expect(run(source)).toBe("// opening balances included, so this page agrees with /accounts\n");
  });

  it("treats a relative pronoun as a comma", () => {
    const source = "// one pass over the ledger — which mirrors the same rows\n";
    expect(run(source)).toBe("// one pass over the ledger, which mirrors the same rows\n");
  });

  it("treats an appositive marker as a comma", () => {
    const source = "// the same set of periods — i.e. the ones budgets use\n";
    expect(run(source)).toBe("// the same set of periods, i.e. the ones budgets use\n");
  });
});

describe("rule 4: label separator -> colon", () => {
  // components/accounts/account-dialog.tsx:175
  it("rewrites a UI label in JSX text", () => {
    const source = '<SelectItem value="asset">Asset — money you hold</SelectItem>\n';
    expect(run(source, "f.tsx")).toBe('<SelectItem value="asset">Asset: money you hold</SelectItem>\n');
    expect(rulesOf(source, "f.tsx")).toEqual(["label-colon"]);
    expect(kindsOf(source, "f.tsx")).toEqual(["jsx"]);
  });

  // The brief's example.
  it("rewrites a figure label", () => {
    const source = 'const s = "Total — $4,496.18";\n';
    expect(run(source)).toBe('const s = "Total: $4,496.18";\n');
    expect(rulesOf(source)).toEqual(["label-colon"]);
  });

  // components/transactions/transfer-dialog.tsx:233
  it("rewrites a placeholder", () => {
    const source = 'placeholder="Optional — e.g. monthly savings"\n';
    expect(run(source, "f.tsx")).toContain('placeholder="Optional: e.g. monthly savings"');
  });

  // lib/agent/resolve.ts:15 — a numbered documentation list
  it("rewrites a documentation bullet", () => {
    const source = "/**\n *   1. exact       — case-insensitive, whitespace-trimmed\n */\n";
    expect(run(source)).toBe("/**\n *   1. exact: case-insensitive, whitespace-trimmed\n */\n");
    expect(rulesOf(source)).toEqual(["label-colon"]);
  });

  it("does NOT treat the JSDoc gutter as a bullet", () => {
    // ` * ` starts every JSDoc line. If `*` counted as a bullet marker, every
    // comment line would look like a label and the follower rules would never
    // run at all.
    const source = "/**\n * The balance arithmetic is NOT here — it is in lib/cash-balance.ts\n */\n";
    expect(rulesOf(source)).toEqual(["clause-semicolon"]);
  });

  it("does not treat flowing prose as a label", () => {
    const source = "/**\n * Some quite long sentence that runs on for a while — the explanation.\n */\n";
    expect(rulesOf(source)).toEqual(["appositive-colon"]);
  });
});

describe("rule 3: parenthetical pair", () => {
  // app/actions/crypto.ts:22
  it("turns a pair into commas", () => {
    const source = " * the write path for ANY live-priced holding — metal or coin — and they\n";
    expect(run(`/**\n${source} */\n`)).toContain(
      "the write path for ANY live-priced holding, metal or coin, and they",
    );
    expect(rulesOf(`/**\n${source} */\n`)).toEqual(["pair-commas", "pair-commas"]);
  });

  // components/transactions/__tests__/import-csv.test.ts:17
  it("uses parentheses when the enclosed span already contains a comma", () => {
    const source = "// the serial 46024 — 2 January 2026, US order — before our code sees it.\n";
    expect(run(source)).toBe("// the serial 46024 (2 January 2026, US order) before our code sees it.\n");
    expect(rulesOf(source)).toEqual(["pair-parens", "pair-parens"]);
  });

  // components/accounts/account-form-logic.ts:6-8 — a pair spanning three lines
  it("pairs across lines inside one block comment", () => {
    const source = [
      "/**",
      ' * would be expensive to get wrong — the asset/liability sign, "the user left the',
      ' * opening balance blank" vs "the user typed 0", and every cents→string',
      " * conversion — so it lives outside the component and is covered by",
      " */",
      "",
    ].join("\n");
    const out = run(source);
    expect(out).toContain("would be expensive to get wrong (the asset/liability sign");
    expect(out).toContain("conversion) so it lives outside the component");
    expect(rulesOf(source)).toEqual(["pair-parens", "pair-parens"]);
  });

  it("distinguishes a pair from a single trailing dash", () => {
    const pair = "// the figures — all of them — come from one place\n";
    const single = "// the figures come from one place — all of them\n";
    expect(run(pair)).toBe("// the figures, all of them, come from one place\n");
    expect(rulesOf(pair)).toEqual(["pair-commas", "pair-commas"]);
    expect(run(single)).toBe("// the figures come from one place: all of them\n");
    expect(rulesOf(single)).toEqual(["appositive-colon"]);
  });

  it("does not pair two dashes separated by a sentence break", () => {
    const source = "// something here — an aside. Another sentence — and its own aside\n";
    expect(rulesOf(source)).toEqual(["appositive-colon", "connective-comma"]);
  });

  it("does not pair two dashes that belong to adjacent bullets", () => {
    // components/transactions/ledger-summary-logic.ts:55-56
    const source = [
      "/**",
      " *   - transfers (`isTransfer`) — they are movements, not spend;",
      " *   - pending rows (`isSpendable`) — same rule that keeps them out",
      " */",
      "",
    ].join("\n");
    expect(rulesOf(source)).toEqual(["label-colon", "label-colon"]);
    expect(run(source)).toContain("- transfers (`isTransfer`): they are movements, not spend;");
  });

  it("keeps a long but genuine parenthetical together", () => {
    // components/reports/export-card.tsx:283-284 — 106 characters between dashes
    const source = [
      "/**",
      " * Every table — accounts, categories, transactions, budgets, recurring",
      " * templates, assets, net-worth snapshots and settings — as readable JSON.",
      " */",
      "",
    ].join("\n");
    // Kept as ONE parenthetical rather than split into two asides; the comma
    // in the enclosed list is what selects parentheses over commas.
    expect(rulesOf(source)).toEqual(["pair-parens", "pair-parens"]);
    expect(run(source)).toContain("Every table (accounts, categories, transactions, budgets, recurring");
    expect(run(source)).toContain("net-worth snapshots and settings) as readable JSON.");
  });
});

describe("rule 2: ranges", () => {
  // lib/history/prices.ts:359
  it("turns a tight numeric range into a hyphen, not a comma", () => {
    const source = ` * the keyless tier allows roughly 5${EN_DASH}15 requests a minute\n`;
    expect(run(`/**\n${source} */\n`)).toContain("roughly 5-15 requests a minute");
    expect(rulesOf(`/**\n${source} */\n`)).toEqual(["range"]);
  });

  it("handles a year range", () => {
    const source = `// covering 2020${EM_DASH}2024 inclusive\n`;
    expect(run(source)).toBe("// covering 2020-2024 inclusive\n");
    expect(rulesOf(source)).toEqual(["range"]);
  });

  // components/reports/report-view-logic.ts:168
  it("treats an en dash between two interpolated values as a range", () => {
    const source = "const label = `${start} – ${end}`;\n";
    expect(run(source)).toBe("const label = `${start} - ${end}`;\n");
    expect(rulesOf(source)).toEqual(["range"]);
  });

  // lib/agent/slash.ts:505 — the same shape, but an EM dash, which is a label
  it("treats an em dash between two interpolated values as a label separator", () => {
    const source = "lines.push(`${spec.usage} — ${spec.summary}`);\n";
    expect(run(source)).toBe("lines.push(`${spec.usage}: ${spec.summary}`);\n");
  });

  it("does not mistake a spaced dash between numbers for a range", () => {
    // components/transactions/import-logic.ts:118 — "46024 — 2 January 2026"
    // is an apposition, not a range. Only a TIGHT dash is a range.
    const source = "// converts it into the serial 46024 — 2 January 2026 and stops\n";
    expect(rulesOf(source)).toEqual(["appositive-colon"]);
    expect(run(source)).toContain("serial 46024: 2 January 2026");
  });
});

/* ========================================================================== */
/* Site classification: comment vs string vs JSX                              */
/* ========================================================================== */

describe("site classification", () => {
  it("classifies a dash in a block comment", () => {
    expect(kindsOf("/** a b — the reason */\n")).toEqual(["comment"]);
  });

  it("classifies a dash in a line comment", () => {
    expect(kindsOf("// a b — the reason\n")).toEqual(["comment"]);
  });

  it("classifies a dash in a string literal", () => {
    expect(kindsOf('const s = "a value — the reason";\n')).toEqual(["string"]);
  });

  it("classifies a dash in a template literal", () => {
    expect(kindsOf("const s = `a value — ${reason}`;\n")).toEqual(["string"]);
  });

  it("classifies a dash in JSX text", () => {
    expect(kindsOf("const x = <p>a value — the reason</p>;\n", "f.tsx")).toEqual(["jsx"]);
  });

  it("finds a comment inside a JSX expression container", () => {
    // app/(dashboard)/page.tsx:347 — `{/* ... */}` has no child token, so a
    // naive trivia walk misses it entirely.
    const source = "const x = <div>{/* THE headline — assets and liabilities */}</div>;\n";
    expect(kindsOf(source, "f.tsx")).toEqual(["comment"]);
    expect(run(source, "f.tsx")).toContain("{/* THE headline: assets and liabilities */}");
  });

  it("finds a comment attached to a union type member", () => {
    // components/transactions/import-logic.ts:61 — the comment sits in the
    // trivia of the `|` token, which `forEachChild` never visits.
    const source = [
      "export type E =",
      '  | "day-first"',
      "  /** Both patterns appear — the file is internally inconsistent. */",
      '  | "conflict";',
      "",
    ].join("\n");
    expect(kindsOf(source)).toEqual(["comment"]);
    expect(run(source)).toContain("Both patterns appear: the file is internally inconsistent.");
  });

  it("merges consecutive line comments so a wrapped sentence is seen whole", () => {
    // app/(dashboard)/budgets/budgets-client.tsx:318 — the dash ends one `//`
    // line and its follower is on the next.
    const source = [
      "// `deleteCategory` REFUSES when transactions still reference it —",
      "// they must be reassigned first.",
      "",
    ].join("\n");
    expect(run(source)).toBe(
      ["// `deleteCategory` REFUSES when transactions still reference it;", "// they must be reassigned first.", ""].join(
        "\n",
      ),
    );
    expect(rulesOf(source)).toEqual(["clause-semicolon"]);
  });

  it("supports --only by filtering site kinds", () => {
    const source = ['const s = "a value — the reason";', "// a comment — the reason", ""].join("\n");
    const stringsOnly = planSource(source, "f.ts", { kinds: new Set<SiteKind>(["string"]) });
    expect(stringsOnly.changes.map((c) => c.kind)).toEqual(["string"]);
    expect(stringsOnly.skips.map((s) => s.reason)).toEqual(["filtered-kind"]);
    expect(stringsOnly.transformed).toContain("// a comment — the reason");

    const commentsOnly = planSource(source, "f.ts", { kinds: new Set<SiteKind>(["comment"]) });
    expect(commentsOnly.changes.map((c) => c.kind)).toEqual(["comment"]);
    expect(commentsOnly.transformed).toContain('"a value — the reason"');
  });
});

/* ========================================================================== */
/* En dashes and horizontal bars                                              */
/* ========================================================================== */

describe("other dash characters", () => {
  it("handles en dashes", () => {
    // lib/db/client.ts:31
    const source = "/**\n * - `BUDGET_DB_PATH` – override the database file location.\n */\n";
    expect(run(source)).toContain("- `BUDGET_DB_PATH`: override the database file location.");
    expect(planSource(source, "f.ts").changes[0].dash).toBe("en");
  });

  it("handles horizontal bars", () => {
    const source = `// the figure ${HORIZONTAL_BAR} the one the dashboard prints\n`;
    expect(run(source)).toBe("// the figure: the one the dashboard prints\n");
    expect(planSource(source, "f.ts").changes[0].dash).toBe("bar");
  });

  it("counts each dash character separately", () => {
    const source = `// a ${EM_DASH} b\n// c ${EN_DASH} d\n// e ${HORIZONTAL_BAR} f\n`;
    expect(planSource(source, "f.ts").totals).toEqual({ em: 1, en: 1, bar: 1 });
  });

  it("supports --dashes by filtering dash characters", () => {
    const source = `// a ${EM_DASH} b\n// c ${EN_DASH} d\n`;
    const plan = planSource(source, "f.ts", { dashes: new Set(["em" as const]) });
    expect(plan.changes.map((c) => c.dash)).toEqual(["em"]);
    expect(plan.skips.map((s) => s.reason)).toEqual(["filtered-dash"]);
    expect(plan.transformed).toContain(`c ${EN_DASH} d`);
  });
});

/* ========================================================================== */
/* Code that must NOT be touched                                              */
/* ========================================================================== */

describe("never corrupts code", () => {
  const untouched = (source: string, reason: string, fileName = "fixture.ts") => {
    const plan = planSource(source, fileName);
    expect(plan.transformed).toBe(source);
    expect(plan.changes).toEqual([]);
    expect(plan.skips.map((s) => s.reason)).toContain(reason);
  };

  it("leaves an import path alone", () => {
    untouched('import x from "./weird—name";\n', "module-specifier");
  });

  it("leaves a dynamic import and a require alone", () => {
    untouched('const a = await import("./weird—name");\n', "module-specifier");
    untouched('const b = require("./weird—name");\n', "module-specifier");
  });

  it("leaves a regular expression alone", () => {
    // lib/agent/__tests__/slash.test.ts:426
    const source = "expect(help).not.toMatch(/\\/budget — Rent/);\n";
    const plan = planSource(source, "f.ts");
    expect(plan.transformed).toBe(source);
    expect(plan.changes).toEqual([]);
  });

  it("leaves a string literal type alone", () => {
    untouched('type Mode = "a—b" | "c";\n', "type-literal");
  });

  it("leaves an object key and an element access alone", () => {
    untouched('const o = { "a—b": 1 };\n', "property-key");
    untouched('const v = o["a—b"];\n', "property-key");
  });

  it("leaves a data-* attribute alone", () => {
    untouched('const x = <div data-state="a—b" />;\n', "jsx-attribute", "f.tsx");
  });

  it("leaves className, key and href alone", () => {
    untouched('const x = <a className="a—b" />;\n', "jsx-attribute", "f.tsx");
    untouched('const x = <a key="a—b" />;\n', "jsx-attribute", "f.tsx");
    untouched('const x = <a href="/a—b" />;\n', "jsx-attribute", "f.tsx");
  });

  it("still rewrites user-facing attributes", () => {
    // components/accounts/account-group.tsx:159
    const source = '<button title="Delete — only possible while the account has no transactions" />\n';
    expect(run(source, "f.tsx")).toContain('title="Delete: only possible while the account has no transactions"');
  });

  it("leaves a dash inside a template expression alone", () => {
    // The dash is in CODE between `${` and `}`, not in the literal text.
    const source = 'const s = `value ${map["a—b"]} end`;\n';
    const plan = planSource(source, "f.ts");
    expect(plan.transformed).toBe(source);
    expect(plan.skips.map((s) => s.reason)).toContain("property-key");
  });

  it("accounts for every dash in the file, leaving none unclassified", () => {
    const source = [
      'import x from "./a—b";',
      "// a comment — the reason",
      'const s = "a string — the reason";',
      "const re = /a—b/;",
      "",
    ].join("\n");
    const plan = planSource(source, "f.ts");
    const total = plan.totals.em + plan.totals.en + plan.totals.bar;
    expect(plan.changes.length + plan.skips.length).toBe(total);
  });
});

/* ========================================================================== */
/* The glyph rule: a dash used as a value                                     */
/* ========================================================================== */

describe("dashes used as a value, not as punctuation", () => {
  it("leaves the em-dash placeholder alone", () => {
    // components/recurring/recurring-form-logic.ts:33, lib/reports.ts:315
    const source = 'export const NO_DATE = "—";\n';
    expect(run(source)).toBe(source);
    expect(skipsOf(source)).toEqual(["glyph"]);
  });

  it("leaves a placeholder in a conditional alone", () => {
    // components/reports/comparison-card.tsx:71
    const source = 'const v = previousHasData ? formatMoney(previousCents) : "—";\n';
    expect(run(source)).toBe(source);
  });

  it("leaves a separator constant alone", () => {
    // lib/agent/slash.ts:92 — rewriting this would break three assertions in
    // lib/agent/__tests__/slash.test.ts.
    const source = 'const NOTE_SEPARATOR = " — ";\n';
    expect(run(source)).toBe(source);
    expect(skipsOf(source)).toEqual(["glyph"]);
  });

  it("leaves a dash that a COMMENT is quoting rather than using", () => {
    // lib/reports.ts:310 — the comment is describing the placeholder glyph.
    // Rewriting it to `":"` would document the code incorrectly.
    const source = '/** A percentage string, or "—" when there is no number. */\n';
    expect(run(source)).toBe(source);
    expect(skipsOf(source)).toEqual(["glyph"]);
  });

  it("leaves a dash inside inline code in a comment alone", () => {
    // components/assets/currency-totals.ts
    const source = "/** `12.34%`, or `—` when the share is undefined. */\n";
    expect(run(source)).toBe(source);
    expect(skipsOf(source)).toEqual(["glyph"]);
  });

  it("still rewrites a real dash on a line that also quotes the glyph", () => {
    const source = '// Callers render "—" — the share is undefined there.\n';
    const plan = planSource(source, "f.ts");
    expect(plan.changes).toHaveLength(1);
    expect(plan.skips.map((s) => s.reason)).toEqual(["glyph"]);
    expect(plan.transformed).toBe('// Callers render "—": the share is undefined there.\n');
  });

  it("leaves a dash-only JSX cell alone", () => {
    const source = "const x = <td>—</td>;\n";
    expect(run(source, "f.tsx")).toBe(source);
    expect(skipsOf(source, "f.tsx")).toEqual(["glyph"]);
  });
});

/* ========================================================================== */
/* Line-structure and whitespace invariants                                   */
/* ========================================================================== */

describe("whitespace and line structure", () => {
  it("attaches punctuation to the previous line when the dash opens a line", () => {
    // app/actions/settings.ts:60 — the opening dash of a pair starts its line.
    const source = [
      "/**",
      " * There was no transaction, so a failure part-way through the loop",
      " * — a float amount reaching `assertCents`, a constraint, anything — left the",
      " * in-memory database with the deletion applied.",
      " */",
      "",
    ].join("\n");
    const out = run(source);
    expect(out.split("\n")).toEqual([
      "/**",
      " * There was no transaction, so a failure part-way through the loop",
      " * (a float amount reaching `assertCents`, a constraint, anything) left the",
      " * in-memory database with the deletion applied.",
      " */",
      "",
    ]);
    // The `*` gutter survived and no line was joined.
    expect(out.split("\n").length).toBe(source.split("\n").length);
  });

  it("leaves no trailing space when the dash ends a line", () => {
    // components/budgets/__tests__/budget-view-logic.test.ts:301
    const source = [
      "/**",
      ' * income is not spending, so the "income target" idea is gone —',
      " * the row still renders.",
      " */",
      "",
    ].join("\n");
    const out = run(source);
    expect(out).toContain('idea is gone:\n * the row still renders.');
    for (const line of out.split("\n")) expect(line).toBe(line.replace(/[ \t]+$/, ""));
  });

  it("never introduces a doubled space", () => {
    const source = "// a value  —  the reason\n";
    expect(run(source)).toBe("// a value: the reason\n");
    expect(run(source)).not.toMatch(/ {2}/);
  });

  it("attaches to the preceding word even across a string boundary", () => {
    // components/transactions/import-dialog.tsx:406 — the fragment is
    // concatenated after other text, so the colon must not keep its leading
    // space.
    const source = 'const s = dayFirst ? " — day first" : " — month first";\n';
    expect(run(source)).toBe('const s = dayFirst ? ": day first" : ": month first";\n');
  });

  it("does not add a trailing space inside a string that ended with the dash", () => {
    const source = 'const s = "a value —";\n';
    expect(run(source)).toBe('const s = "a value:";\n');
  });

  it("preserves the line count on every fixture in this file", () => {
    const fixtures = [
      "// a — b\n",
      "/**\n * a —\n * b\n */\n",
      'const s = "a — b";\n',
      "const x = <p>a — b</p>;\n",
    ];
    for (const fixture of fixtures) {
      const plan = planSource(fixture, fixture.includes("<p>") ? "f.tsx" : "f.ts");
      expect(plan.transformed.split("\n").length).toBe(fixture.split("\n").length);
    }
  });
});

/* ========================================================================== */
/* Idempotency                                                                */
/* ========================================================================== */

describe("idempotency", () => {
  const fixtures: [string, string][] = [
    ["comment", "// Nothing is re-derived here — that is what keeps this page honest\n"],
    ["pair", "// the figures — all of them — come from one place\n"],
    ["parens", "// the serial 46024 — 2 January 2026, US order — before our code sees it.\n"],
    ["string", 'const s = "Total — $4,496.18";\n'],
    ["jsx", "const x = <p>Asset — money you hold</p>;\n"],
    ["range", `// covering 2020${EM_DASH}2024 inclusive\n`],
    ["glyph", 'const NO_DATE = "—";\n'],
    ["import", 'import x from "./a—b";\n'],
    ["block", "/**\n * a value —\n * the reason it exists — and why\n */\n"],
  ];

  for (const [name, source] of fixtures) {
    it(`is a no-op on the second run: ${name}`, () => {
      const fileName = source.includes("<p>") ? "f.tsx" : "f.ts";
      const once = planSource(source, fileName).transformed;
      const twice = planSource(once, fileName);
      expect(twice.transformed).toBe(once);
      expect(twice.changes).toEqual([]);
    });
  }

  it("leaves no target dash behind at a site it reported as changed", () => {
    const source = [
      "/**",
      " * The report period lengths — the same set budgets use, deliberately.",
      " * the write path for ANY holding — metal or coin — and they record it.",
      " */",
      'const s = "Total — $4,496.18";',
      "",
    ].join("\n");
    const plan = planSource(source, "f.ts");
    expect(plan.changes.length).toBe(4);
    // Every dash that was not explicitly skipped is gone.
    const remaining = (plan.transformed.match(/[—–―]/g) ?? []).length;
    expect(remaining).toBe(plan.skips.length);
  });
});

/* ========================================================================== */
/* Supporting machinery                                                       */
/* ========================================================================== */

describe("applyEdits", () => {
  it("applies overlapping-free edits right to left", () => {
    expect(applyEdits("abcdef", [{ start: 1, end: 2, text: "X" }, { start: 4, end: 5, text: "Y" }])).toBe("aXcdYf");
  });

  it("is a no-op with no edits", () => {
    expect(applyEdits("abc", [])).toBe("abc");
  });
});

describe("findSegments", () => {
  it("excludes the comment and quote delimiters from the reported range", () => {
    const source = '/** hi */\nconst s = "yo";\n';
    const segments = findSegments(source, "f.ts");
    const texts = segments.map((s) => source.slice(s.start, s.end));
    expect(texts).toContain(" hi ");
    expect(texts).toContain("yo");
  });

  it("excludes the interpolation delimiters of a template literal", () => {
    const source = "const s = `a ${x} b`;\n";
    const texts = findSegments(source, "f.ts").map((s) => source.slice(s.start, s.end));
    expect(texts).toContain("a ");
    expect(texts).toContain(" b");
  });
});

describe("collisionProbes", () => {
  it("returns a window with real text on both sides of the dash", () => {
    const source = 'const s = "Filtered view — 1 of 4 holdings hidden";\n';
    const probes = collisionProbes(source, "f.ts").map((p) => p.probe);
    expect(probes).toHaveLength(1);
    expect(probes[0]).toContain("Filtered view");
    expect(probes[0]).toContain("holdings hidden");
  });

  it("drops probes too short to identify one specific string", () => {
    // `"— so"` matches half the test suite; reporting it is worse than useless.
    const source = 'const s = "a — so";\n';
    expect(collisionProbes(source, "f.ts")).toEqual([]);
  });

  it("ignores dashes in comments, which cannot break a test", () => {
    expect(collisionProbes("// a long comment — with a dash in it\n", "f.ts")).toEqual([]);
  });
});

/* ========================================================================== */
/* Rule 8: a colon must not land on a line that already has one               */
/* ========================================================================== */

describe("avoids stacking a second colon on one line", () => {
  it("steps down to a comma inside an interpolated log line", () => {
    // lib/prices.ts:83 — the whole point of the rule. Clamping the search to
    // the template SPAN would see only " — " and miss the collision.
    const source =
      "const m = `[prices] ${type}: ${code} " + EM_DASH + " ${message}`;\n";
    const plan = planSource(source, "f.ts");
    expect(plan.transformed).toBe("const m = `[prices] ${type}: ${code}, ${message}`;\n");
    expect(plan.changes.map((c) => c.rule)).toEqual(["connective-comma"]);
  });

  it("steps down to a semicolon when a comma would splice", () => {
    const source = "const m = `${a}: ${b} " + EM_DASH + " it is already priced`;\n";
    const plan = planSource(source, "f.ts");
    expect(plan.transformed).toBe("const m = `${a}: ${b}; it is already priced`;\n");
    expect(plan.changes.map((c) => c.rule)).toEqual(["clause-semicolon"]);
  });

  it("still uses a colon when the line has none", () => {
    const source = "const m = `${a} ${b} " + EM_DASH + " the rest`;\n";
    const plan = planSource(source, "f.ts");
    expect(plan.transformed).toBe("const m = `${a} ${b}: the rest`;\n");
    expect(plan.changes.map((c) => c.rule)).toEqual(["appositive-colon"]);
  });

  it("ignores a colon that belongs to the CODE around a plain string", () => {
    // The reader of "in credit — overpaid" never sees the `note:` key, so it is
    // not a collision. components/accounts/account-form-logic.ts
    const source = 'const o = { note: "in credit ' + EM_DASH + ' overpaid" };\n';
    const plan = planSource(source, "f.ts");
    expect(plan.transformed).toBe('const o = { note: "in credit: overpaid" };\n');
    // `label-colon`, not `appositive-colon`: "in credit" is a short leading
    // label. Either way the point stands — a colon rule was allowed to fire.
    expect(plan.changes.map((c) => c.rule)).toEqual(["label-colon"]);
  });

  it("does not treat a colon on a previous JSDoc line as a collision", () => {
    const source = `/**\n * Heading: something.\n * A clause ${EM_DASH} the rest of it.\n */\n`;
    const plan = planSource(source, "f.ts");
    expect(plan.transformed).toContain("A clause: the rest of it.");
  });
});
