/**
 * Render the tool registry into the two schema dialects we need.
 *
 * There is exactly ONE source of truth for a tool's arguments — the zod schema in
 * `tools.ts`. Everything a model sees is derived from it, so a parameter cannot
 * be described to the model in a shape the validator does not accept.
 *
 * ## Why two dialects
 *
 * Cactus Needle does NOT take JSON Schema. Its documented format is a flat
 * per-parameter dict with a per-parameter `required` boolean:
 *
 *     {"name":"get_weather","description":"…",
 *      "parameters":{"location":{"type":"string","description":"City name.","required":true}}}
 *
 * JSON Schema, by contrast, nests under `properties` and carries a single
 * top-level `required` ARRAY:
 *
 *     {"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}
 *
 * Handing one where the other is expected does not error — the model simply sees
 * a malformed tool and silently stops calling it correctly, which is the worst
 * failure mode available. Hence an explicit converter with tests.
 *
 * The JSON Schema emitter exists for a cloud fallback (e.g. Claude tool use with
 * `strict: true`, which guarantees argument validity) on the messy inputs a 26M
 * model cannot handle.
 *
 * ## Notable limits of Needle's dialect
 *
 * - **No enum.** A parameter is only `type` + `description` + `required`. So the
 *   category and account arguments are plain strings, resolved deterministically
 *   against real rows afterwards rather than constrained in the schema.
 * - **No nesting.** Object- and array-valued parameters cannot be expressed, so
 *   this converter REFUSES them rather than flattening them into something the
 *   model will fill in wrongly. Every tool argument must be a scalar.
 */
import { z } from "zod/v4";

import { AGENT_TOOLS, type AgentTool } from "./tools";

// ---------------------------------------------------------------------------
// Needle dialect
// ---------------------------------------------------------------------------

/** A scalar JSON type, the only thing Needle's parameter dialect can express. */
export type NeedleParamType = "string" | "number" | "integer" | "boolean";

export type NeedleParam = {
  type: NeedleParamType;
  description?: string;
  required: boolean;
};

export type NeedleTool = {
  name: string;
  description: string;
  parameters: Record<string, NeedleParam>;
};

/** Standard JSON Schema shape, for a cloud model. */
export type JsonSchemaTool = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: false;
  };
};

/**
 * Walk a zod type down to the node that carries the actual type information,
 * recording whether the chain made it optional along the way.
 *
 * `.optional()`, `.default()` and `.transform()` all wrap the inner type, and the
 * money/date arguments in `tools.ts` are transforms — so without unwrapping,
 * every one of them would be reported to the model as an untyped blob.
 */
function unwrap(schema: z.ZodType): { inner: z.ZodType; optional: boolean } {
  let current: z.ZodType = schema;
  let optional = false;

  // Bounded to avoid spinning on a pathological schema.
  for (let i = 0; i < 20; i++) {
    const def = (current as unknown as { _zod?: { def?: { type?: string } } })._zod?.def;
    const type = def?.type;

    if (type === "optional" || type === "nullable" || type === "default" || type === "prefault") {
      optional = true;
      current = (current as unknown as { _zod: { def: { innerType: z.ZodType } } })._zod.def
        .innerType;
      continue;
    }
    if (type === "pipe") {
      // A transform: `input.transform(fn)` is represented as a pipe. The INPUT
      // side is what the model must produce, so follow that, not the output.
      current = (current as unknown as { _zod: { def: { in: z.ZodType } } })._zod.def.in;
      continue;
    }
    break;
  }

  return { inner: current, optional };
}

/** True when a zod number carries an integer-format check (`.int()`, `z.int()`). */
function hasIntegerCheck(schema: z.ZodType): boolean {
  const checks =
    (schema as unknown as { _zod?: { def?: { checks?: unknown[] } } })._zod?.def?.checks ?? [];
  return checks.some((check) => {
    const format = (check as { _zod?: { def?: { format?: string } } })?._zod?.def?.format;
    return typeof format === "string" && /int/i.test(format);
  });
}

