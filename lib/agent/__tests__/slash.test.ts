/**
 * The slash-command router.
 *
 * The property that matters is NOT "parseSlash returned an object shaped roughly
 * like a tool call" — it is that the emitted `arguments` survive the REAL zod
 * schema in `tools.ts`. A router that emits `{ amount: 12000 }` (cents) instead
 * of `"120.00"` (decimal string) looks fine in a shallow assertion and posts a
 * $120,000 transaction in production. So every tool-producing case here is parsed
 * with the tool's own schema, and the parsed CENTS are asserted.
 *
 * The other recurring hazard is falsy zero: `/ccmax 0` must post $0.00, not fall
 * back to the stored $100.00. Four falsy-zero bugs have been found in this
 * codebase; two tests below exist solely to keep this from being the fifth.
 */
import { describe, expect, it } from "vitest";

import {
  addTransaction,
  budgetStatus,
  findTool,
  getBalances,
  listRecent,
  refreshPrices,
  spendSummary,
  undoLast,
} from "@/lib/agent/tools";
import type { ToolCall } from "@/lib/agent/tool-schema";
import {
  BUILT_IN_SLASH_COMMANDS,
  COMMENT_MAX_LENGTH,
  parseSlash,
  slashHelpText,
  suggestSlashCommand,
  type QuickCommandLike,
  type SlashResult,
} from "@/lib/agent/slash";
import { parseAmount } from "@/lib/money";
import { todayKey } from "@/lib/dates";

// The owner's real shortcuts. `/salary` is stored WITHOUT a leading slash and
// `/ccmax` WITH one, because the settings UI renders `/{cmd.command}` while
// nothing stops a user from typing the slash into the field — both must work.
const QUICKS: QuickCommandLike[] = [
  { command: "salary", categoryName: "Salary", amountCents: 140_000, comment: "at work" },
  {
    command: "/ccmax",
    categoryName: "Subscriptions",
    amountCents: 10_000,
    comment: "Claude Code (Max)",
  },
];

/** Narrow to a tool result, failing loudly with the actual result if it is not. */
function expectTool(result: SlashResult | null): ToolCall {
  if (!result || result.kind !== "tool") {
    throw new Error(`expected a tool call, got ${JSON.stringify(result)}`);
  }
  return result.call;
}

