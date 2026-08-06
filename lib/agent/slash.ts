/**
 * The slash-command router: the deterministic half of chat capture.
 *
 * ============================================================================
 * ROUTING IS BINARY. A message starting with "/" is handled HERE, by exact
 * lookup. Anything else goes to the 26M function-calling model. Nothing is
 * shared but the destination.
 * ============================================================================
 *
 * Design rules, and why each exists:
 *
 * 1. **This module SELECTS a tool; it does not execute one.** Its output is a
 *    `ToolCall` — the same `{ name, arguments }` the model produces — so slash
 *    commands and the model converge on one executor, one confirmation policy and
 *    one validation boundary. If this file ever imports a server action, the two
 *    paths have forked and the confirm/undo guarantees stop being one thing.
 *
 * 2. **It is PURE.** Quick commands arrive as data (`QuickCommandLike[]`), never
 *    fetched here, which is what makes the whole surface unit-testable and lets
 *    the same parser run in a terminal REPL, in a Telegram webhook, and in a test.
 *
 * 3. **A leading slash means "be deterministic", so an unknown command must NOT
 *    fall through to the model.** Falling through would make `/recnt` silently
 *    become a guess by a tiny model. It returns `{ kind: "unknown" }` with a
 *    cheap edit-distance suggestion instead.
 *
 * 4. **Nothing is silently defaulted.** `/recent abc` is an error, not 5.
 *    `/undo 3` is an error, not one undo. `/ccmax 12x` is an error, not a post of
 *    the stored amount. Every one of those silent alternatives is a wrong write
 *    that looks exactly like a right one afterwards.
 *
 * 5. **Zero is a value.** `/ccmax 0` posts $0.00. Amount presence is decided by
 *    `=== null`, never by truthiness — this codebase has produced four
 *    falsy-zero bugs already, one of which persisted a live-priced asset at $0.00.
 *
 * 6. **Amounts travel as decimal strings**, matching how `tools.ts` types them
 *    (`moneyArg` = string|number piped through `parseAmount`) and how the app's
 *    dialogs already talk to server actions. Cents are converted to that string
 *    with integer arithmetic only, so it round-trips through `parseAmount` exactly.
 *
 * 7. **No dates are computed here.** `add_transaction` omits `date` entirely and
 *    lets the schema's `dateArg` fill in `todayKey()`. One place computes "today",
 *    in the local calendar, and `toISOString()` never enters the picture.
 */
import { assertCents, formatMoney, isCents, tryParseAmount, type Cents } from "@/lib/money";

import type { ToolCall } from "./tool-schema";
import type { AgentToolName } from "./tools";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A row of `quick_commands`, passed in rather than read.
 *
 * `command` is accepted with OR without a leading slash: the settings UI renders
 * `/{cmd.command}` and stores the bare word, but nothing stops a user from typing
 * the slash into the field, and a shortcut that silently stops working because of
 * one character is a support problem with no visible cause.
 */
export type QuickCommandLike = {
  command: string;
  categoryName: string;
  /** Pre-filled amount in integer cents. */
  amountCents: Cents;
  comment?: string | null;
};

export type SlashResult =
  /** A tool was selected. The caller validates and executes it. */
  | { kind: "tool"; call: ToolCall }
  /** Text to show as-is (`/help`). No tool, no side effect. */
  | { kind: "text"; text: string }
  /** `/yes` or `/no`: resolve the caller's pending write. We do not execute it. */
  | { kind: "confirm"; decision: "yes" | "no" }
  /** A slash command we do not have. Never route this to the model. */
  | { kind: "unknown"; command: string; suggestion?: string }
  /** The command exists but the arguments are wrong. `message` is user-facing. */
  | { kind: "error"; message: string };

/**
 * The `comment` limit from `addTransaction.parameters` in `tools.ts`.
 *
 * Duplicated deliberately so a too-long note produces a sentence about the note
 * instead of a zod dump — and locked to the schema by a test, so the two cannot
 * drift apart unnoticed.
 */
export const COMMENT_MAX_LENGTH = 500;

