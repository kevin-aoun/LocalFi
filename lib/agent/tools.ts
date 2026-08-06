/**
 * The tool surface exposed to the on-device function-calling model.
 *
 * ============================================================================
 * THIS FILE IS THE CONTRACT. Read it before changing anything in lib/agent/.
 * ============================================================================
 *
 * Design rules, and why each exists:
 *
 * 1. **This module is PURE.** It imports no server action and never touches the
 *    database, so it can be unit-tested and so the schemas can be rendered into
 *    a prompt from anywhere. Execution lives in a separate adapter; the split
 *    mirrors the `*-logic.ts` convention used across this codebase.
 *
 * 2. **The model never writes. It proposes.** A 26M-parameter model will emit
 *    plausible-but-wrong arguments. Every call is parsed by the zod schema here
 *    before anything reaches a server action, and the action re-validates on its
 *    own. `parseAmount` and `parseFlexibleDate` are the coercion boundary: a
 *    malformed amount or date fails loudly instead of becoming 0 or Invalid Date.
 *
 * 3. **No enums in the model's arguments.** Needle's schema dialect expresses
 *    only `type` / `description` / `required` per parameter — there is no enum
 *    keyword — and a tiny model asked to reproduce one of fifteen exact category
 *    names will get it wrong. So category and account arrive as free strings and
 *    are resolved DETERMINISTICALLY against the real rows (exact match, then
 *    normalized, then unique-prefix, else ask). Resolution is our job, not the
 *    model's.
 *
 * 4. **The blast radius is bounded by omission.** There is deliberately no
 *    delete-category, delete-account, edit-arbitrary-row, bulk-import, or
 *    schema-shaped tool. A chat message must not be able to drop a category —
 *    that is how two transactions were orphaned in this database once already.
 *
 * 5. **Reads are free; writes are cheap to undo.** `undo_last` exists because a
 *    chat channel is a typo-prone medium and is the safety valve that makes the
 *    write tools acceptable at all.
 */
import { z } from "zod/v4";

import { parseAmount, type Cents } from "@/lib/money";
import { isDateKey, parseFlexibleDate, toDateKey, todayKey, type DateKey } from "@/lib/dates";

// ---------------------------------------------------------------------------
// Shared argument primitives
// ---------------------------------------------------------------------------

/**
 * A money argument, in whatever shape a language model produced it, coerced to
 * integer cents exactly once.
 *
 * Accepts "10", "10.50", "1,234.56", "$10", "(45.00)" and bare numbers, because
 * that is the range `parseAmount` already handles and tests. Anything else is a
 * validation failure, NOT a silent zero — a silent zero is how a live-priced
 * asset once got persisted at $0.00.
 */
const moneyArg = z
  .union([z.string(), z.number()])
  .transform((raw, ctx): Cents => {
    try {
      return parseAmount(raw);
    } catch (error) {
      ctx.issues.push({
        code: "custom",
        message: `Not an amount I can read: ${JSON.stringify(raw)} (${(error as Error).message})`,
        input: raw,
      });
      return z.NEVER;
    }
  })
  // Kept SHORT on purpose. A shared primitive's description is duplicated into
  // every tool that uses it, and Needle's encoder truncates at 1024 tokens — see
  // NEEDLE_MAX_ENC_TOKENS in tool-schema.ts. The verbose version of this string
  // cost ~75 tokens across three tools and pushed the payload over the limit,
  // silently hiding the last tool in the list from the model.
  .describe("Amount as written: '10', '10.50', '1,234.56'. Always positive.");

/**
 * A calendar day. Defaults to today when the model omits it, which is the common
 * case ("10 groceries" means today).
 *
 * Parsed with `parseFlexibleDate`, never `new Date(string)`: the latter reads
 * `01/02/2026` as January 2nd regardless of intent. `dayFirst` is deliberately
 * NOT exposed to the model — an ambiguous numeric date from a chat message is
 * resolved by the caller's configured preference, not guessed per-message.
 */
const dateArg = z
  .union([z.string(), z.number()])
  .optional()
  .transform((raw, ctx): DateKey => {
    if (raw === undefined || raw === "") return todayKey();
    if (typeof raw === "string" && isDateKey(raw)) return raw;
    const parsed = parseFlexibleDate(raw);
    if (parsed === null) {
      ctx.issues.push({
        code: "custom",
        message: `Not a date I can read: ${JSON.stringify(raw)}`,
        input: raw,
      });
      return z.NEVER;
    }
    return toDateKey(parsed);
  })
  .describe("Day as 'YYYY-MM-DD'. Omit for today.");

/** A free-text name the MODEL produced; resolved against real rows by us. */
const nameArg = z.string().min(1).max(120);

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

/**
 * Whether a tool mutates the ledger. Reads may run without confirmation and may
 * be retried freely; writes may not.
 */
export type ToolKind = "read" | "write";

