/**
 * The converter and the validation boundary.
 *
 * These tests exist because the two failure modes here are both SILENT:
 *   1. handing Needle a JSON Schema instead of its own flat dialect — the model
 *      just quietly stops calling the tool properly; nothing errors;
 *   2. accepting a hallucinated argument — a wrong amount or an Invalid Date
 *      reaches SQLite and is indistinguishable from a real entry afterwards.
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_TOOLS,
  CONFIRM_THRESHOLD_CENTS,
  WRITE_TOOL_NAMES,
  addTransaction,
  addTransfer,
  findTool,
  getBalances,
  listRecent,
} from "@/lib/agent/tools";
import {
  needleToolsJson,
  parseToolCalls,
  toJsonSchemaTool,
  toNeedleTool,
  toNeedleTools,
  needleBudget,
  NEEDLE_MAX_ENC_TOKENS,
  NEEDLE_QUERY_RESERVE_TOKENS,
} from "@/lib/agent/tool-schema";
import { todayKey } from "@/lib/dates";

describe("Needle dialect", () => {
  it("emits a FLAT parameter dict with per-parameter required, not JSON Schema", () => {
    const t = toNeedleTool(addTransaction);

    expect(t.name).toBe("add_transaction");
    // The shape Needle documents.
    expect(t.parameters.amount).toMatchObject({ type: "string", required: true });
    expect(t.parameters.category).toMatchObject({ type: "string", required: true });
    expect(t.parameters.date).toMatchObject({ required: false });
    expect(t.parameters.pending).toMatchObject({ type: "boolean", required: false });

    // The shape it must NOT be.
    expect(t.parameters).not.toHaveProperty("properties");
    expect(t.parameters).not.toHaveProperty("type");
    expect(Array.isArray((t as unknown as { required?: unknown }).required)).toBe(false);
  });

  it("sees through .transform() to the type the MODEL must produce", () => {
    // `amount` is a union piped through parseAmount. Unwrapped naively it would
    // be reported as an untyped blob, and the model would fill it in freely.
    const t = toNeedleTool(addTransaction);
    expect(t.parameters.amount.type).toBe("string");
    // `date` is optional + transformed.
    expect(t.parameters.date.type).toBe("string");
    expect(t.parameters.date.required).toBe(false);
  });

  it("carries the .describe() text through, since it is the only steering available", () => {
    const t = toNeedleTool(addTransfer);
    expect(t.parameters.from_account.description).toMatch(/leaves/i);
    expect(t.parameters.to_account.description).toMatch(/arrives/i);
  });

  it("handles a no-parameter tool as an empty dict, not a missing key", () => {
    const t = toNeedleTool(getBalances);
    expect(t.parameters).toEqual({});
  });

  it("reports an integer parameter as integer", () => {
    const t = toNeedleTool(listRecent);
    expect(t.parameters.limit.type).toBe("integer");
    expect(t.parameters.limit.required).toBe(false);
  });

  it("produces a JSON array string ready to hand to the model", () => {
    const json = needleToolsJson();
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(AGENT_TOOLS.length);
    for (const t of parsed) {
      expect(t).toHaveProperty("name");
      expect(t).toHaveProperty("description");
      expect(t).toHaveProperty("parameters");
    }
  });

  it("is byte-stable across calls, so prompt caching and A/B runs are comparable", () => {
    expect(needleToolsJson()).toBe(needleToolsJson());
  });

  it("every tool converts without throwing", () => {
    expect(() => toNeedleTools()).not.toThrow();
    expect(toNeedleTools()).toHaveLength(AGENT_TOOLS.length);
  });
});

describe("JSON Schema dialect (cloud fallback)", () => {
  it("nests under properties with a top-level required ARRAY", () => {
    const t = toJsonSchemaTool(addTransaction);
    expect(t.input_schema.type).toBe("object");
    expect(t.input_schema.properties.amount).toMatchObject({ type: "string" });
    expect(t.input_schema.required).toContain("amount");
    expect(t.input_schema.required).toContain("category");
    expect(t.input_schema.required).not.toContain("date");
    // Required for strict tool use to guarantee argument validity.
    expect(t.input_schema.additionalProperties).toBe(false);
  });

  it("agrees with the Needle dialect about which parameters are required", () => {
    for (const tool of AGENT_TOOLS) {
      const needle = toNeedleTool(tool);
      const json = toJsonSchemaTool(tool);
      const needleRequired = Object.entries(needle.parameters)
        .filter(([, p]) => p.required)
        .map(([k]) => k)
        .sort();
      expect(json.input_schema.required.slice().sort()).toEqual(needleRequired);
    }
  });
});

describe("parsing what the model emits", () => {
  it("parses the documented array form", () => {
    expect(
      parseToolCalls('[{"name":"add_transaction","arguments":{"amount":"10","category":"groceries"}}]'),
    ).toEqual([{ name: "add_transaction", arguments: { amount: "10", category: "groceries" } }]);
  });

  it("tolerates a bare object instead of a one-element array", () => {
    expect(parseToolCalls('{"name":"get_balances","arguments":{}}')).toEqual([
      { name: "get_balances", arguments: {} },
    ]);
  });

  it("tolerates a code fence and surrounding prose", () => {
    const raw = 'Sure!\n```json\n[{"name":"get_balances","arguments":{}}]\n```\nDone.';
    expect(parseToolCalls(raw)).toEqual([{ name: "get_balances", arguments: {} }]);
  });

  it("treats absent arguments as an empty object for a no-parameter tool", () => {
    expect(parseToolCalls('[{"name":"refresh_prices"}]')).toEqual([
      { name: "refresh_prices", arguments: {} },
    ]);
  });

  it("returns null on anything it cannot understand, rather than guessing", () => {
    for (const junk of ["", "   ", "I think you should add ten dollars", "[]", "[{}]", "null", '["add_transaction"]']) {
      expect(parseToolCalls(junk)).toBeNull();
    }
  });
});

describe("the validation boundary — the model proposes, zod decides", () => {
  it("coerces a money argument to exact integer cents", () => {
    const parsed = addTransaction.parameters.parse({ amount: "1,234.56", category: "rent" });
    expect(parsed.amount).toBe(123_456);
  });

  it("accepts the shapes a chat message actually contains", () => {
    for (const [input, cents] of [
      ["10", 1_000],
      ["10.5", 1_050],
      ["$4.50", 450],
      [43.5, 4_350],
    ] as const) {
      expect(addTransaction.parameters.parse({ amount: input, category: "x" }).amount).toBe(cents);
    }
  });

  it("REJECTS a hallucinated amount instead of silently storing 0", () => {
    const result = addTransaction.parameters.safeParse({ amount: "about ten dollars", category: "x" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/not an amount/i);
    }
  });

  it("defaults an omitted date to today rather than to an Invalid Date", () => {
    const parsed = addTransaction.parameters.parse({ amount: "5", category: "coffee" });
    expect(parsed.date).toBe(todayKey());
  });

  it("rejects an unreadable date", () => {
    const result = addTransaction.parameters.safeParse({
      amount: "5",
      category: "coffee",
      date: "sometime last Tuesday-ish",
    });
    expect(result.success).toBe(false);
  });

  it("passes a well-formed date through as a DateKey", () => {
    const parsed = addTransaction.parameters.parse({
      amount: "5",
      category: "coffee",
      date: "2026-07-04",
    });
    expect(parsed.date).toBe("2026-07-04");
  });

  it("requires the arguments a tool genuinely needs", () => {
    expect(addTransaction.parameters.safeParse({ category: "x" }).success).toBe(false);
    expect(addTransaction.parameters.safeParse({ amount: "5" }).success).toBe(false);
    expect(
      addTransfer.parameters.safeParse({ from_account: "a", amount: "5" }).success,
    ).toBe(false);
  });

  it("clamps list_recent rather than trusting a model-supplied limit", () => {
    expect(listRecent.parameters.safeParse({ limit: 500 }).success).toBe(false);
    expect(listRecent.parameters.safeParse({ limit: 0 }).success).toBe(false);
    expect(listRecent.parameters.parse({ limit: 5 }).limit).toBe(5);
  });
});

describe("blast radius", () => {
  it("exposes NO tool that can delete a category, account, or arbitrary row", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    for (const forbidden of [
      "delete_category",
      "delete_account",
      "delete_transaction",
      "delete_budget",
      "run_sql",
      "import_file",
      "export_data",
      "update_settings",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("derives the write list from the registry, so a new write tool cannot dodge confirmation", () => {
    expect(WRITE_TOOL_NAMES).toEqual(
      AGENT_TOOLS.filter((t) => t.kind === "write").map((t) => t.name),
    );
    expect(WRITE_TOOL_NAMES).toContain("add_transaction");
    expect(WRITE_TOOL_NAMES).not.toContain("get_balances");
  });

  it("keeps undo confirmation-free — it is the safety valve", () => {
    expect(findTool("undo_last")?.confirm).toBe("never");
    expect(findTool("undo_last")?.kind).toBe("write");
  });

  it("confirms an asset revaluation always, and ordinary spend only over the threshold", () => {
    expect(findTool("set_asset_value")?.confirm).toBe("always");
    expect(findTool("add_transaction")?.confirm).toBe("overThreshold");
    expect(CONFIRM_THRESHOLD_CENTS).toBe(20_000);
  });

  it("gives every tool a trigger-condition description, not just a definition", () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      // "Call this …" / "for …" — the phrasing that steers selection.
      expect(tool.description).toMatch(/call this|use it|never use/i);
    }
  });

  it("every read tool is free of confirmation and every write tool is classified", () => {
    for (const tool of AGENT_TOOLS) {
      if (tool.kind === "read") expect(tool.confirm).toBe("never");
      else expect(["never", "overThreshold", "always"]).toContain(tool.confirm);
    }
  });
});

describe("the encoder budget — a silent cliff", () => {
  it("the real payload fits inside Needle's 1024-token encoder", () => {
    // This is not a style check. Needle truncates `[query, <tools>, tools…]` to
    // 1024 tokens with NO error, so an oversized payload silently deletes the
    // LAST tools in the array. Measured once at 1128 tokens, which made
    // refresh_prices uncallable. If this fails, prune the tool list per message —
    // do not raise the limit.
    const budget = needleBudget();
    expect(budget.fits).toBe(true);
    expect(budget.estimatedTokens).toBeLessThanOrEqual(budget.limit);
  });

  it("reserves room for the user's message, not just the tools", () => {
    expect(NEEDLE_QUERY_RESERVE_TOKENS).toBeGreaterThan(0);
    expect(needleBudget().limit).toBe(NEEDLE_MAX_ENC_TOKENS - NEEDLE_QUERY_RESERVE_TOKENS);
  });

  it("reports a payload that would truncate as not fitting", () => {
    const huge = JSON.stringify([{ name: "x", description: "y".repeat(20_000), parameters: {} }]);
    expect(needleBudget(huge).fits).toBe(false);
  });

  it("keeps every tool visible — the last one especially", () => {
    // The tail of the array is what truncation eats first.
    const parsed = JSON.parse(needleToolsJson());
    expect(parsed.at(-1).name).toBe(AGENT_TOOLS.at(-1)!.name);
    expect(parsed).toHaveLength(AGENT_TOOLS.length);
  });
});