/** The scalar type a zod node presents to a caller. */
function scalarTypeOf(schema: z.ZodType, path: string): NeedleParamType {
  const def = (schema as unknown as { _zod: { def: { type: string } } })._zod.def;

  switch (def.type) {
    case "string":
    case "enum":
    case "literal":
      return "string";
    case "number":
      // In zod v4 `.int()` is a CHECK on a number (format "safeint"/"int32"),
      // not a distinct type — and `z.int()` reports as "number" too. Detect it,
      // because "integer" is a stricter instruction to the model than "number".
      return hasIntegerCheck(schema) ? "integer" : "number";
    case "int":
    case "bigint":
      return "integer";
    case "boolean":
      return "boolean";
    case "union": {
      // `z.union([z.string(), z.number()])` — the money argument. The model can
      // emit either, and a string is the safer instruction: it round-trips
      // "1,234.56" and "$10" without the model having to strip them first.
      const options = (schema as unknown as { _zod: { def: { options: z.ZodType[] } } })._zod.def
        .options;
      const types = new Set(options.map((o) => scalarTypeOf(unwrap(o).inner, path)));
      if (types.size === 1) return [...types][0];
      return "string";
    }
    default:
      throw new Error(
        `Tool parameter ${path} has zod type "${def.type}", which cannot be expressed as a scalar. ` +
          `Needle's schema dialect supports only string/number/integer/boolean parameters: ` +
          `flatten it or resolve it server-side instead.`,
      );
  }
}

function describe(schema: z.ZodType): string | undefined {
  const meta = (schema as unknown as { _zod?: { def?: { description?: string } } })._zod?.def
    ?.description;
  if (typeof meta === "string" && meta !== "") return meta;
  // `.describe()` on zod/v4 records into the registry rather than the def.
  const registered = z.globalRegistry.get(schema) as { description?: string } | undefined;
  return registered?.description;
}

/** The object shape of a tool's parameters, or a clear error if it isn't one. */
function shapeOf(tool: AgentTool): Record<string, z.ZodType> {
  const { inner } = unwrap(tool.parameters);
  const def = (inner as unknown as { _zod: { def: { type: string; shape?: unknown } } })._zod.def;
  if (def.type !== "object") {
    throw new Error(`Tool ${tool.name} must take an object of parameters, got "${def.type}".`);
  }
  return def.shape as Record<string, z.ZodType>;
}

/** Convert one tool to Needle's dialect. */
export function toNeedleTool(tool: AgentTool): NeedleTool {
  const shape = shapeOf(tool);
  const parameters: Record<string, NeedleParam> = {};

  for (const [key, raw] of Object.entries(shape)) {
    const { inner, optional } = unwrap(raw);
    const description = describe(raw) ?? describe(inner);
    parameters[key] = {
      type: scalarTypeOf(inner, `${tool.name}.${key}`),
      ...(description ? { description } : {}),
      // Needle carries requiredness PER PARAMETER, not as a top-level array.
      required: !optional,
    };
  }

  return { name: tool.name, description: tool.description, parameters };
}

/**
 * The whole registry in Needle's dialect.
 *
 * Needle expects a JSON ARRAY of tools as its tool-list input; `needleToolsJson`
 * produces exactly the string to hand it.
 */
export function toNeedleTools(tools: readonly AgentTool[] = AGENT_TOOLS): NeedleTool[] {
  return tools.map(toNeedleTool);
}

export function needleToolsJson(tools: readonly AgentTool[] = AGENT_TOOLS): string {
  return JSON.stringify(toNeedleTools(tools));
}

// ---------------------------------------------------------------------------
// The encoder budget — a silent cliff, so guard it
// ---------------------------------------------------------------------------

/**
 * Needle's encoder length, read from the model source (`DEFAULT_MAX_ENC_LEN` in
 * `needle/dataset/dataset.py`), not from the README — which does not mention it.
 *
 * The encoder input is built as `[query…, <tools>, tools…]` and then **silently
 * truncated**:
 *
 *     remaining = max_enc_len - len(query_tokens) - 1
 *     tool_tokens = tool_tokens[:remaining]      // no error, no warning
 *
 * So an oversized tool list does not fail — the tools at the END of the array
 * simply vanish and the model can never call them. Measured on this repo's own
 * payload: 9 tools rendered to 1128 tokens, 114 over the limit, which made
 * `refresh_prices` invisible.
 */
export const NEEDLE_MAX_ENC_TOKENS = 1024;

