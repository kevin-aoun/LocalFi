/**
 * The one entry point for a chat message, wherever it came from.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS AT ALL
 * ============================================================================
 *
 * The terminal REPL, the HTTP route and (later) the Telegram worker must not each
 * decide when to call the model, when to normalize a date, or how to answer a
 * confirmation. Three copies of that routing means three different sets of
 * guarantees about money, and the two that are wrong will not announce
 * themselves. So: one function, `handleMessage`, and the surfaces above it do
 * nothing but transport.
 *
 * ============================================================================
 * THE ROUTING RULES, AND WHY EACH IS THE WAY IT IS
 * ============================================================================
 *
 * 1. **A leading `/` is a promise of determinism.** `parseSlash` returns null
 *    ONLY for a message that does not start with `/`, and that null is the sole
 *    signal to involve the model. An unknown slash command therefore stops here
 *    with a suggestion — routing `/recnt` to a 26M model would turn a typo into
 *    a guess at what the user meant to do with their money.
 *
 * 2. **Every model-produced call goes through `normalizeModelCall` first.**
 *    Measured: `10 groceries` produced `{"date":"2023-10-27"}`. That is
 *    structurally valid, so zod accepts it, and the row lands three years in the
 *    past where the user will never find it. Slash-produced calls skip this step
 *    because slash never emits a date.
 *
 * 3. **The model is single-shot.** If it returns more than one call we execute
 *    the FIRST and say out loud which ones we ignored. Silently dropping the
 *    tail would make "moved 500 to savings and log 20 lunch" look like it fully
 *    worked when half of it did not happen.
 *
 * 4. **The model being down is a normal state, not an error page.** Slash
 *    commands and quick commands are the ~90% path; when the sidecar is not
 *    running we say so, say how to start it, and stay useful.
 *
 * 5. **Nothing here writes to the database.** Every effect goes through
 *    `executeToolCall`, which owns validation, name resolution, the confirmation
 *    gate, the undo journal and the reply text. This file must never grow a
 *    second copy of any of those.
 *
 * Pure-ish and testable: `today` is a parameter (never read from the clock deep
 * inside), and the model client can be injected.
 */
import { getSettings } from "@/app/actions/settings";
import { todayKey, type DateKey } from "@/lib/dates";

import {
  cancelPendingToolCall,
  confirmPendingToolCall,
  executeToolCall,
  pendingToolCalls,
  type ExecuteContext,
  type ExecuteOutcome,
  type PendingToolCall,
} from "./execute";
import { callNeedle, needleHealth, type NeedleResult } from "./needle-client";
import { normalizeModelCall } from "./normalize-call";
import { parseSlash, type QuickCommandLike, type SlashResult } from "./slash";
import { needleBudget, needleToolsJson } from "./tool-schema";

// ---------------------------------------------------------------------------
// The model client
// ---------------------------------------------------------------------------

export type { NeedleResult };

/**
 * The shape of `callNeedle`, as a structural type.
 *
 * This is the injection seam the tests use: a stub that returns "unavailable",
 * or a call carrying a hallucinated date, needs no Python, no checkpoint, no
 * sockets and no 12-second JIT warmup. Every routing rule below is therefore
 * testable without the model.
 */
export type NeedleClient = (query: string, toolsJson: string) => Promise<NeedleResult>;

/** What a startup banner needs to say about the model. */
export type NeedleHealth = {
  /** True only when a call has a real chance of succeeding. */
  ready: boolean;
  /** One line for a human: the checkpoint it holds, or why it is not ready. */
  detail: string;
};

/**
 * How to start the sidecar, quoted verbatim in the model-down reply.
 *
 * Overridable because a stale instruction in an error message wastes more of the
 * reader's time than a generic one.
 */
export const NEEDLE_START_HINT =
  process.env.NEEDLE_START_COMMAND?.trim() || "npm run agent:sidecar";

/**
 * Is the model usable right now?
 *
 * Never throws: a health probe that can crash the CLI at startup is worse than
 * no probe at all. Used for the banner, not on the message path — the message
 * path learns the same thing from `callNeedle` returning "unavailable", and a
 * pre-flight check there would only add a round trip.
 */