/**
 * When to ask the user before executing.
 *
 * `overThreshold` is the interesting one: capture stays frictionless for a $4
 * coffee but a $4,000 write gets a confirmation step, because the cost of a
 * misparsed large amount is not symmetric with the cost of a small one.
 */
export type ConfirmPolicy = "never" | "overThreshold" | "always";

/** Writes at or above this are confirmed before executing. $200.00. */
export const CONFIRM_THRESHOLD_CENTS: Cents = 20_000;

export type AgentTool<S extends z.ZodType = z.ZodType> = {
  name: string;
  /**
   * Written to tell the model WHEN to call this, not merely what it does.
   * Trigger-condition phrasing measurably improves tool selection, and it is the
   * only steering available for a model with no system prompt of its own.
   */
  description: string;
  kind: ToolKind;
  confirm: ConfirmPolicy;
  parameters: S;
};

function tool<S extends z.ZodType>(spec: AgentTool<S>): AgentTool<S> {
  return spec;
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export const addTransaction = tool({
  name: "add_transaction",
  description:
    "Record money spent or received. Call this when the user gives an amount and what it was for, e.g. '10 groceries'.",
  kind: "write",
  confirm: "overThreshold",
  parameters: z.object({
    amount: moneyArg,
    category: nameArg.describe("What it was for."),
    date: dateArg,
    account: nameArg.optional().describe("Account. Omit for default."),
    comment: z.string().max(500).optional(),
    pending: z
      .boolean()
      .optional()
      .describe("True if not yet cleared."),
  }),
});

export const addTransfer = tool({
  name: "add_transfer",
  description:
    "Move money between the user's own accounts. Call this for 'moved 500 to savings'. Never use add_transaction for this.",
  kind: "write",
  confirm: "overThreshold",
  parameters: z.object({
    from_account: nameArg.describe("Account money leaves."),
    to_account: nameArg.describe("Account money arrives in."),
    amount: moneyArg,
    date: dateArg,
    comment: z.string().max(500).optional(),
  }),
});

export const undoLast = tool({
  name: "undo_last",
  description:
    "Reverse the last change. Call this for 'undo', 'oops', or 'that was wrong'.",
  kind: "write",
  confirm: "never",
  parameters: z.object({}),
});

export const getBalances = tool({
  name: "get_balances",
  description:
    "Report balances and net worth. Call this for 'how much do I have' or 'what's my balance'.",
  kind: "read",
  confirm: "never",
  parameters: z.object({}),
});

export const spendSummary = tool({
  name: "spend_summary",
  description:
    "Report spending over a period. Call this for 'how much did I spend on dining this month'.",
  kind: "read",
  confirm: "never",
  parameters: z.object({
    period: z
      .string()
      .optional()
      .describe(
        "'this month', 'last month', 'this week', 'this year'. Omit for this month.",
      ),
    category: nameArg.optional().describe("One category, or omit for all."),
  }),
});

export const budgetStatus = tool({
  name: "budget_status",
  description:
    "Report budget usage and what is left. Call this for 'am I over budget'.",
  kind: "read",
  confirm: "never",
  parameters: z.object({
    category: nameArg.optional().describe("One category, or omit for all."),
  }),
});

export const listRecent = tool({
  name: "list_recent",
  description:
    "List recent transactions. Call this for 'what did I log today'.",
  kind: "read",
  confirm: "never",
  parameters: z.object({
    limit: z.coerce.number().int().min(1).max(20).optional().describe("How many. Default 5."),
  }),
});

export const setAssetValue = tool({
  name: "set_asset_value",
  description:
    "Set the value of a hand-valued holding. Call this for 'the car is worth 18000 now'.",
  kind: "write",
  confirm: "always",
  parameters: z.object({
    asset: nameArg.describe("Which holding."),
    value: moneyArg,
  }),
});

export const refreshPrices = tool({
  name: "refresh_prices",
  description:
    "Refresh live gold, silver, platinum, palladium, Bitcoin and Ethereum prices. Call this for 'what's bitcoin at'.",
  kind: "read",
  confirm: "never",
  parameters: z.object({}),
});

/**
 * The registry. Order is stable so the rendered prompt is byte-stable — a
 * shuffled tool list would defeat any prompt caching and makes A/B results on a
 * small model impossible to compare.
 */
export const AGENT_TOOLS = [
  addTransaction,
  addTransfer,
  undoLast,
  getBalances,
  spendSummary,
  budgetStatus,
  listRecent,
  setAssetValue,
  refreshPrices,
] as const satisfies readonly AgentTool[];

export type AgentToolName = (typeof AGENT_TOOLS)[number]["name"];

export function findTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

/**
 * Tools that mutate. Kept as a derived list rather than a hand-maintained one so
 * a new write tool cannot be added without appearing in the confirmation path.
 */
export const WRITE_TOOL_NAMES: readonly string[] = AGENT_TOOLS.filter(
  (t) => t.kind === "write",
).map((t) => t.name);