/** Separator used when a trailing note is appended to a stored comment. */
const NOTE_SEPARATOR = " — ";

// ---------------------------------------------------------------------------
// Cents -> transport string
// ---------------------------------------------------------------------------

/**
 * Integer cents -> the plain decimal string the tool schemas parse.
 *
 * Integer arithmetic only: no `/ 100`, no `toFixed`, no `Intl`. 4550 -> "45.50",
 * 0 -> "0.00". `formatMoney` is for HUMANS (it adds "$" and thousands
 * separators); this is the wire format, and `parseAmount(toAmountArg(c)) === c`
 * for every representable c.
 */
function toAmountArg(cents: Cents): string {
  assertCents(cents, "quick command amount");
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${whole}.${frac}`;
}

// ---------------------------------------------------------------------------
// Argument tokenizing
// ---------------------------------------------------------------------------

/**
 * True when a token was clearly MEANT as an amount, whether or not it parses.
 *
 * This exists so `/ccmax 12x` fails loudly instead of being read as a note and
 * quietly posting the stored $100.00. Two shapes count: something that starts
 * with optional currency decoration followed by a digit, or something with no
 * letters at all that contains a digit or a currency symbol (".5", "(45)", "$").
 */
function looksLikeAmount(token: string): boolean {
  if (token === "") return false;
  if (/^[$€£¥₹₪(+-]*\d/.test(token)) return true;
  return !/[A-Za-z]/.test(token) && /[\d$€£¥₹₪]/.test(token);
}

/** Split `rest` into an optional leading amount and the remaining words. */
function splitAmountAndNote(
  rest: string,
): { cents: Cents | null; note: string } | { error: string } {
  if (rest === "") return { cents: null, note: "" };

  const spaceAt = rest.indexOf(" ");
  const first = spaceAt === -1 ? rest : rest.slice(0, spaceAt);
  const tail = spaceAt === -1 ? "" : rest.slice(spaceAt + 1);

  if (!looksLikeAmount(first)) return { cents: null, note: rest };

  // `=== null`, not `!cents`: 0 is a real override.
  const cents = tryParseAmount(first);
  if (cents === null) {
    return {
      error: `I could not read ${JSON.stringify(first)} as an amount. Write it like 120, 120.50 or 1,234.56, or leave it out to use the stored amount.`,
    };
  }
  return { cents, note: tail };
}

/** Stored comment + typed note, or undefined when both are empty. */
function combineComment(stored: string, note: string): string | undefined {
  const base = stored.trim();
  const extra = note.trim();
  if (base !== "" && extra !== "") return `${base}${NOTE_SEPARATOR}${extra}`;
  return base !== "" ? base : extra !== "" ? extra : undefined;
}

// ---------------------------------------------------------------------------
// Period phrases for /spend
// ---------------------------------------------------------------------------

/**
 * Period phrases recognized at the START of `/spend`'s arguments, longest first,
 * so `/spend last month dining` splits into period + category.
 *
 * The phrase is passed to the tool as free text — resolving it to real dates is
 * the executor's job, not ours. We only decide where the period stops and the
 * category begins, because that boundary is unrecoverable later.
 */
const PERIOD_PHRASES: readonly string[] = [
  "year to date",
  "this month",
  "last month",
  "this week",
  "last week",
  "this year",
  "last year",
  "this quarter",
  "last quarter",
  "all time",
  "yesterday",
  "today",
  "quarter",
  "month",
  "week",
  "year",
  "ytd",
  "mtd",
]
  .slice()
  .sort((a, b) => b.length - a.length);

/** "last 30 days", "last 3 months", … */
const RELATIVE_PERIOD = /^last\s+\d+\s+(?:day|week|month|year)s?\b/i;

function splitPeriodAndCategory(rest: string): { period?: string; category?: string } {
  if (rest === "") return {};

  const relative = RELATIVE_PERIOD.exec(rest);
  if (relative) {
    const category = rest.slice(relative[0].length).trim();
    return { period: relative[0], ...(category !== "" ? { category } : {}) };
  }

  const lower = rest.toLowerCase();
  for (const phrase of PERIOD_PHRASES) {
    if (lower === phrase) return { period: rest };
    if (lower.startsWith(`${phrase} `)) {
      const category = rest.slice(phrase.length).trim();
      return { period: rest.slice(0, phrase.length), ...(category !== "" ? { category } : {}) };
    }
  }
  return { category: rest };
}

// ---------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------

type Context = {
  /** Quick commands that are actually reachable, in listing order. */
  usable: readonly ResolvedQuick[];
  /** Quick-command names a built-in shadows, in listing order. */
  shadowed: readonly string[];
};

export type BuiltInSlashCommand = {
  /** Canonical name first; the rest are aliases. All are matched lowercased. */
  names: readonly [string, ...string[]];
  /** The tool it selects, or null when it is not a tool (`/help`, `/yes`). */
  tool: AgentToolName | null;
  /** How it appears in `/help`, e.g. "/recent [n]". */
  usage: string;
  /** One-line description for `/help`. */
  summary: string;
  run: (rest: string, ctx: Context) => SlashResult;
};

function toolResult(name: AgentToolName, args: Record<string, unknown>): SlashResult {
  return { kind: "tool", call: { name, arguments: args } };
}

/**
 * Reject a tail on a command that takes none.
 *
 * Dropping it silently is how `/undo 3` becomes one undo while the user believes
 * three rows are gone.
 */
function requireNoArgs(usage: string, rest: string): SlashResult | null {
  if (rest === "") return null;
  return {
    kind: "error",
    message: `${usage} takes no arguments, but got ${JSON.stringify(rest)}.`,
  };
}

export const BUILT_IN_SLASH_COMMANDS: readonly BuiltInSlashCommand[] = [
  {
    names: ["balance", "balances"],
    tool: "get_balances",
    usage: "/balance",
    summary: "accounts, totals and net worth",
    run: (rest) => requireNoArgs("/balance", rest) ?? toolResult("get_balances", {}),
  },
  {
    names: ["recent"],
    tool: "list_recent",
    usage: "/recent [n]",
    summary: "the last n transactions (default 5)",
    run: (rest) => {
      // Bare digits only. "1.5", "-3", "5x" and "5 6" are all mistakes worth
      // saying out loud; the 1-20 range is left to the tool's schema so the
      // bound is written down in exactly one place.
      if (rest === "") return toolResult("list_recent", { limit: 5 });
      if (!/^\d+$/.test(rest)) {
        return {
          kind: "error",
          message: `/recent expects a whole number of transactions, but got ${JSON.stringify(rest)}. Try /recent 10.`,
        };
      }
      return toolResult("list_recent", { limit: Number(rest) });
    },
  },
  {
    names: ["budget"],
    tool: "budget_status",
    usage: "/budget [category]",
    summary: "what is left of each budget",
    run: (rest) => toolResult("budget_status", rest === "" ? {} : { category: rest }),
  },
  {
    names: ["spend"],
    tool: "spend_summary",
    usage: "/spend [period] [category]",
    summary: "spending over a period, e.g. /spend last month dining",
    run: (rest) => toolResult("spend_summary", splitPeriodAndCategory(rest)),
  },
  {
    names: ["prices"],
    tool: "refresh_prices",
    usage: "/prices",
    summary: "re-fetch live metal and crypto prices",
    run: (rest) => requireNoArgs("/prices", rest) ?? toolResult("refresh_prices", {}),
  },
  {
    names: ["undo"],
    tool: "undo_last",
    usage: "/undo",
    summary: "reverse the last change made from chat",
    run: (rest) => requireNoArgs("/undo", rest) ?? toolResult("undo_last", {}),
  },
  {
    names: ["yes", "y"],
    tool: null,
    usage: "/yes",
    summary: "confirm the pending write (/y)",
    run: (rest) =>
      requireNoArgs("/yes", rest) ?? { kind: "confirm", decision: "yes" },
  },
  {
    names: ["no", "n", "cancel"],
    tool: null,
    usage: "/no",
    summary: "cancel it (/n, /cancel)",
    run: (rest) => requireNoArgs("/no", rest) ?? { kind: "confirm", decision: "no" },
  },
  {
    names: ["help", "h", "?"],
    tool: null,
    usage: "/help",
    summary: "this list",
    run: (rest, ctx) =>
      requireNoArgs("/help", rest) ?? { kind: "text", text: renderHelp(ctx) },
  },
];

const BUILT_IN_BY_NAME: ReadonlyMap<string, BuiltInSlashCommand> = new Map(
  BUILT_IN_SLASH_COMMANDS.flatMap((spec) => spec.names.map((n) => [n, spec] as const)),
);

// ---------------------------------------------------------------------------
// Quick commands
// ---------------------------------------------------------------------------

type ResolvedQuick = {
  /** Lowercased, slash-stripped lookup key. */
  name: string;
  row: QuickCommandLike;
};

function normalizeCommandName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/^\/+/, "").trim().toLowerCase();
}

/**
 * Index the rows: drop unusable ones, keep the first of any duplicate, and record
 * which names a built-in shadows.
 *
 * Built-ins win, always. A quick command must never be able to redefine `/undo`
 * or `/no` — the safety valve and the cancel key are not user-overridable.
 */
function resolveQuickCommands(rows: readonly QuickCommandLike[]): {
  byName: Map<string, QuickCommandLike>;
  usable: ResolvedQuick[];
  shadowed: string[];
} {
  const byName = new Map<string, QuickCommandLike>();
  const usable: ResolvedQuick[] = [];
  const shadowed: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const name = normalizeCommandName(row?.command);
    if (name === "" || seen.has(name)) continue;
    seen.add(name);

    if (BUILT_IN_BY_NAME.has(name)) {
      shadowed.push(name);
      continue;
    }
    byName.set(name, row);
    usable.push({ name, row });
  }

  return { byName, usable, shadowed };
}

/** Build the `add_transaction` call for a quick command. */
function runQuickCommand(row: QuickCommandLike, rest: string): SlashResult {
  // `isCents` is the safe-integer check; a float here means a corrupt row, and
  // emitting it would put a fraction of a cent on the wire.
  if (!isCents(row.amountCents)) {
    return {
      kind: "error",
      message: `The quick command "/${normalizeCommandName(row.command)}" has a stored amount that is not integer cents (${String(row.amountCents)}). Fix it in Settings.`,
    };
  }

  const split = splitAmountAndNote(rest);
  if ("error" in split) return { kind: "error", message: split.error };

  // `=== null` is the presence test. A 0 override is a real $0.00.
  const cents = split.cents === null ? row.amountCents : split.cents;
  const comment = combineComment(row.comment ?? "", split.note);

  if (comment !== undefined && comment.length > COMMENT_MAX_LENGTH) {
    return {
      kind: "error",
      message: `That note is too long: ${comment.length} characters, and a comment can hold ${COMMENT_MAX_LENGTH}.`,
    };
  }

  return toolResult("add_transaction", {
    amount: toAmountArg(cents),
    category: row.categoryName,
    ...(comment !== undefined ? { comment } : {}),
    // `date` is deliberately omitted: the tool schema fills in today, locally.
  });
}

// ---------------------------------------------------------------------------
// Suggestions for a typo
// ---------------------------------------------------------------------------

/** Levenshtein distance, two rows. Short strings only; no memoization needed. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Every name the router answers to, aliases included. */
function knownNames(quick: readonly ResolvedQuick[]): string[] {
  return [...BUILT_IN_SLASH_COMMANDS.flatMap((s) => [...s.names]), ...quick.map((q) => q.name)];
}

/**
 * The nearest known command to what the user typed, or undefined.
 *
 * Prefix first ("/bal" -> "/balance"), because abbreviating is more common than
 * misspelling, then edit distance within a tight budget — 1 for short names, 2
 * for longer ones. A wrong suggestion is worse than none: it invites the user to
 * run a command they did not mean, so the budget stays small. Ties break on the
 * shorter name, then alphabetically, so the answer is deterministic.
 */
export function suggestSlashCommand(
  typed: string,
  quickCommands: readonly QuickCommandLike[] = [],
): string | undefined {
  const target = normalizeCommandName(typed);
  if (target === "") return undefined;

  const { usable } = resolveQuickCommands(quickCommands);
  const candidates = knownNames(usable).sort(
    (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  );

  const prefix = candidates.find((name) => name !== target && name.startsWith(target));
  if (prefix) return `/${prefix}`;

  const budget = target.length <= 4 ? 1 : 2;
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const distance = editDistance(target, name);
    if (distance <= budget && (best === undefined || distance < best.distance)) {
      best = { name, distance };
    }
  }
  return best ? `/${best.name}` : undefined;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function describeQuick(row: QuickCommandLike, name: string): string {
  // Never let one corrupt row blow up the discovery surface.
  const amount = isCents(row.amountCents) ? formatMoney(row.amountCents) : "(bad amount)";
  const comment = (row.comment ?? "").trim();
  return `/${name}, ${row.categoryName} ${amount}${comment !== "" ? ` "${comment}"` : ""}`;
}

function renderHelp(ctx: Context): string {
  const lines: string[] = ["Commands"];

  for (const spec of BUILT_IN_SLASH_COMMANDS) {
    lines.push(`${spec.usage}: ${spec.summary}`);
  }

  lines.push("", "Your quick commands: /name [amount] [note]");
  if (ctx.usable.length === 0) {
    lines.push("(none yet: add a quick command in Settings)");
  } else {
    for (const q of ctx.usable) lines.push(describeQuick(q.row, q.name));
    // Concrete and copy-pasteable, built from a real shortcut: [amount] is the
    // affordance people actually want, and that trailing words are APPENDED to
    // the stored comment (not replacing it) is not guessable.
    lines.push(
      "[amount] overrides the stored amount; words after it are appended to the note.",
      `e.g. /${ctx.usable[0].name} 120 annual plan`,
    );
  }

  if (ctx.shadowed.length > 0) {
    lines.push(
      `⚠ ${ctx.shadowed.map((n) => `/${n}`).join(", ")}: a built-in command owns that name, so your quick command never runs. Rename it in Settings.`,
    );
  }

  lines.push("", "Anything without a leading / is read as plain language.");
  return lines.join("\n");
}

/** The `/help` body. Exported so a caller can print it without faking an input. */
export function slashHelpText(quickCommands: readonly QuickCommandLike[] = []): string {
  const { usable, shadowed } = resolveQuickCommands(quickCommands);
  return renderHelp({ usable, shadowed });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** True when `input` should be handled by this module rather than the model. */
export function isSlashCommand(input: string): boolean {
  return typeof input === "string" && input.trim().startsWith("/");
}

/**
 * Route one chat message.
 *
 * Returns null — and ONLY null — when the message is not a slash command, which
 * is the caller's signal to hand it to the model. Every other outcome, including
 * a typo, is resolved here.
 */
export function parseSlash(
  input: string,
  quickCommands: readonly QuickCommandLike[] = [],
): SlashResult | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  // One command word, then the rest with internal whitespace collapsed so a
  // pasted note does not carry newlines or double spaces into a comment.
  const body = trimmed.slice(1);
  const spaceAt = body.search(/\s/);
  const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
  const rest = (spaceAt === -1 ? "" : body.slice(spaceAt)).trim().replace(/\s+/g, " ");

  if (name === "") {
    return { kind: "error", message: 'Type a command name after the "/": /help lists them.' };
  }

  const { byName, usable, shadowed } = resolveQuickCommands(quickCommands);

  // Built-ins first. This is what makes them unshadowable.
  const builtIn = BUILT_IN_BY_NAME.get(name);
  if (builtIn) return builtIn.run(rest, { usable, shadowed });

  const quick = byName.get(name);
  if (quick) return runQuickCommand(quick, rest);

  const suggestion = suggestSlashCommand(name, quickCommands);
  return { kind: "unknown", command: `/${name}`, ...(suggestion ? { suggestion } : {}) };
}
