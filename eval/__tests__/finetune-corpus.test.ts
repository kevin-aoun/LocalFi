/**
 * Quality gate on the finetuning corpus.
 *
 * A training target that the app would reject teaches the model to emit something
 * unusable — the corpus has to satisfy the same validation the runtime does, or
 * finetuning actively makes things worse. Run before any training job.
 *
 * Regenerate with:
 *   node node_modules/tsx/dist/cli.mjs eval/generate-finetune-data.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { AGENT_TOOLS, findTool } from "@/lib/agent/tools";
import { estimateNeedleTokens, NEEDLE_MAX_ENC_TOKENS } from "@/lib/agent/tool-schema";

const PATH = "eval/needle-finetune.jsonl";
const OFFICIAL_MIN_PER_TOOL = 120; // README: 100 train / 10 val / 10 test

type Line = { query: string; tools: string; answers: string };

const lines: Line[] = existsSync(PATH)
  ? readFileSync(PATH, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
  : [];

describe("corpus shape", () => {
  it("exists and is non-trivial", () => {
    expect(lines.length).toBeGreaterThan(1000);
  });

  it("every line has exactly the three documented fields, all strings", () => {
    for (const l of lines) {
      expect(Object.keys(l).sort()).toEqual(["answers", "query", "tools"]);
      expect(typeof l.query).toBe("string");
      // `tools` and `answers` are JSON-ENCODED STRINGS, not objects — the format
      // Needle's loader expects. Passing objects silently trains on nothing.
      expect(typeof l.tools).toBe("string");
      expect(typeof l.answers).toBe("string");
      expect(l.query.trim()).not.toBe("");
    }
  });

  it("tools and answers parse as JSON arrays", () => {
    for (const l of lines) {
      expect(Array.isArray(JSON.parse(l.tools))).toBe(true);
      expect(Array.isArray(JSON.parse(l.answers))).toBe(true);
    }
  });

  it("meets the official minimum of 120 examples per tool", () => {
    const counts = new Map<string, number>();
    for (const l of lines) {
      for (const a of JSON.parse(l.answers) as { name: string }[]) {
        counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
      }
    }
    for (const tool of AGENT_TOOLS) {
      expect(counts.get(tool.name) ?? 0).toBeGreaterThanOrEqual(OFFICIAL_MIN_PER_TOOL);
    }
  });

  it("includes no-tool examples, since the base model tool-called on 'hello'", () => {
    const empty = lines.filter((l) => (JSON.parse(l.answers) as unknown[]).length === 0);
    expect(empty.length).toBeGreaterThan(30);
  });
});

describe("every training target is something the app would actually accept", () => {
  it("names only real tools", () => {
    for (const l of lines) {
      for (const a of JSON.parse(l.answers) as { name: string }[]) {
        expect(findTool(a.name), `unknown tool ${a.name}`).toBeDefined();
      }
    }
  });

  it("passes the REAL zod schema for its tool", () => {
    const failures: string[] = [];
    for (const l of lines) {
      for (const a of JSON.parse(l.answers) as { name: string; arguments: Record<string, unknown> }[]) {
        const tool = findTool(a.name)!;
        const parsed = tool.parameters.safeParse(a.arguments);
        if (!parsed.success) {
          failures.push(`${a.name} ${JSON.stringify(a.arguments)} :: ${parsed.error.issues[0]?.message}`);
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it("NEVER teaches a date argument — the model has no clock", () => {
    // Observed base-model failure: "10 groceries" -> {"date":"2023-10-27"}.
    // Dates are extracted from the message by lib/agent/normalize-call.ts instead.
    const withDate = lines.filter((l) =>
      (JSON.parse(l.answers) as { arguments?: Record<string, unknown> }[]).some(
        (a) => a.arguments && "date" in a.arguments,
      ),
    );
    expect(withDate).toHaveLength(0);
  });

  it("teaches CANONICAL category names, so resolution is an exact match", () => {
    // The user writes "groceries"; the category is "Food". Targets must use Food.
    const CANONICAL = new Set([
      "Food", "Transport", "Subscriptions", "Shopping", "Entertainment", "Travel",
      "Gifts", "Personal Development", "Startups", "Commodities", "Crypto",
      "Salary", "Freelance Consulting", "Allowance",
    ]);
    const bad: string[] = [];
    for (const l of lines) {
      for (const a of JSON.parse(l.answers) as { arguments?: Record<string, unknown> }[]) {
        const c = a.arguments?.category;
        if (typeof c === "string" && !CANONICAL.has(c)) bad.push(c);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it("still exposes the user's own wording in the QUERY, or there is nothing to learn", () => {
    const synonyms = ["groceries", "uber", "netflix", "coffee", "dinner"];
    for (const s of synonyms) {
      expect(lines.some((l) => l.query.toLowerCase().includes(s)), `no query uses "${s}"`).toBe(true);
    }
  });
});

describe("the tools field", () => {
  it("always contains the tool the answer names", () => {
    for (const l of lines) {
      const answers = JSON.parse(l.answers) as { name: string }[];
      if (answers.length === 0) continue;
      const names = new Set((JSON.parse(l.tools) as { name: string }[]).map((t) => t.name));
      for (const a of answers) {
        expect(names.has(a.name), `${a.name} absent from its own tools list`).toBe(true);
      }
    }
  });

  it("varies the number of tools offered, per the official advice", () => {
    const sizes = new Set(lines.map((l) => (JSON.parse(l.tools) as unknown[]).length));
    // "include examples with multiple tools available"
    expect(sizes.size).toBeGreaterThan(3);
    expect(Math.max(...sizes)).toBe(AGENT_TOOLS.length);
  });

  it("uses Needle's flat dialect, not JSON Schema", () => {
    for (const l of lines.slice(0, 50)) {
      for (const t of JSON.parse(l.tools) as Record<string, unknown>[]) {
        expect(t).toHaveProperty("parameters");
        expect(t).not.toHaveProperty("input_schema");
        const params = t.parameters as Record<string, Record<string, unknown>>;
        for (const p of Object.values(params)) {
          expect(p).toHaveProperty("required");
          expect(typeof p.required).toBe("boolean");
        }
      }
    }
  });

  it("keeps every example inside the 1024-token encoder", () => {
    const over = lines.filter(
      (l) => estimateNeedleTokens(l.tools) + estimateNeedleTokens(l.query) > NEEDLE_MAX_ENC_TOKENS,
    );
    // Truncation is silent, so an oversized training example teaches from a
    // partial tool list.
    expect(over.length).toBe(0);
  });
});