/**
 * Bytes per token, measured with Needle's own tokenizer against this repo's tool
 * JSON (4171 bytes → 1128 tokens ⇒ 3.70). Used only for a cheap in-process
 * estimate; the authoritative check runs the real tokenizer (see
 * `scripts/agent-budget.ts`).
 */
export const NEEDLE_BYTES_PER_TOKEN = 3.7;

/** Tokens held back for the user's message. ~64 tokens is a long chat line. */
export const NEEDLE_QUERY_RESERVE_TOKENS = 64;

/** Estimated token count of a rendered tool payload. Deliberately pessimistic. */
export function estimateNeedleTokens(json: string): number {
  return Math.ceil(json.length / NEEDLE_BYTES_PER_TOKEN);
}

export type NeedleBudget = {
  bytes: number;
  estimatedTokens: number;
  limit: number;
  fits: boolean;
};

/**
 * Check a payload against the encoder budget.
 *
 * Call this before handing tools to the model. A payload that does not fit must
 * be pruned (send fewer tools for this message) rather than passed through —
 * passing it through loses the tail of the list without saying so.
 */
export function needleBudget(json: string = needleToolsJson()): NeedleBudget {
  const estimatedTokens = estimateNeedleTokens(json);
  const limit = NEEDLE_MAX_ENC_TOKENS - NEEDLE_QUERY_RESERVE_TOKENS;
  return { bytes: json.length, estimatedTokens, limit, fits: estimatedTokens <= limit };
}

// ---------------------------------------------------------------------------
// JSON Schema dialect (cloud fallback)
// ---------------------------------------------------------------------------

/**
 * Convert one tool to standard JSON Schema.
 *
 * `additionalProperties: false` plus a complete `required` array is what strict
 * tool use needs in order to guarantee the arguments validate.
 */
export function toJsonSchemaTool(tool: AgentTool): JsonSchemaTool {
  const shape = shapeOf(tool);
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const [key, raw] of Object.entries(shape)) {
    const { inner, optional } = unwrap(raw);
    const description = describe(raw) ?? describe(inner);
    const type = scalarTypeOf(inner, `${tool.name}.${key}`);
    properties[key] = {
      type: type === "integer" ? "integer" : type,
      ...(description ? { description } : {}),
    };
    if (!optional) required.push(key);
  }

  return {
    name: tool.name,
    description: tool.description,
    input_schema: { type: "object", properties, required, additionalProperties: false },
  };
}

export function toJsonSchemaTools(
  tools: readonly AgentTool[] = AGENT_TOOLS,
): JsonSchemaTool[] {
  return tools.map(toJsonSchemaTool);
}

// ---------------------------------------------------------------------------
// Parsing what the model emits
// ---------------------------------------------------------------------------

export type ToolCall = { name: string; arguments: Record<string, unknown> };

/**
 * Parse Needle's output.
 *
 * Documented shape is an array of calls:
 *   [{"name":"get_weather","arguments":{"location":"San Francisco"}}]
 *
 * Tolerated deviations, because a 26M model is described by its own authors as
 * "finicky" and these are the cheap ones to absorb: a bare object instead of a
 * one-element array, and surrounding prose/code fences around the JSON. Anything
 * else returns null — a null is a clean "I did not understand", which the caller
 * turns into a clarifying question. Guessing would be worse.
 */
export function parseToolCalls(raw: string): ToolCall[] | null {
  const text = raw.trim();
  if (text === "") return null;

  const candidates: string[] = [text];

  // ```json … ``` fences, and the first balanced [ … ] or { … } run.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const bracketed = text.match(/\[[\s\S]*\]/);
  if (bracketed?.[0]) candidates.push(bracketed[0]);
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced?.[0]) candidates.push(braced[0]);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const calls: ToolCall[] = [];
    let ok = list.length > 0;

    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) {
        ok = false;
        break;
      }
      const { name, arguments: args } = entry as { name?: unknown; arguments?: unknown };
      if (typeof name !== "string" || name === "") {
        ok = false;
        break;
      }
      // Absent arguments is legitimate for a no-parameter tool.
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
        ok = false;
        break;
      }
      calls.push({ name, arguments: (args as Record<string, unknown>) ?? {} });
    }

    if (ok) return calls;
  }

  return null;
}