export async function checkNeedleHealth(): Promise<NeedleHealth> {
  try {
    const health = await needleHealth();
    if (health.status === "ok") {
      return { ready: true, detail: `${health.checkpoint} on ${health.platform}` };
    }
    return { ready: false, detail: health.reason };
  } catch (error) {
    return { ready: false, detail: `health check threw: ${errorText(error)}` };
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------

export type AgentReply = {
  /** What to show the user. Already contains any `notes`, so a dumb transport
   *  that prints only this string still tells the whole truth. */
  text: string;
  source: "slash" | "model" | "help" | "system";
  status: "ok" | "confirm" | "question" | "error" | "unknown";
  toolName?: string;
  /** Corrections and omissions the user must know about, e.g. an ignored date. */
  notes?: string[];
  /** Present only when `opts.debug` is on. Never in a normal reply. */
  debug?: { raw?: string; ms?: number; calls?: unknown[] };
};

export type HandleOptions = {
  /**
   * Today, for relative-date resolution and the executor's period wording.
   * Defaults to the clock.
   *
   * KNOWN LIMIT: this fixes relative phrases ("yesterday") because
   * `normalizeModelCall` writes the resolved key into the call. It does NOT
   * reach a call that carries no date at all — `dateArg` in tools.ts defaults
   * that one with its own `todayKey()`. Closing that gap means changing
   * tools.ts, not this file.
   */
  today?: DateKey;
  /** Attach raw model output, latency and parsed calls to the reply. */
  debug?: boolean;
  /** The user's quick commands. Loaded from settings when omitted AND needed. */
  quickCommands?: readonly QuickCommandLike[];
  /**
   * Model client override. `undefined` uses the real `callNeedle`; `null` forces
   * the model-unavailable path (a slash-only deployment, and the tests).
   */
  needle?: NeedleClient | null;
  /** Passed through to the executor: undo journal, currency, action stubs, clock. */
  context?: ExecuteContext;
};

/** Shown for an empty message. Short on purpose — it is a nudge, not a manual. */
const USAGE_HINT =
  "Nothing to do, send me something. Try:\n" +
  "  10 groceries        log a $10.00 expense\n" +
  "  /balance            accounts and net worth\n" +
  "  /help               every command I have";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Route and execute one chat message.
 *
 * Never throws for anything a user or the model can cause. A thrown error from
 * deeper down (a broken database, a crashed action) is caught and reported as a
 * failure — reporting success on a failed write is the one outcome this codebase
 * treats as unacceptable.
 */
export async function handleMessage(
  message: string,
  opts?: HandleOptions,
): Promise<AgentReply> {
  const today = opts?.today ?? todayKey();
  const debug = opts?.debug === true;
  const raw = typeof message === "string" ? message : "";
  const trimmed = raw.trim();

  // 1. Nothing to route.
  if (trimmed === "") {
    return { text: USAGE_HINT, source: "help", status: "question" };
  }

  try {
    // 2. A leading slash is handled deterministically, or not at all.
    const quickCommands = trimmed.startsWith("/")
      ? await resolveQuickCommands(opts)
      : [];
    const slash = parseSlash(trimmed, quickCommands);
    if (slash !== null) {
      return await handleSlash(slash, { today, context: opts?.context });
    }

    // 3. Everything else is a job for the model.
    return await handleModel(trimmed, { today, debug, opts });
  } catch (error) {
    // A genuine fault. Say so plainly; never imply the write happened.
    return {
      text:
        `Something broke while handling that, so assume nothing was saved: ${errorText(error)}`,
      source: "system",
      status: "error",
    };
  }
}

/**
 * Quick commands, from the caller or from settings.
 *
 * A settings read that fails must not take the whole message down: the built-in
 * commands do not depend on it, so we degrade to "no quick commands" and note it
 * rather than refusing to answer `/balance`.
 */
async function resolveQuickCommands(
  opts?: HandleOptions,
): Promise<readonly QuickCommandLike[]> {
  if (opts?.quickCommands !== undefined) return opts.quickCommands;
  try {
    return (await getSettings()).quickCommands;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Slash
// ---------------------------------------------------------------------------

async function handleSlash(
  slash: SlashResult,
  ctx: { today: DateKey; context?: ExecuteContext },
): Promise<AgentReply> {
  switch (slash.kind) {
    case "text":
      // `/help`. No tool, no side effect.
      return { text: slash.text, source: "help", status: "ok" };

    case "error":
      // The command exists; the arguments do not make sense. Already user-facing.
      return { text: slash.message, source: "slash", status: "error" };

    case "unknown": {
      // Rule 1: this must never reach the model.
      const suggestion = slash.suggestion
        ? ` Did you mean ${slash.suggestion}?`
        : " Send /help to see what I have.";
      return {
        text: `I don't have a command called ${slash.command}.${suggestion} Nothing happened.`,
        source: "slash",
        status: "unknown",
      };
    }

    case "confirm":
      return await handleConfirmation(slash.decision, ctx);

    case "tool": {
      // Slash calls are already deterministic — no normalization, by design.
      const outcome = await executeToolCall(slash.call, executeContext(ctx));
      return fromOutcome(outcome, "slash");
    }
  }
}

/**
 * Answer a pending confirmation.
 *
 * Two decisions worth their own paragraph:
 *
 * **The NEWEST pending write is the one being answered.** A user who triggers two
 * confirmations and then says `/yes` means the one they just saw.
 *
 * **Older pending writes are cancelled, not left waiting.** Otherwise this
 * sequence posts money nobody asked for: ask to add $500, ask to add $900,
 * `/yes` (saves $900), then later `/yes` again — which would save the forgotten
 * $500. Cancelling the stragglers and saying so is the only version of this with
 * no phantom write in it.
 */
async function handleConfirmation(
  decision: "yes" | "no",
  ctx: { today: DateKey; context?: ExecuteContext },
): Promise<AgentReply> {
  const pending = pendingToolCalls();

  if (pending.length === 0) {
    return decision === "yes"
      ? {
          text:
            "Nothing is waiting for confirmation, so nothing was saved. " +
            "If you meant to log something, send it again.",
          source: "slash",
          status: "error",
        }
      : {
          text: "Nothing was waiting for confirmation, so nothing was saved.",
          source: "slash",
          status: "ok",
        };
  }

  const newest = pending.reduce<PendingToolCall>(
    (latest, entry) => (entry.createdAt >= latest.createdAt ? entry : latest),
    pending[0],
  );
  const stale = pending.filter((entry) => entry.id !== newest.id);
  for (const entry of stale) cancelPendingToolCall(entry.id);

  const notes =
    stale.length > 0
      ? [
          `Dropped ${stale.length} older unanswered ${
            stale.length === 1 ? "request" : "requests"
          } (${stale.map((entry) => entry.summary).join("; ")}) so they can't be saved later by mistake.`,
        ]
      : [];

  const outcome =
    decision === "yes"
      ? await confirmPendingToolCall(newest, executeContext(ctx))
      : cancelPendingToolCall(newest);

  return fromOutcome(outcome, "slash", notes);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

async function handleModel(
  message: string,
  ctx: { today: DateKey; debug: boolean; opts?: HandleOptions },
): Promise<AgentReply> {
  const { today, debug, opts } = ctx;

  // The payload is checked BEFORE the call. Needle's encoder truncates at 1024
  // tokens without a word, and the tools that vanish are the ones at the end of
  // the list — so an oversized payload does not degrade, it silently removes
  // capabilities. Refusing is the only honest option.
  const toolsJson = needleToolsJson();
  const budget = needleBudget(toolsJson);
  if (!budget.fits) {
    return {
      text:
        `I won't send that to the model: the tool list is ${budget.estimatedTokens} tokens ` +
        `against a ${budget.limit}-token budget, and the encoder would silently drop the ` +
        `last tools instead of failing. Slash commands still work: /help lists them.`,
      source: "system",
      status: "error",
      ...(debug ? { debug: { raw: `${budget.bytes} bytes of tool JSON` } } : {}),
    };
  }

  // `undefined` means "use the real client"; an explicit `null` forces the
  // model-down path, which is how a slash-only deployment turns the model off.
  const client: NeedleClient | null = opts?.needle === undefined ? callNeedle : opts.needle;
  if (!client) return modelDown("no model client is configured");

  let result: NeedleResult;
  try {
    result = await client(message, toolsJson);
  } catch (error) {
    // A throwing client is a model error, never a silent no-op.
    return {
      text:
        `The model call failed, so nothing was saved: ${errorText(error)}. ` +
        `Slash commands still work: /help lists them.`,
      source: "model",
      status: "error",
    };
  }

  switch (result?.status) {
    case "unavailable":
      return modelDown(result.reason);

    case "model-error":
      return {
        text:
          `The model couldn't answer that, so nothing was saved: ${result.reason}. ` +
          `You can always use a slash command: /help lists them.`,
        source: "model",
        status: "error",
      };

    case "unparseable":
      return {
        text:
          "I couldn't turn that into an action. Try phrasing it as an amount and what it " +
          'was for, "10 groceries", or use a slash command (/help).',
        source: "model",
        status: "question",
        ...(debug ? { debug: { raw: result.raw } } : {}),
      };

    case "ok":
      return await executeModelCalls(message, result, { today, debug, opts });

    default:
      return {
        text:
          "The model returned something I don't recognise, so nothing was saved. " +
          "Slash commands still work: /help lists them.",
        source: "model",
        status: "error",
        ...(debug ? { debug: { raw: JSON.stringify(result) } } : {}),
      };
  }
}

function modelDown(reason: string): AgentReply {
  return {
    text:
      `The language model isn't running, so I can't read free-form messages right now ` +
      `(${reason}).\n` +
      `Slash commands still work: send /help for the list, and /balance or a quick ` +
      `command like /coffee work exactly as usual.\n` +
      `To start the model: ${NEEDLE_START_HINT}`,
    source: "system",
    status: "error",
  };
}

async function executeModelCalls(
  message: string,
  result: Extract<NeedleResult, { status: "ok" }>,
  ctx: { today: DateKey; debug: boolean; opts?: HandleOptions },
): Promise<AgentReply> {
  const { today, debug, opts } = ctx;
  const debugInfo = debug
    ? { raw: result.raw, ms: result.ms, calls: result.calls as unknown[] }
    : undefined;

  const calls = Array.isArray(result.calls) ? result.calls : [];
  if (calls.length === 0) {
    return {
      text:
        "I didn't find an action in that. Give me an amount and what it was for " +
        '("10 groceries"), or use a slash command (/help).',
      source: "model",
      status: "question",
      ...(debugInfo ? { debug: debugInfo } : {}),
    };
  }

  const notes: string[] = [];

  // Rule 3: single-shot means one call. Never drop the rest quietly.
  if (calls.length > 1) {
    const ignored = calls.slice(1).map((call) => call?.name ?? "an unnamed tool");
    notes.push(
      `I can only do one thing per message, so I ignored ${ignored.length} other ` +
        `${ignored.length === 1 ? "request" : "requests"} (${ignored.join(", ")}). ` +
        `Send ${ignored.length === 1 ? "it" : "them"} separately.`,
    );
  }

  // Rule 2: normalize before validation. The model has no clock.
  const normalized = normalizeModelCall(calls[0], message, today);
  notes.push(...normalized.notes);

  const outcome = await executeToolCall(normalized.call, executeContext({ today, context: opts?.context }));
  return fromOutcome(outcome, "model", notes, debugInfo);
}

// ---------------------------------------------------------------------------
// Outcome -> reply
// ---------------------------------------------------------------------------

function executeContext(ctx: { today: DateKey; context?: ExecuteContext }): ExecuteContext {
  // An explicit `today` in the injected context wins; otherwise the routed one.
  return { today: ctx.today, ...(ctx.context ?? {}) };
}

/** How a caller answers a pending write, appended so the user is never stuck. */
const CONFIRM_INSTRUCTION = "Reply /yes to save it, or /no to drop it.";

/**
 * Fold an `ExecuteOutcome` into an `AgentReply`.
 *
 * `notes` are appended to `text` as well as carried structurally: a transport
 * that prints only `text` (a terminal, a Telegram message) must still show that
 * a date was ignored or a second call dropped.
 */
function fromOutcome(
  outcome: ExecuteOutcome,
  source: AgentReply["source"],
  notes: string[] = [],
  debug?: AgentReply["debug"],
): AgentReply {
  const lines = [outcome.reply];
  if (outcome.status === "confirm") lines.push(CONFIRM_INSTRUCTION);
  for (const note of notes) lines.push(`Note: ${note}`);

  return {
    text: lines.join("\n"),
    source,
    status: outcome.status,
    toolName: outcome.tool,
    ...(notes.length > 0 ? { notes } : {}),
    ...(debug ? { debug } : {}),
  };
}