/** Parse the emitted arguments with the tool's OWN schema. This is the point. */
function parseWithRealSchema(call: ToolCall): Record<string, unknown> {
  const tool = findTool(call.name);
  if (!tool) throw new Error(`emitted an unknown tool name: ${call.name}`);
  return tool.parameters.parse(call.arguments) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Routing: slash vs model
// ---------------------------------------------------------------------------

describe("routing", () => {
  it("returns null for anything that does not start with a slash, so the model gets it", () => {
    for (const input of [
      "10 groceries",
      "how much did I spend on dining",
      "",
      "   ",
      "undo",
      "yes",
      "what is my balance?",
      "5/10 for lunch",
    ]) {
      expect(parseSlash(input, QUICKS)).toBeNull();
    }
  });

  it("claims every message that starts with a slash, even a nonsense one", () => {
    // The whole point of the binary split: a leading "/" means "be
    // deterministic", so an unrecognized command must NOT fall through.
    for (const input of ["/nope", "/", "//", "/usr/bin/env"]) {
      expect(parseSlash(input, QUICKS)).not.toBeNull();
    }
  });

  it("ignores leading and trailing whitespace", () => {
    expect(expectTool(parseSlash("   /balance   ", QUICKS)).name).toBe("get_balances");
    const call = expectTool(parseSlash("\t/ccmax  120   annual plan  \n", QUICKS));
    expect(call.arguments.amount).toBe("120.00");
    expect(call.arguments.comment).toBe("Claude Code (Max) — annual plan");
  });

  it("is case-insensitive for built-ins and for quick commands", () => {
    expect(expectTool(parseSlash("/Balance", QUICKS)).name).toBe("get_balances");
    expect(expectTool(parseSlash("/BALANCES", QUICKS)).name).toBe("get_balances");
    expect(expectTool(parseSlash("/Recent 3", QUICKS)).arguments.limit).toBe(3);
    const quick = expectTool(parseSlash("/CCMax 120", QUICKS));
    expect(quick.name).toBe("add_transaction");
    expect(quick.arguments.category).toBe("Subscriptions");
  });

  it("treats a bare slash as an error, not as an unknown command", () => {
    const result = parseSlash("/", QUICKS);
    expect(result?.kind).toBe("error");
    // The message has to tell the user what to do next.
    expect((result as { message: string }).message).toMatch(/help/i);
  });
});

// ---------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------

describe("built-in commands", () => {
  const cases: ReadonlyArray<[input: string, tool: string]> = [
    ["/balance", "get_balances"],
    ["/balances", "get_balances"],
    ["/recent", "list_recent"],
    ["/budget", "budget_status"],
    ["/spend", "spend_summary"],
    ["/prices", "refresh_prices"],
    ["/undo", "undo_last"],
  ];

  it.each(cases)("%s selects %s with schema-valid arguments", (input, name) => {
    const call = expectTool(parseSlash(input, QUICKS));
    expect(call.name).toBe(name);
    expect(() => parseWithRealSchema(call)).not.toThrow();
  });

  it("every built-in either names a real tool or is deliberately not a tool", () => {
    for (const spec of BUILT_IN_SLASH_COMMANDS) {
      if (spec.tool !== null) {
        expect(findTool(spec.tool), `${spec.names[0]} -> ${spec.tool}`).toBeDefined();
      }
    }
  });

  it("/balance takes no arguments and says so rather than silently dropping them", () => {
    // Silently ignoring the tail is how "/undo 3" becomes a single undo and the
    // user believes three rows are gone.
    for (const input of ["/balance today", "/undo 3", "/prices gold", "/yes please"]) {
      const result = parseSlash(input, QUICKS);
      expect(result?.kind, input).toBe("error");
      expect((result as { message: string }).message).toMatch(/no arguments|takes no/i);
    }
  });

  it("/recent defaults to 5", () => {
    const args = listRecent.parameters.parse(expectTool(parseSlash("/recent", QUICKS)).arguments);
    expect(args.limit).toBe(5);
  });

  it("/recent 12 passes 12 through as a number the schema accepts", () => {
    const call = expectTool(parseSlash("/recent 12", QUICKS));
    expect(call.arguments).toEqual({ limit: 12 });
    expect(listRecent.parameters.parse(call.arguments).limit).toBe(12);
  });

  it("/recent abc is REJECTED, not silently 5", () => {
    const result = parseSlash("/recent abc", QUICKS);
    expect(result?.kind).toBe("error");
    expect((result as { message: string }).message).toMatch(/abc/);
    // The dangerous failure mode: quietly becoming the default.
    expect(result).not.toMatchObject({ kind: "tool" });
  });

  it("/recent rejects non-integers and junk after the number", () => {
    for (const input of ["/recent 1.5", "/recent -3", "/recent 5x", "/recent 5 6"]) {
      expect(parseSlash(input, QUICKS)?.kind, input).toBe("error");
    }
  });

  it("leaves the 1-20 range to the tool schema, the single validation boundary", () => {
    const call = expectTool(parseSlash("/recent 99", QUICKS));
    expect(call.arguments).toEqual({ limit: 99 });
    // Deliberate: slash does not clamp. The schema is what rejects it, so there
    // is exactly one place the bound is written down.
    expect(() => listRecent.parameters.parse(call.arguments)).toThrow();
  });

  it("/budget with and without a category", () => {
    expect(budgetStatus.parameters.parse(expectTool(parseSlash("/budget", QUICKS)).arguments))
      .toEqual({});
    expect(
      budgetStatus.parameters.parse(expectTool(parseSlash("/budget Dining Out", QUICKS)).arguments),
    ).toEqual({ category: "Dining Out" });
  });

  it("/spend splits a leading period phrase from the category", () => {
    const cases: ReadonlyArray<[string, { period?: string; category?: string }]> = [
      ["/spend", {}],
      ["/spend dining", { category: "dining" }],
      ["/spend last month", { period: "last month" }],
      ["/spend last month dining", { period: "last month", category: "dining" }],
      ["/spend this week Dining Out", { period: "this week", category: "Dining Out" }],
      ["/spend last 30 days groceries", { period: "last 30 days", category: "groceries" }],
      ["/spend today", { period: "today" }],
      ["/spend this year", { period: "this year" }],
    ];
    for (const [input, expected] of cases) {
      const call = expectTool(parseSlash(input, QUICKS));
      expect(call.name).toBe("spend_summary");
      expect(spendSummary.parameters.parse(call.arguments), input).toEqual(expected);
    }
  });

  it("never emits an empty-string category, which the schema would reject", () => {
    for (const input of ["/budget", "/spend", "/spend last month"]) {
      const call = expectTool(parseSlash(input, QUICKS));
      expect(call.arguments.category, input).toBeUndefined();
      expect(() => parseWithRealSchema(call)).not.toThrow();
    }
  });

  it("/yes and /no are confirmations, not tools — slash never executes", () => {
    for (const input of ["/yes", "/y", "/Y"]) {
      expect(parseSlash(input, QUICKS)).toEqual({ kind: "confirm", decision: "yes" });
    }
    for (const input of ["/no", "/n", "/cancel", "/CANCEL"]) {
      expect(parseSlash(input, QUICKS)).toEqual({ kind: "confirm", decision: "no" });
    }
  });

  it("the no-parameter tools emit {} and not a stray argument", () => {
    for (const [input, schema] of [
      ["/balance", getBalances],
      ["/prices", refreshPrices],
      ["/undo", undoLast],
    ] as const) {
      const call = expectTool(parseSlash(input, QUICKS));
      expect(call.arguments).toEqual({});
      expect(schema.parameters.parse(call.arguments)).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// Quick commands
// ---------------------------------------------------------------------------

describe("quick commands", () => {
  it("fires with the stored category, amount and comment", () => {
    const call = expectTool(parseSlash("/salary", QUICKS));
    expect(call.name).toBe("add_transaction");
    expect(call.arguments).toEqual({
      amount: "1400.00",
      category: "Salary",
      comment: "at work",
    });
    const args = addTransaction.parameters.parse(call.arguments);
    expect(args.amount).toBe(140_000); // integer cents, exactly the stored value
    expect(args.category).toBe("Salary");
  });

  it("works whether the row stores the leading slash or not", () => {
    expect(expectTool(parseSlash("/salary", QUICKS)).arguments.category).toBe("Salary");
    expect(expectTool(parseSlash("/ccmax", QUICKS)).arguments.category).toBe("Subscriptions");
  });

  it("an amount argument overrides the stored amount", () => {
    const args = addTransaction.parameters.parse(
      expectTool(parseSlash("/ccmax 120", QUICKS)).arguments,
    );
    expect(args.amount).toBe(12_000);
    expect(args.comment).toBe("Claude Code (Max)");
  });

  it("an override of 0 posts $0.00 — zero is a value, not 'absent'", () => {
    const call = expectTool(parseSlash("/ccmax 0", QUICKS));
    expect(call.arguments.amount).toBe("0.00");
    const args = addTransaction.parameters.parse(call.arguments);
    expect(args.amount).toBe(0);
    // The bug this guards: falling back to the stored 10_000.
    expect(args.amount).not.toBe(10_000);
  });

  it("an override of 0.00 and of $0 are also real zeroes", () => {
    for (const input of ["/ccmax 0.00", "/ccmax $0", "/ccmax 0.001"]) {
      const args = addTransaction.parameters.parse(expectTool(parseSlash(input, QUICKS)).arguments);
      expect(args.amount, input).toBe(0);
    }
  });

  it("an override of 1,234.56 keeps every cent", () => {
    const call = expectTool(parseSlash("/salary 1,234.56", QUICKS));
    // Grouping is normalized out on the wire; the value is not touched.
    expect(call.arguments.amount).toBe("1234.56");
    expect(addTransaction.parameters.parse(call.arguments).amount).toBe(123_456);
  });

  it("accepts the decorated amounts parseAmount already handles", () => {
    const cases: ReadonlyArray<[string, number]> = [
      ["/ccmax 120", 12_000],
      ["/ccmax 120.5", 12_050],
      ["/ccmax $120.50", 12_050],
      ["/ccmax 2.675", 268], // half away from zero, not float-truncated to 267
      ["/ccmax 1,234", 123_400],
    ];
    for (const [input, cents] of cases) {
      const args = addTransaction.parameters.parse(expectTool(parseSlash(input, QUICKS)).arguments);
      expect(args.amount, input).toBe(cents);
    }
  });

  it("appends a trailing note to the stored comment", () => {
    const args = addTransaction.parameters.parse(
      expectTool(parseSlash("/ccmax 120 annual plan", QUICKS)).arguments,
    );
    // APPEND, not replace: the stored comment is what identifies the row in the
    // ledger; the note is the occasion.
    expect(args.comment).toBe("Claude Code (Max) — annual plan");
  });

  it("takes a note without an amount, keeping the stored amount", () => {
    const args = addTransaction.parameters.parse(
      expectTool(parseSlash("/salary bonus month", QUICKS)).arguments,
    );
    expect(args.amount).toBe(140_000);
    expect(args.comment).toBe("at work — bonus month");
  });

  it("uses the note alone when the stored comment is empty", () => {
    const quicks: QuickCommandLike[] = [
      { command: "coffee", categoryName: "Dining", amountCents: 450, comment: "" },
    ];
    const args = addTransaction.parameters.parse(
      expectTool(parseSlash("/coffee 5 with Sam", quicks)).arguments,
    );
    expect(args.comment).toBe("with Sam");
    // And with no note at all, no empty comment key is emitted.
    expect(expectTool(parseSlash("/coffee", quicks)).arguments).not.toHaveProperty("comment");
  });

  it("rejects a number-shaped first token it cannot read, instead of posting the stored amount", () => {
    for (const input of ["/ccmax 12x", "/ccmax 1.2.3", "/ccmax $", "/ccmax 1,23"]) {
      const result = parseSlash(input, QUICKS);
      expect(result?.kind, input).toBe("error");
      expect((result as { message: string }).message, input).toMatch(/amount/i);
    }
  });

  it("omits `date` so the tool schema fills in today in the LOCAL timezone", () => {
    const call = expectTool(parseSlash("/salary", QUICKS));
    expect(call.arguments).not.toHaveProperty("date");
    expect(addTransaction.parameters.parse(call.arguments).date).toBe(todayKey());
  });

  it("rejects a note that would exceed the schema's comment limit", () => {
    const quicks: QuickCommandLike[] = [
      { command: "x", categoryName: "Dining", amountCents: 100, comment: "" },
    ];
    const atLimit = "n".repeat(COMMENT_MAX_LENGTH);
    const okCall = expectTool(parseSlash(`/x ${atLimit}`, quicks));
    // The boundary is the schema's, so parsing must agree with our guard.
    expect(() => addTransaction.parameters.parse(okCall.arguments)).not.toThrow();
    expect(parseSlash(`/x ${atLimit}n`, quicks)?.kind).toBe("error");
  });

  it("refuses a row whose amount is not integer cents rather than emitting a float", () => {
    const corrupt = [
      { command: "bad", categoryName: "Dining", amountCents: 12.5, comment: "" },
    ] as unknown as QuickCommandLike[];
    const result = parseSlash("/bad", corrupt);
    expect(result?.kind).toBe("error");
    expect((result as { message: string }).message).toMatch(/cents/i);
  });

  it("ignores rows with a blank command name and takes the first of a duplicate pair", () => {
    const quicks: QuickCommandLike[] = [
      { command: "  ", categoryName: "Dining", amountCents: 100, comment: "" },
      { command: "dup", categoryName: "First", amountCents: 100, comment: "" },
      { command: "dup", categoryName: "Second", amountCents: 200, comment: "" },
    ];
    expect(expectTool(parseSlash("/dup", quicks)).arguments.category).toBe("First");
    expect(parseSlash("/", quicks)?.kind).toBe("error");
  });

  it("emits amount strings that always round-trip through parseAmount", () => {
    const amounts: number[] = [0, 1, 99, 100, 4_550, 123_456, 100_000_000];
    for (const cents of amounts) {
      const quicks: QuickCommandLike[] = [
        { command: "r", categoryName: "Dining", amountCents: cents, comment: "" },
      ];
      const emitted = expectTool(parseSlash("/r", quicks)).arguments.amount as string;
      expect(typeof emitted).toBe("string");
      expect(parseAmount(emitted), `${cents} -> ${emitted}`).toBe(cents);
      // Transport is a plain decimal string, per the tool contract: no symbol,
      // no thousands separators.
      expect(emitted).toMatch(/^-?\d+\.\d{2}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Collisions
// ---------------------------------------------------------------------------

describe("collisions with built-ins", () => {
  const shadowing: QuickCommandLike[] = [
    ...QUICKS,
    { command: "budget", categoryName: "Rent", amountCents: 50_000, comment: "shadow attempt" },
    { command: "/y", categoryName: "Rent", amountCents: 100, comment: "shadow attempt" },
  ];

  it("the built-in wins", () => {
    expect(expectTool(parseSlash("/budget", shadowing)).name).toBe("budget_status");
    expect(parseSlash("/y", shadowing)).toEqual({ kind: "confirm", decision: "yes" });
  });

  it("/help names the shadowed commands so the collision is discoverable", () => {
    const help = slashHelpText(shadowing);
    expect(help).toMatch(/\/budget/);
    expect(help).toMatch(/built-in/i);
    // And it must not advertise them as usable quick commands.
    expect(help).not.toMatch(/\/budget — Rent/);
  });

  it("says nothing about collisions when there are none", () => {
    expect(slashHelpText(QUICKS)).not.toMatch(/built-in wins|shadow/i);
  });
});

// ---------------------------------------------------------------------------
// Unknown commands
// ---------------------------------------------------------------------------

describe("unknown commands", () => {
  it("suggests the nearest known command", () => {
    expect(parseSlash("/ccmaxx", QUICKS)).toEqual({
      kind: "unknown",
      command: "/ccmaxx",
      suggestion: "/ccmax",
    });
    expect(parseSlash("/balence", QUICKS)).toMatchObject({ suggestion: "/balance" });
    expect(parseSlash("/salery", QUICKS)).toMatchObject({ suggestion: "/salary" });
    expect(parseSlash("/budgt", QUICKS)).toMatchObject({ suggestion: "/budget" });
  });

  it("suggests on a prefix, which is how people abbreviate", () => {
    expect(parseSlash("/bal", QUICKS)).toMatchObject({ suggestion: "/balance" });
    expect(parseSlash("/cc", QUICKS)).toMatchObject({ suggestion: "/ccmax" });
  });

  it("offers no suggestion when nothing is close, rather than a wild guess", () => {
    const result = parseSlash("/xyzzy", QUICKS);
    expect(result).toEqual({ kind: "unknown", command: "/xyzzy" });
  });

  it("keeps the user's arguments out of the reported command name", () => {
    expect(parseSlash("/ccmaxx 120 annual", QUICKS)).toMatchObject({ command: "/ccmaxx" });
  });

  it("is deterministic in its choice", () => {
    const a = suggestSlashCommand("/recnt", QUICKS);
    const b = suggestSlashCommand("recnt", QUICKS);
    expect(a).toBe("/recent");
    expect(b).toBe("/recent");
  });

  it("never routes an unknown slash command to the model", () => {
    expect(parseSlash("/definitely-not-a-command", QUICKS)?.kind).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

describe("/help", () => {
  it("is text, not a tool call", () => {
    const result = parseSlash("/help", QUICKS);
    expect(result?.kind).toBe("text");
    expect((result as { text: string }).text).toBe(slashHelpText(QUICKS));
  });

  it("answers to its aliases", () => {
    for (const input of ["/help", "/h", "/?"]) {
      expect(parseSlash(input, QUICKS)?.kind, input).toBe("text");
    }
  });

  it("lists every built-in command", () => {
    const help = slashHelpText(QUICKS);
    for (const spec of BUILT_IN_SLASH_COMMANDS) {
      expect(help, spec.names[0]).toContain(`/${spec.names[0]}`);
    }
  });

  it("renders quick-command amounts with formatMoney, never hand-rolled", () => {
    const help = slashHelpText(QUICKS);
    expect(help).toContain("/salary");
    expect(help).toContain("$1,400.00"); // grouped, as formatMoney does it
    expect(help).toContain("/ccmax");
    expect(help).toContain("$100.00");
    expect(help).toContain("Claude Code (Max)");
    expect(help).not.toMatch(/1400\.00/);
  });

  it("tells the user how the override and the note work", () => {
    const help = slashHelpText(QUICKS);
    expect(help).toMatch(/\[amount\]/);
    expect(help).toMatch(/overrides/i);
    // "appended" is the non-guessable half of the contract.
    expect(help).toMatch(/appended/i);
    // And a copy-pasteable example built from a real shortcut.
    expect(help).toMatch(/\/salary 120/);
  });

  it("stays short enough for a chat bubble", () => {
    const help = slashHelpText(QUICKS);
    expect(help.split("\n").length).toBeLessThanOrEqual(20);
    expect(help.length).toBeLessThan(900);
  });

  it("survives an empty quick-command list and a corrupt row", () => {
    expect(slashHelpText([])).toMatch(/quick command/i);
    const corrupt = [
      { command: "bad", categoryName: "Dining", amountCents: 1.5, comment: "" },
    ] as unknown as QuickCommandLike[];
    expect(() => slashHelpText(corrupt)).not.toThrow();
    expect(slashHelpText(corrupt)).toMatch(/bad/);
  });

  it("works with no quick commands passed at all", () => {
    expect(parseSlash("/help")?.kind).toBe("text");
    expect(expectTool(parseSlash("/balance")).name).toBe("get_balances");
    expect(parseSlash("/ccmax")?.kind).toBe("unknown");
  });
});
