/**
 * The tool executor: the ONE place where a validated tool call becomes a real
 * database change and a sentence the user can check.
 *
 * ============================================================================
 * WHERE THIS SITS
 * ============================================================================
 *
 * A chat message is routed either by `lib/agent/slash.ts` (deterministic) or by
 * the on-device 26M function-calling model. Both converge here, and this module
 * is the only component that calls a server action. Nothing below it opens the
 * database: the app process stays the single writer (see lib/db/client.ts).
 *
 * ============================================================================
 * THE FOUR GATES, IN ORDER
 * ============================================================================
 *
 * 1. **Known tool.** An unknown name is an error, never a guess at a near match.
 * 2. **Zod parse.** `tool.parameters.safeParse` is the trust boundary. A 26M model
 *    emits plausible-but-wrong arguments ("twelve dollars", "next tuesday"), and
 *    `parseAmount`/`parseFlexibleDate` inside those schemas fail LOUDLY rather
 *    than producing 0 or Invalid Date. A rejection returns a message and writes
 *    nothing.
 * 3. **Name resolution.** `category` / `account` / `asset` arrive as free strings
 *    because Needle's dialect has no enum. They are resolved against the real
 *    rows in lib/agent/resolve.ts; ambiguous or unknown is a QUESTION, never a
 *    pick and never an implicit insert.
 * 4. **Confirmation.** `confirm: "always"`, or `"overThreshold"` at or above
 *    `CONFIRM_THRESHOLD_CENTS` ($200), returns a PENDING descriptor and writes
 *    nothing. `confirmPendingToolCall` executes it later — once.
 *
 * ============================================================================
 * THE REPLY IS THE PRODUCT
 * ============================================================================
 *
 * A write echoes what landed AND its budget impact:
 *
 *     Added $10.00 → Groceries. $37.50 left of $100.00 this month.
 *
 * Instant budget feedback at the moment of spending is the behavioural point of
 * this app, and it is also the cheapest misparse detector available: the user
 * still remembers the purchase, so a wrong amount or category is obvious while it
 * is still one `undo` away. Every figure goes through `formatMoney` — never
 * `$${x.toFixed(2)}`, which drifts and ignores the currency.
 *
 * Errors are never swallowed. Actions in this codebase return `{ error }` on
 * failure and several dialogs historically reported success anyway; every action
 * result here is inspected and the message is put in the reply.
 */
import {
  CONFIRM_THRESHOLD_CENTS,
  findTool,
  type AgentTool,
} from "./tools";
import type { ToolCall } from "./tool-schema";
import {
  describeResolution,
  resolveName,
  type Resolution,
  type Resolvable,
} from "./resolve";
import { agentUndoJournal, UndoJournal, type AssetValueSnapshot } from "./undo";

import { absCents, formatMoney, negateCents, sumCents, type Cents } from "@/lib/money";
import { fromDateKey, isDateKey, todayKey, toDateKey, type DateKey } from "@/lib/dates";
import { periodContaining, spendInRange, type BudgetPeriod } from "@/lib/budgets";
import {
  categoryBreakdown,
  centsToDecimalString,
  dayBefore,
  flowInRange,
  previousPeriodRange,
  toReportTransactions,
} from "@/lib/reports";
import { isSpendable, isTransfer } from "@/lib/cash-balance";
// The date wire format lives with the dialog that established it: a bare
// 'YYYY-MM-DD' is read by `new Date(...)` as UTC midnight, which renders as the
// PREVIOUS day west of UTC. Reusing it keeps one definition of that rule.
import { toTransactionDateValue } from "@/components/transactions/transaction-form-logic";

import { getCategories } from "@/app/actions/categories";
import { getAccounts, getAccountBalances, getNetWorth } from "@/app/actions/accounts";
import {
  createTransaction,
  createTransfer,
  deleteTransaction,
  getTransactions,
} from "@/app/actions/transactions";
import { getSpendVsBudget } from "@/app/actions/budgets";
import { getAssets, updateAsset } from "@/app/actions/assets";
import { updateLivePricedAsset } from "@/app/actions/crypto";

// ---------------------------------------------------------------------------
// The row shapes this module needs
// ---------------------------------------------------------------------------
//
// Declared structurally rather than as `typeof <action>` so a test can inject a
// small stub (a price refresh must not hit the network in a unit test) while the
// real actions still type-check against them at the assignment below.

/** Money-out results are always `{ error }` on failure — never a thrown value. */
export type WriteOutcome<T = unknown> = {
  success?: boolean;
  data?: T | null;
  error?: string;
};

export type CategoryRow = { id: number; name: string; type: string };
export type AccountRow = {
  id: number;
  name: string;
  kind: string;
  currency?: string | null;
  archived?: boolean | null;
};
export type TransactionRow = {
  id: number;
  date: Date;
  categoryId?: number | null;
  accountId?: number | null;
  transferAccountId?: number | null;
  amountCents: Cents;
  comment?: string | null;
  pending?: boolean | null;
};
export type AccountBalanceRow = AccountRow & { balanceCents: Cents; owedCents: Cents };
export type NetWorthRow = {
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
  unassignedCents: Cents;
};
export type BudgetStatusRow = {
  categoryId: number;
  categoryName: string;
  categoryType: string;
  period: BudgetPeriod;
  startKey: DateKey;
  endKey: DateKey;
  limitCents: Cents;
  availableCents: Cents;
  spentCents: Cents;
  remainingCents: Cents;
  overBudget: boolean;
};
export type AssetRow = {
  id: number;
  category: string;
  currentValueCents: Cents;
  currency?: string | null;
  notes?: string | null;
  commodityType?: string | null;
  quantity?: number | null;
  unit?: string | null;
  priceSymbol?: string | null;
  useLivePrice?: boolean | null;
};

/** Every server action the executor may call. Nothing else touches the database. */
export type ExecutorActions = {
  getCategories: () => Promise<CategoryRow[]>;
  getAccounts: (options?: { includeArchived?: boolean }) => Promise<AccountRow[]>;
  getTransactions: () => Promise<TransactionRow[]>;
  getAccountBalances: (options?: { includeArchived?: boolean }) => Promise<AccountBalanceRow[]>;
  getNetWorth: () => Promise<NetWorthRow>;
  getSpendVsBudget: (options?: {
    dateKey?: DateKey;
    categoryId?: number;
  }) => Promise<BudgetStatusRow[]>;
  getAssets: () => Promise<AssetRow[]>;
  createTransaction: (formData: FormData) => Promise<WriteOutcome<{ id: number }>>;
  createTransfer: (formData: FormData) => Promise<WriteOutcome<{ id: number }>>;
  deleteTransaction: (id: number) => Promise<WriteOutcome>;
  updateAsset: (
    id: number,
    formData: FormData,
  ) => Promise<WriteOutcome<{ id: number; currentValueCents: Cents }>>;
  updateLivePricedAsset: (
    id: number,
    formData: FormData,
  ) => Promise<WriteOutcome<{ id: number; currentValueCents: Cents }>>;
};

/** The real actions. The only binding of this module to app/actions/*. */
const DEFAULT_ACTIONS: ExecutorActions = {
  getCategories,
  getAccounts,
  getTransactions,
  getAccountBalances,
  getNetWorth,
  getSpendVsBudget,
  getAssets,
  createTransaction,
  createTransfer,
  deleteTransaction,
  updateAsset,
  updateLivePricedAsset,
};

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** A confirmed-later write. Holds the RAW call, which is re-validated on confirm. */
export type PendingToolCall = {
  /** Opaque single-use token. */
  id: string;
  tool: string;
  /** "add $250.00 → Groceries" — the phrase the confirmation prompt uses. */
  summary: string;
  /** Epoch millis, so a caller can expire a stale prompt. */
  createdAt: number;
  call: ToolCall;
};

/** Why the executor is asking the user something instead of acting. */
export type QuestionReason =
  | "ambiguous-name"
  | "unknown-name"
  | "unknown-period"
  | "nothing-to-undo"
  | "not-reversible";

export type ErrorReason =
  | "unknown-tool"
  | "invalid-arguments"
  | "action-failed"
  | "refused"
  | "expired-confirmation";

export type ExecuteOutcome =
  /** Done. For a write, `undoId` names the journal entry `undo_last` would reverse. */
  | { status: "ok"; tool: string; reply: string; undoId?: string }
  /** Nothing was written. Hand `pending` (or its id) to `confirmPendingToolCall`. */
  | { status: "confirm"; tool: string; reply: string; pending: PendingToolCall }
  /** Nothing was written. The user must answer before this can proceed. */
  | { status: "question"; tool: string; reply: string; reason: QuestionReason }
  /** Nothing was written. `details` carries the validator's messages, if any. */
  | { status: "error"; tool: string; reply: string; reason: ErrorReason; details?: string[] };

export type ExecuteContext = {
  /** Today, for period parsing and "is this the current month" wording. */
  today?: DateKey;
  /** Currency for figures that are not tied to one row. Default "USD". */
  currency?: string;
  /** Undo journal. Defaults to the process-wide `agentUndoJournal`. */
  journal?: UndoJournal;
  /** Override individual actions (tests, and the network-touching price refresh). */
  actions?: Partial<ExecutorActions>;
  /** Injectable clock for journal/pending timestamps. */
  now?: () => number;
};

type Ctx = {
  today: DateKey;
  currency: string;
  journal: UndoJournal;
  actions: ExecutorActions;
  now: () => number;
};

function resolveContext(ctx?: ExecuteContext): Ctx {
  const today = ctx?.today ?? todayKey();
  if (!isDateKey(today)) throw new Error(`Invalid today: ${JSON.stringify(ctx?.today)}`);
  return {
    today,
    currency: ctx?.currency ?? "USD",
    journal: ctx?.journal ?? agentUndoJournal,
    actions: { ...DEFAULT_ACTIONS, ...(ctx?.actions ?? {}) },
    now: ctx?.now ?? (() => Date.now()),
  };
}

// ---------------------------------------------------------------------------
// Pending confirmations
// ---------------------------------------------------------------------------
//
// In-process, like the undo journal, and for the same reason: a second writer
// under data/ risks last-writer-wins on the whole database. A confirmation that
// does not survive a restart is a re-ask; a corrupted ledger is not recoverable.

const pendingStore = new Map<string, PendingToolCall>();
let pendingSequence = 0;

/** Every confirmation still awaiting an answer, oldest first. */
export function pendingToolCalls(): PendingToolCall[] {
  return [...pendingStore.values()];
}

export function pendingToolCall(id: string): PendingToolCall | null {
  return pendingStore.get(id) ?? null;
}

/** Drop a pending confirmation. Idempotent. */
export function cancelPendingToolCall(pending: PendingToolCall | string): ExecuteOutcome {
  const id = typeof pending === "string" ? pending : pending.id;
  const entry = pendingStore.get(id);
  pendingStore.delete(id);
  return {
    status: "ok",
    tool: entry?.tool ?? "unknown",
    reply: entry
      ? `Cancelled: ${entry.summary}. Nothing was saved.`
      : "That confirmation is already gone. Nothing was saved.",
  };
}

/** Forget all pending confirmations. For tests; there is no user path to it. */
export function clearPendingToolCalls(): void {
  pendingStore.clear();
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Execute one validated-by-us tool call.
 *
 * Never throws for anything the model or the user can cause: an unknown tool, bad
 * arguments, an unresolvable name and a failing action all come back as an
 * outcome carrying a sentence to say. (A genuinely broken context — an invalid
 * `today` — still throws, because that is a programming error in the caller.)
 */
export async function executeToolCall(
  call: ToolCall,
  context?: ExecuteContext,
): Promise<ExecuteOutcome> {
  const ctx = resolveContext(context);
  const name = typeof call?.name === "string" ? call.name : "";
  const tool = findTool(name);

  // GATE 1: a name we do not implement. No fuzzy matching on tool names — the
  // model either called a real tool or it did not.
  if (!tool) {
    return {
      status: "error",
      tool: name || "unknown",
      reason: "unknown-tool",
      reply: `I don't have a tool called "${name}", so nothing happened.`,
    };
  }

  return runTool(tool, call, ctx, { skipConfirm: false });
}

/**
 * Execute a previously-returned pending write, now that the user has confirmed.
 *
 * SINGLE USE: the token is consumed before any write, so a double-clicked
 * "confirm" cannot post the same $4,000 transaction twice. The arguments are
 * re-parsed and the names re-resolved against current rows, because a category
 * could have been renamed between the prompt and the answer.
 */
export async function confirmPendingToolCall(
  pending: PendingToolCall | string,
  context?: ExecuteContext,
): Promise<ExecuteOutcome> {
  const id = typeof pending === "string" ? pending : pending.id;
  const entry = pendingStore.get(id);
  pendingStore.delete(id);

  if (!entry) {
    const tool = typeof pending === "string" ? "unknown" : pending.tool;
    return {
      status: "error",
      tool,
      reason: "expired-confirmation",
      reply:
        "I don't have that pending change any more, so nothing was saved. " +
        "Tell me again if you still want it.",
    };
  }

  const ctx = resolveContext(context);
  const tool = findTool(entry.call.name);
  if (!tool) {
    return {
      status: "error",
      tool: entry.tool,
      reason: "unknown-tool",
      reply: `I don't have a tool called "${entry.call.name}" any more, so nothing happened.`,
    };
  }
  return runTool(tool, entry.call, ctx, { skipConfirm: true });
}

type RunOptions = { skipConfirm: boolean };

async function runTool(
  tool: AgentTool,
  call: ToolCall,
  ctx: Ctx,
  options: RunOptions,
): Promise<ExecuteOutcome> {
  // GATE 2: the trust boundary. Everything downstream may assume typed, coerced
  // arguments — integer cents and a real calendar day — because of this line.
  const parsed = tool.parameters.safeParse(call.arguments ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${where}${issue.message}`;
    });
    const lead =
      tool.kind === "write"
        ? "Nothing was saved: I couldn't read that"
        : "I couldn't read that";
    return {
      status: "error",
      tool: tool.name,
      reason: "invalid-arguments",
      reply: `${lead}: ${details.join("; ")}`,
      details,
    };
  }

  const args = parsed.data as Record<string, unknown>;

  switch (tool.name) {
    case "add_transaction":
      return addTransaction(tool, args as AddTransactionArgs, call, ctx, options);
    case "add_transfer":
      return addTransfer(tool, args as AddTransferArgs, call, ctx, options);
    case "undo_last":
      return undoLast(ctx);
    case "get_balances":
      return getBalances(ctx);
    case "spend_summary":
      return spendSummary(args as SpendSummaryArgs, ctx);
    case "budget_status":
      return budgetStatus(args as BudgetStatusArgs, ctx);
    case "list_recent":
      return listRecent(args as ListRecentArgs, ctx);
    case "set_asset_value":
      return setAssetValue(tool, args as SetAssetValueArgs, call, ctx, options);
    case "refresh_prices":
      return refreshPrices(ctx);
    default:
      // Unreachable while AGENT_TOOLS and this switch agree. If a tool is added
      // to the registry and not here, say so instead of silently doing nothing.
      return {
        status: "error",
        tool: tool.name,
        reason: "unknown-tool",
        reply: `I know about "${tool.name}" but I don't know how to run it yet, so nothing happened.`,
      };
  }
}

// ---------------------------------------------------------------------------
// Confirmation gate
// ---------------------------------------------------------------------------

/**
 * Whether this call must be confirmed before it is executed.
 *
 * `overThreshold` with no amount to compare returns TRUE: a write that gates on a
 * figure it cannot see is confirmed rather than waved through. (No current tool
 * hits that branch — zod guarantees the amount — but the default must fail safe.)
 */
export function requiresConfirmation(tool: AgentTool, amountCents: Cents | null): boolean {
  if (tool.confirm === "never") return false;
  if (tool.confirm === "always") return true;
  if (amountCents === null) return true;
  return absCents(amountCents) >= CONFIRM_THRESHOLD_CENTS;
}

function askToConfirm(
  tool: AgentTool,
  summary: string,
  call: ToolCall,
  ctx: Ctx,
): ExecuteOutcome {
  const pending: PendingToolCall = {
    id: `confirm-${++pendingSequence}`,
    tool: tool.name,
    summary,
    createdAt: ctx.now(),
    call,
  };
  pendingStore.set(pending.id, pending);

  const because =
    tool.confirm === "overThreshold"
      ? ` That's at or above my ${formatMoney(CONFIRM_THRESHOLD_CENTS, ctx.currency)} check-with-you line, so nothing`
      : " Nothing";
  return {
    status: "confirm",
    tool: tool.name,
    pending,
    reply: `Confirm first: ${summary}.${because} has been saved yet.`,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** `{ error }` from an action, or null when it really succeeded. */
function actionError(outcome: WriteOutcome | null | undefined): string | null {
  if (!outcome) return "the action returned nothing at all";
  if (typeof outcome.error === "string" && outcome.error.trim() !== "") return outcome.error.trim();
  if (outcome.success !== true) return "the action did not report success";
  return null;
}

function question(tool: string, reason: QuestionReason, reply: string): ExecuteOutcome {
  return { status: "question", tool, reply, reason };
}

function failed(tool: string, reason: ErrorReason, reply: string): ExecuteOutcome {
  return { status: "error", tool, reply, reason };
}

/** Turn a non-resolved name into the question to ask. */
function nameQuestion<T extends Resolvable>(
  tool: string,
  resolution: Resolution<T>,
  label: string,
  all: readonly Resolvable[],
): ExecuteOutcome {
  return question(
    tool,
    resolution.status === "ambiguous" ? "ambiguous-name" : "unknown-name",
    describeResolution(resolution, label, all),
  );
}

/** "this month" when today is inside the range, else the period's own key. */
function periodWord(period: BudgetPeriod, range: { startKey: DateKey; endKey: DateKey }, today: DateKey): string {
  const current = today >= range.startKey && today <= range.endKey;
  if (current) {
    return period === "weekly" ? "this week" : period === "yearly" ? "this year" : "this month";
  }
  return `in ${range.startKey === range.endKey ? range.startKey : `${range.startKey}..${range.endKey}`}`;
}

/**
 * The budget sentence that follows a write — the behavioural point of the app.
 *
 * Prefers the monthly budget when a category has more than one period in force,
 * because "this month" is the frame people hold spending in. With no budget at
 * all it reports period-to-date activity instead of staying silent: a number the
 * user can sanity-check is what catches a misparse.
 */
async function budgetImpact(
  category: CategoryRow,
  dateKey: DateKey,
  ctx: Ctx,
): Promise<string> {
  const rows = await ctx.actions.getSpendVsBudget({ dateKey, categoryId: category.id });
  const row = rows.find((candidate) => candidate.period === "monthly") ?? rows[0];

  if (row) {
    const when = periodWord(row.period, row, ctx.today);
    const available = formatMoney(row.availableCents, ctx.currency);
    if (row.remainingCents > 0) {
      return `${formatMoney(row.remainingCents, ctx.currency)} left of ${available} ${when}.`;
    }
    if (row.remainingCents === 0) {
      // Zero is a real value, not "no budget": exactly at the limit.
      return `Exactly at your ${available} ${when}; nothing left.`;
    }
    return `${formatMoney(absCents(row.remainingCents), ctx.currency)} over your ${available} ${when}.`;
  }

  // No budget in force. Report what has been booked to the category this period.
  const range = periodContaining("monthly", dateKey);
  const rows2 = toReportTransactions(await ctx.actions.getTransactions());
  const total = spendInRange(rows2, category.id, range.startKey, range.endKey);
  const when = periodWord("monthly", range, ctx.today);
  if (category.type === "Income") {
    return `${formatMoney(total, ctx.currency)} of ${category.name} income ${when}.`;
  }
  return `No budget on ${category.name}; ${formatMoney(total, ctx.currency)} booked there ${when}.`;
}

/** " on 2026-07-04", or "" when it is today — the common case needs no date. */
function dateSuffix(dateKey: DateKey, today: DateKey): string {
  return dateKey === today ? "" : ` on ${dateKey}`;
}

// ---------------------------------------------------------------------------
// add_transaction
// ---------------------------------------------------------------------------

type AddTransactionArgs = {
  amount: Cents;
  category: string;
  date: DateKey;
  account?: string;
  comment?: string;
  pending?: boolean;
};

async function addTransaction(
  tool: AgentTool,
  args: AddTransactionArgs,
  call: ToolCall,
  ctx: Ctx,
  options: RunOptions,
): Promise<ExecuteOutcome> {
  const categories = await ctx.actions.getCategories();
  const resolved = resolveName(args.category, categories);
  if (resolved.status !== "resolved") {
    // A missing category is a question, NEVER an insert: a chat typo must not be
    // able to grow the category list.
    return nameQuestion(tool.name, resolved, "category", categories);
  }
  const category = resolved.row;

  let account: AccountRow | undefined;
  if (args.account !== undefined) {
    const accounts = await ctx.actions.getAccounts();
    const resolvedAccount = resolveName(args.account, accounts);
    if (resolvedAccount.status !== "resolved") {
      return nameQuestion(tool.name, resolvedAccount, "account", accounts);
    }
    account = resolvedAccount.row;
  }

  const where = account ? ` from ${account.name}` : "";
  const summary =
    `add ${formatMoney(args.amount, ctx.currency)} → ${category.name}` +
    `${dateSuffix(args.date, ctx.today)}${where}`;

  // GATE 4. Nothing has touched the database up to this point.
  if (!options.skipConfirm && requiresConfirmation(tool, args.amount)) {
    return askToConfirm(tool, summary, call, ctx);
  }

  const formData = new FormData();
  formData.set("categoryId", String(category.id));
  formData.set("amount", centsToDecimalString(args.amount));
  formData.set("date", toTransactionDateValue(fromDateKey(args.date)));
  // Empty string means "not supplied" to `resolveAccountId`, which then picks the
  // default account. Sending nothing at all would mean the same, but being
  // explicit keeps the transport shape stable.
  formData.set("accountId", account ? String(account.id) : "");
  if (args.comment !== undefined) formData.set("comment", args.comment);
  formData.set("pending", args.pending === true ? "true" : "false");

  const result = await ctx.actions.createTransaction(formData);
  const error = actionError(result);
  if (error) {
    return failed(tool.name, "action-failed", `Nothing was saved: ${error}.`);
  }
  const createdId = result.data?.id;

  const pendingNote = args.pending === true ? " (pending, not counted yet)" : "";
  const undoId = ctx.journal.record({
    tool: tool.name,
    at: ctx.now(),
    label: `${formatMoney(args.amount, ctx.currency)} → ${category.name} on ${args.date}`,
    reverse:
      typeof createdId === "number"
        ? {
            kind: "delete-transaction",
            transactionId: createdId,
            expect: { amountCents: args.amount, dateKey: args.date },
          }
        // The write succeeded but returned no id, so there is nothing to delete
        // by. Saying so beats deleting "the newest row" and hoping.
        : { kind: "none", reason: "the write did not report which row it created" },
  }).id;

  const impact = await budgetImpact(category, args.date, ctx);
  return {
    status: "ok",
    tool: tool.name,
    undoId,
    reply:
      `Added ${formatMoney(args.amount, ctx.currency)} → ${category.name}` +
      `${dateSuffix(args.date, ctx.today)}${where}${pendingNote}. ${impact}`,
  };
}

// ---------------------------------------------------------------------------
// add_transfer
// ---------------------------------------------------------------------------

type AddTransferArgs = {
  from_account: string;
  to_account: string;
  amount: Cents;
  date: DateKey;
  comment?: string;
};

async function addTransfer(
  tool: AgentTool,
  args: AddTransferArgs,
  call: ToolCall,
  ctx: Ctx,
  options: RunOptions,
): Promise<ExecuteOutcome> {
  const accounts = await ctx.actions.getAccounts();
  const from = resolveName(args.from_account, accounts);
  if (from.status !== "resolved") return nameQuestion(tool.name, from, "account", accounts);
  const to = resolveName(args.to_account, accounts);
  if (to.status !== "resolved") return nameQuestion(tool.name, to, "account", accounts);

  if (from.row.id === to.row.id) {
    return failed(
      tool.name,
      "refused",
      `"${args.from_account}" and "${args.to_account}" are the same account (${from.row.name}), ` +
        `so there is nothing to move. Nothing was saved.`,
    );
  }

  const summary =
    `move ${formatMoney(args.amount, ctx.currency)} from ${from.row.name} → ${to.row.name}` +
    dateSuffix(args.date, ctx.today);

  if (!options.skipConfirm && requiresConfirmation(tool, args.amount)) {
    return askToConfirm(tool, summary, call, ctx);
  }

  const formData = new FormData();
  formData.set("fromAccountId", String(from.row.id));
  formData.set("toAccountId", String(to.row.id));
  formData.set("amount", centsToDecimalString(args.amount));
  formData.set("date", toTransactionDateValue(fromDateKey(args.date)));
  if (args.comment !== undefined) formData.set("comment", args.comment);

  const result = await ctx.actions.createTransfer(formData);
  const error = actionError(result);
  if (error) return failed(tool.name, "action-failed", `Nothing was saved: ${error}.`);

  const createdId = result.data?.id;
  const undoId = ctx.journal.record({
    tool: tool.name,
    at: ctx.now(),
    label: `${formatMoney(args.amount, ctx.currency)} from ${from.row.name} → ${to.row.name} on ${args.date}`,
    reverse:
      typeof createdId === "number"
        ? {
            kind: "delete-transaction",
            transactionId: createdId,
            expect: { amountCents: args.amount, dateKey: args.date },
          }
        : { kind: "none", reason: "the write did not report which row it created" },
  }).id;

  // Both new balances, so the user can see the money on the other side.
  const balances = await ctx.actions.getAccountBalances({ includeArchived: true });
  const after = [from.row.id, to.row.id]
    .map((id) => balances.find((row) => row.id === id))
    .filter((row): row is AccountBalanceRow => row !== undefined)
    .map((row) => `${row.name} ${formatMoney(row.balanceCents, row.currency ?? ctx.currency)}`)
    .join(", ");

  return {
    status: "ok",
    tool: tool.name,
    undoId,
    reply:
      `Moved ${formatMoney(args.amount, ctx.currency)} from ${from.row.name} → ${to.row.name}` +
      `${dateSuffix(args.date, ctx.today)}.${after ? ` ${after}.` : ""}` +
      ` A transfer is not income or expense, so no budget moved.`,
  };
}

// ---------------------------------------------------------------------------
// undo_last
// ---------------------------------------------------------------------------

async function undoLast(ctx: Ctx): Promise<ExecuteOutcome> {
  const entry = ctx.journal.peek();
  if (!entry) {
    return question(
      "undo_last",
      "nothing-to-undo",
      "Nothing to undo. I only track changes made here in chat, and that list is " +
        "cleared when the app restarts: anything older has to be changed on the " +
        "transactions page.",
    );
  }

  if (entry.reverse.kind === "none") {
    // Honesty over approximation. Undoing "something like" a money change is
    // worse than telling the user to do it themselves.
    return question(
      "undo_last",
      "not-reversible",
      `The last change here was ${entry.label}, and I can't reverse it: ${entry.reverse.reason}. ` +
        `Nothing was changed.`,
    );
  }

  if (entry.reverse.kind === "delete-transaction") {
    const { transactionId, expect } = entry.reverse;
    const rows = await ctx.actions.getTransactions();
    const row = rows.find((candidate) => candidate.id === transactionId);

    if (!row) {
      // Already gone (deleted in the UI, or a restart lost nothing but the row).
      // Mark it undone so a second `undo` moves on rather than repeating this.
      ctx.journal.markUndone(entry.id, ctx.now());
      return {
        status: "ok",
        tool: "undo_last",
        reply: `${entry.label} was already gone, so there was nothing left to undo.`,
      };
    }

    // Identity check: never delete a row that no longer looks like what was
    // recorded. Ids are AUTOINCREMENT (never reused), but an edit in the UI can
    // still have changed the row's meaning since.
    const rowKey = toDateKey(row.date);
    if (row.amountCents !== expect.amountCents || rowKey !== expect.dateKey) {
      return failed(
        "undo_last",
        "refused",
        `That transaction has changed since I added it (now ` +
          `${formatMoney(row.amountCents, ctx.currency)} on ${rowKey}), so I did not delete it. ` +
          `Change it on the transactions page instead.`,
      );
    }

    const result = await ctx.actions.deleteTransaction(transactionId);
    const error = actionError(result);
    if (error) {
      return failed("undo_last", "action-failed", `Nothing was changed: ${error}.`);
    }
    ctx.journal.markUndone(entry.id, ctx.now());

    // Show the budget the removal restored, for the same reason the write shows
    // the budget it consumed.
    let impact = "";
    if (row.categoryId != null && !isTransfer(row)) {
      const categories = await ctx.actions.getCategories();
      const category = categories.find((candidate) => candidate.id === row.categoryId);
      if (category) impact = ` ${await budgetImpact(category, rowKey, ctx)}`;
    }
    return {
      status: "ok",
      tool: "undo_last",
      reply: `Undone: removed ${entry.label}.${impact}`,
    };
  }

  // restore-asset-value
  const { assetId, previousValueCents, snapshot } = entry.reverse;
  const result = await ctx.actions.updateAsset(assetId, assetFormData(snapshot, previousValueCents));
  const error = actionError(result);
  if (error) return failed("undo_last", "action-failed", `Nothing was changed: ${error}.`);
  ctx.journal.markUndone(entry.id, ctx.now());
  return {
    status: "ok",
    tool: "undo_last",
    reply: `Undone: put ${entry.label} back to ${formatMoney(previousValueCents, snapshot.currency)}.`,
  };
}

// ---------------------------------------------------------------------------
// get_balances
// ---------------------------------------------------------------------------

async function getBalances(ctx: Ctx): Promise<ExecuteOutcome> {
  const accounts = await ctx.actions.getAccountBalances({ includeArchived: false });
  const worth = await ctx.actions.getNetWorth();

  const lines = accounts.map((account) => {
    const currency = account.currency ?? ctx.currency;
    const owed =
      account.kind === "liability" && account.owedCents > 0
        ? ` (${formatMoney(account.owedCents, currency)} owed)`
        : "";
    return `${account.name}: ${formatMoney(account.balanceCents, currency)}${owed}`;
  });

  // A non-zero unassigned bucket is real money with no account. Never hide it.
  if (worth.unassignedCents !== 0) {
    lines.push(`Unassigned: ${formatMoney(worth.unassignedCents, ctx.currency)}`);
  }

  const summary =
    `Assets ${formatMoney(worth.totalAssetsCents, ctx.currency)} · ` +
    `Liabilities ${formatMoney(worth.totalLiabilitiesCents, ctx.currency)} · ` +
    `Net worth ${formatMoney(worth.netWorthCents, ctx.currency)}`;

  return {
    status: "ok",
    tool: "get_balances",
    reply: lines.length > 0 ? `${lines.join("\n")}\n${summary}` : `No accounts yet. ${summary}`,
  };
}

// ---------------------------------------------------------------------------
// spend_summary
// ---------------------------------------------------------------------------

type SpendSummaryArgs = { period?: string; category?: string };

/**
 * A period the user named, resolved DETERMINISTICALLY.
 *
 * The supported phrases are listed and nothing else is accepted: an unparseable
 * period is a question, not a silent fallback to the current month. Answering
 * "how much did I spend since the wedding" with this month's figure — labelled as
 * if it were the answer — is the kind of confidently-wrong reply that makes a
 * finance assistant untrustworthy.
 */
export type ResolvedPeriod = {
  label: string;
  period: BudgetPeriod;
  startKey: DateKey;
  endKey: DateKey;
};

export function resolvePeriodPhrase(raw: string | undefined, today: DateKey): ResolvedPeriod | null {
  const text = (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // Omitted means the current month — the tool description tells the model so.
  if (text === "") {
    const range = periodContaining("monthly", today);
    return { label: "this month", period: "monthly", ...range };
  }

  const current = (period: BudgetPeriod, label: string): ResolvedPeriod => ({
    label,
    period,
    ...periodContaining(period, today),
  });
  const previous = (period: BudgetPeriod, label: string): ResolvedPeriod => ({
    label,
    period,
    ...previousPeriodRange(period, periodContaining(period, today)),
  });

  switch (text) {
    case "today":
    case "so far today":
      return { label: "today", period: "monthly", startKey: today, endKey: today };
    case "yesterday": {
      const key = dayBefore(today);
      return { label: "yesterday", period: "monthly", startKey: key, endKey: key };
    }
    case "week":
    case "this week":
    case "current week":
    case "the week":
    case "this week so far":
    case "wtd":
    case "week to date":
      return current("weekly", "this week");
    case "last week":
    case "previous week":
    case "past week":
      return previous("weekly", "last week");
    case "month":
    case "this month":
    case "current month":
    case "the month":
    case "this month so far":
    case "mtd":
    case "month to date":
      return current("monthly", "this month");
    case "last month":
    case "previous month":
    case "prev month":
      return previous("monthly", "last month");
    case "year":
    case "this year":
    case "current year":
    case "the year":
    case "this year so far":
    case "ytd":
    case "year to date":
      return current("yearly", "this year");
    case "last year":
    case "previous year":
      return previous("yearly", "last year");
    default:
      return null;
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

async function spendSummary(args: SpendSummaryArgs, ctx: Ctx): Promise<ExecuteOutcome> {
  const range = resolvePeriodPhrase(args.period, ctx.today);
  if (!range) {
    return question(
      "spend_summary",
      "unknown-period",
      `I don't know the period "${(args.period ?? "").trim()}". Try "this week", "last week", ` +
        `"this month", "last month", "this year" or "last year".`,
    );
  }
  const window = `${range.startKey} to ${range.endKey}`;
  const transactions = toReportTransactions(await ctx.actions.getTransactions());
  const categories = await ctx.actions.getCategories();

  if (args.category !== undefined) {
    const resolved = resolveName(args.category, categories);
    if (resolved.status !== "resolved") {
      return nameQuestion("spend_summary", resolved, "category", categories);
    }
    const category = resolved.row;
    const total = spendInRange(transactions, category.id, range.startKey, range.endKey);
    const count = transactions.filter(
      (tx) =>
        tx.categoryId === category.id &&
        isSpendable(tx) &&
        tx.dateKey >= range.startKey &&
        tx.dateKey <= range.endKey,
    ).length;
    const verb = category.type === "Income" ? "in" : "out";
    return {
      status: "ok",
      tool: "spend_summary",
      reply:
        count === 0
          ? `${category.name}, ${range.label} (${window}): nothing recorded.`
          : `${category.name}, ${range.label} (${window}): ` +
            `${formatMoney(total, ctx.currency)} ${verb} across ${count} ` +
            `transaction${count === 1 ? "" : "s"}.`,
    };
  }

  const totals = flowInRange(transactions, categories, range.startKey, range.endKey);
  const excluded: string[] = [];
  if (totals.transferCount > 0) {
    excluded.push(
      `${totals.transferCount} transfer${totals.transferCount === 1 ? "" : "s"} excluded`,
    );
  }
  if (totals.pendingCount > 0) {
    excluded.push(`${totals.pendingCount} pending excluded`);
  }
  if (totals.uncategorizedCount > 0) {
    excluded.push(`${totals.uncategorizedCount} with no category`);
  }
  const note = excluded.length > 0 ? ` (${excluded.join(", ")})` : "";

  if (totals.countedCount === 0) {
    return {
      status: "ok",
      tool: "spend_summary",
      reply: `${capitalize(range.label)} (${window}): nothing recorded yet${note}.`,
    };
  }

  const top = categoryBreakdown({
    transactions,
    categories,
    startKey: range.startKey,
    endKey: range.endKey,
    direction: "expense",
  })
    .slice(0, 3)
    .map((row) => `${row.name} ${formatMoney(row.totalCents, ctx.currency)}`);

  const net = totals.netCents;
  return {
    status: "ok",
    tool: "spend_summary",
    reply:
      `${capitalize(range.label)} (${window}): ` +
      `${formatMoney(totals.expenseCents, ctx.currency)} out, ` +
      `${formatMoney(totals.incomeCents, ctx.currency)} in, ` +
      `net ${net > 0 ? "+" : ""}${formatMoney(net, ctx.currency)}${note}.` +
      (top.length > 0 ? ` Top: ${top.join(", ")}.` : ""),
  };
}

// ---------------------------------------------------------------------------
// budget_status
// ---------------------------------------------------------------------------

type BudgetStatusArgs = { category?: string };

async function budgetStatus(args: BudgetStatusArgs, ctx: Ctx): Promise<ExecuteOutcome> {
  let category: CategoryRow | undefined;
  if (args.category !== undefined) {
    const categories = await ctx.actions.getCategories();
    const resolved = resolveName(args.category, categories);
    if (resolved.status !== "resolved") {
      return nameQuestion("budget_status", resolved, "category", categories);
    }
    category = resolved.row;
  }

  const rows = await ctx.actions.getSpendVsBudget({
    dateKey: ctx.today,
    ...(category ? { categoryId: category.id } : {}),
  });

  if (rows.length === 0) {
    return {
      status: "ok",
      tool: "budget_status",
      reply: category
        ? `No budget set for ${category.name}, so there is nothing to be over.`
        : "No budgets are set yet, so there is nothing to be over.",
    };
  }

  // Worst first: over-budget lines are the answer to "am I over budget".
  const ordered = [...rows].sort(
    (a, b) => a.remainingCents - b.remainingCents || a.categoryName.localeCompare(b.categoryName),
  );
  const lines = ordered.map((row) => {
    const when = periodWord(row.period, row, ctx.today);
    const used = `${formatMoney(row.spentCents, ctx.currency)} of ${formatMoney(row.availableCents, ctx.currency)}`;
    if (row.remainingCents < 0) {
      return `${row.categoryName} (${when}): ${used}, ${formatMoney(absCents(row.remainingCents), ctx.currency)} OVER.`;
    }
    if (row.remainingCents === 0) {
      return `${row.categoryName} (${when}): ${used}; nothing left.`;
    }
    return `${row.categoryName} (${when}): ${used}, ${formatMoney(row.remainingCents, ctx.currency)} left.`;
  });

  const over = ordered.filter((row) => row.remainingCents < 0).length;
  const header = category
    ? null
    : over > 0
      ? `${over} of ${rows.length} budget${rows.length === 1 ? "" : "s"} over:`
      : `All ${rows.length} budget${rows.length === 1 ? "" : "s"} within limit:`;

  return {
    status: "ok",
    tool: "budget_status",
    reply: [header, ...lines].filter((line): line is string => line !== null).join("\n"),
  };
}

// ---------------------------------------------------------------------------
// list_recent
// ---------------------------------------------------------------------------

type ListRecentArgs = { limit?: number };

async function listRecent(args: ListRecentArgs, ctx: Ctx): Promise<ExecuteOutcome> {
  const limit = args.limit ?? 5;
  // Sequential, not Promise.all: lib/db/client.ts serializes access anyway, and a
  // fan-out only adds contention for no wall-clock gain.
  const transactions = await ctx.actions.getTransactions();
  const categories = await ctx.actions.getCategories();
  const accounts = await ctx.actions.getAccounts({ includeArchived: true });

  if (transactions.length === 0) {
    return { status: "ok", tool: "list_recent", reply: "No transactions yet." };
  }

  const nameOfCategory = new Map(categories.map((row) => [row.id, row.name]));
  const nameOfAccount = new Map(accounts.map((row) => [row.id, row.name]));

  const recent = [...transactions]
    .sort((a, b) => b.date.getTime() - a.date.getTime() || b.id - a.id)
    .slice(0, limit);

  const lines = recent.map((tx) => {
    const what = isTransfer(tx)
      ? `${nameOfAccount.get(tx.accountId ?? -1) ?? "?"} → ` +
        `${nameOfAccount.get(tx.transferAccountId ?? -1) ?? "?"} (transfer)`
      : tx.categoryId == null
        ? "no category"
        : (nameOfCategory.get(tx.categoryId) ?? `deleted category #${tx.categoryId}`);
    const flags = tx.pending ? " (pending)" : "";
    const comment =
      typeof tx.comment === "string" && tx.comment.trim() !== ""
        ? `: ${tx.comment.trim().slice(0, 40)}`
        : "";
    return `${toDateKey(tx.date)}  ${formatMoney(tx.amountCents, ctx.currency)}  ${what}${flags}${comment}`;
  });

  return { status: "ok", tool: "list_recent", reply: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// set_asset_value
// ---------------------------------------------------------------------------

type SetAssetValueArgs = { asset: string; value: Cents };

/** A holding as the resolver sees it: several names, one row. */
type AssetCandidate = Resolvable & { asset: AssetRow };

/** "Commodities (Gold bars)" — category first, since that is what the UI shows. */
function assetLabel(asset: AssetRow): string {
  const note = (asset.notes ?? "").trim();
  const detail = note !== "" ? note : (asset.commodityType ?? "");
  return detail !== "" && detail !== asset.category
    ? `${asset.category} (${detail})`
    : asset.category;
}

function assetCandidates(assets: readonly AssetRow[]): AssetCandidate[] {
  return assets.map((asset) => ({
    id: asset.id,
    name: assetLabel(asset),
    // A holding has no single name, so every way the user might refer to it is an
    // alias: the note, the metal, the category and the price symbol.
    aliases: [asset.notes, asset.commodityType, asset.category, asset.priceSymbol],
    asset,
  }));
}

/** The form `updateAsset` expects: every field it rewrites, plus the new value. */
function assetFormData(snapshot: AssetValueSnapshot, valueCents: Cents): FormData {
  const formData = new FormData();
  formData.set("category", snapshot.category);
  formData.set("currency", snapshot.currency);
  if (snapshot.notes !== null) formData.set("notes", snapshot.notes);
  if (snapshot.commodityType !== null) formData.set("commodityType", snapshot.commodityType);
  // A quantity of 0 is a real quantity; only `null` means absent.
  if (snapshot.quantity !== null) formData.set("quantity", String(snapshot.quantity));
  if (snapshot.unit !== null) formData.set("unit", snapshot.unit);
  if (snapshot.linkedTransactionIds !== null) {
    formData.set("linkedTransactionIds", snapshot.linkedTransactionIds);
  }
  formData.set("useLivePrice", snapshot.useLivePrice ? "true" : "false");
  formData.set("currentValue", centsToDecimalString(valueCents));
  return formData;
}

function snapshotOf(asset: AssetRow): AssetValueSnapshot {
  return {
    category: asset.category,
    currency: asset.currency ?? "USD",
    notes: asset.notes ?? null,
    commodityType: asset.commodityType ?? null,
    quantity: asset.quantity ?? null,
    unit: asset.unit ?? null,
    linkedTransactionIds: null,
    useLivePrice: asset.useLivePrice === true,
  };
}

async function setAssetValue(
  tool: AgentTool,
  args: SetAssetValueArgs,
  call: ToolCall,
  ctx: Ctx,
  options: RunOptions,
): Promise<ExecuteOutcome> {
  const assets = await ctx.actions.getAssets();
  const candidates = assetCandidates(assets);
  const resolved = resolveName(args.asset, candidates);
  if (resolved.status !== "resolved") {
    return nameQuestion(tool.name, resolved, "holding", candidates);
  }
  const asset = resolved.row.asset;
  const label = assetLabel(asset);

  // The derived Cash row is computed from the ledger; hand-setting it would be
  // overwritten on the next sync. `updateAsset` refuses too — this refuses first,
  // so the reply explains WHY instead of quoting a generic failure.
  if (asset.category === "Cash") {
    return failed(
      tool.name,
      "refused",
      "Cash is calculated from your transactions, so I can't set it by hand. " +
        "Add or correct a transaction instead. Nothing was saved.",
    );
  }
  // A live-priced holding would be overwritten by the next refresh, and setting
  // it by hand also strips the reason its value is trustworthy.
  if (asset.useLivePrice === true || (asset.priceSymbol ?? "") !== "") {
    return failed(
      tool.name,
      "refused",
      `${label} is priced live${asset.priceSymbol ? ` from ${asset.priceSymbol}` : ""}, so a ` +
        `hand-set value would be overwritten at the next refresh. Ask me to refresh prices ` +
        `instead. Nothing was saved.`,
    );
  }

  const currency = asset.currency ?? ctx.currency;
  const summary =
    `set ${label} to ${formatMoney(args.value, currency)} ` +
    `(was ${formatMoney(asset.currentValueCents, currency)})`;

  // set_asset_value is `confirm: "always"` — a holding's value moves net worth
  // directly, with no transaction to inspect afterwards.
  if (!options.skipConfirm && requiresConfirmation(tool, args.value)) {
    return askToConfirm(tool, summary, call, ctx);
  }

  const snapshot = snapshotOf(asset);
  const result = await ctx.actions.updateAsset(asset.id, assetFormData(snapshot, args.value));
  const error = actionError(result);
  if (error) return failed(tool.name, "action-failed", `Nothing was saved: ${error}.`);

  const undoId = ctx.journal.record({
    tool: tool.name,
    at: ctx.now(),
    label: `${label}`,
    reverse: {
      kind: "restore-asset-value",
      assetId: asset.id,
      previousValueCents: asset.currentValueCents,
      snapshot,
    },
  }).id;

  const worth = await ctx.actions.getNetWorth();
  return {
    status: "ok",
    tool: tool.name,
    undoId,
    reply:
      `Set ${label} to ${formatMoney(args.value, currency)} ` +
      `(was ${formatMoney(asset.currentValueCents, currency)}). ` +
      `Net worth is now ${formatMoney(worth.netWorthCents, ctx.currency)}.`,
  };
}

// ---------------------------------------------------------------------------
// refresh_prices
// ---------------------------------------------------------------------------

/**
 * Re-price every live-priced holding.
 *
 * WHICH ACTION AND WHY: `app/actions/crypto.ts:updateLivePricedAsset` is the only
 * write path that persists `price_symbol` and `priced_at`;
 * `app/actions/assets.ts:updateAsset` never touches either and gates live pricing
 * on `category === "Commodities"`, so it cannot re-price BTC at all. See the
 * header of crypto.ts.
 *
 * A failed fetch writes NOTHING for that holding and the previous value survives —
 * a live-priced asset persisted at $0 because the network was down is a bug that
 * really did make a holding vanish from this owner's net worth. Each per-holding
 * failure is reported in the reply rather than collapsed into one "some failed".
 *
 * NOT REVERSIBLE, and journalled as such: putting an old price back would need
 * `updateAsset`, which would drop `price_symbol` and leave the holding unable to
 * refresh again. Re-running this tool is the honest way back to a current price.
 */
async function refreshPrices(ctx: Ctx): Promise<ExecuteOutcome> {
  const assets = await ctx.actions.getAssets();
  const live = assets.filter(
    (asset) => asset.useLivePrice === true || (asset.priceSymbol ?? "") !== "",
  );

  if (live.length === 0) {
    return {
      status: "ok",
      tool: "refresh_prices",
      reply:
        "No live-priced holdings to refresh. Gold, silver, platinum, palladium, Bitcoin and " +
        "Ethereum can be priced live once a holding records its quantity and symbol.",
    };
  }

  const lines: string[] = [];
  let refreshed = 0;

  // Sequentially, never Promise.all: each write takes the single database lock in
  // lib/db/client.ts, and a fan-out would just queue while holding network waits.
  for (const asset of live) {
    const label = assetLabel(asset);
    const currency = asset.currency ?? ctx.currency;
    const symbol = (asset.priceSymbol ?? "").trim();

    if (symbol === "") {
      lines.push(`${label}: no price symbol recorded, so I can't price it. Value unchanged.`);
      continue;
    }
    if (asset.quantity === null || asset.quantity === undefined) {
      lines.push(`${label}: no quantity recorded, so I can't price it. Value unchanged.`);
      continue;
    }

    const formData = new FormData();
    formData.set("priceSymbol", symbol);
    // 0 is a real quantity — `readQuantityField` in lib/prices.ts distinguishes it
    // from an empty field, and this must not undo that.
    formData.set("quantity", String(asset.quantity));
    if (asset.unit) formData.set("unit", asset.unit);
    formData.set("currency", currency);
    if (asset.notes !== null && asset.notes !== undefined) formData.set("notes", asset.notes);

    const result = await ctx.actions.updateLivePricedAsset(asset.id, formData);
    const error = actionError(result);
    if (error) {
      lines.push(`${label}: ${error} Value unchanged at ${formatMoney(asset.currentValueCents, currency)}.`);
      continue;
    }
    refreshed += 1;
    const now = result.data?.currentValueCents;
    const value = typeof now === "number" ? now : asset.currentValueCents;
    const delta = sumCents([value, negateCents(asset.currentValueCents)]);
    const change =
      delta === 0
        ? "unchanged"
        : `${delta > 0 ? "up" : "down"} ${formatMoney(absCents(delta), currency)}`;
    lines.push(`${label}: ${formatMoney(value, currency)} (${change}).`);
  }

  if (refreshed > 0) {
    ctx.journal.record({
      tool: "refresh_prices",
      at: ctx.now(),
      label: `a price refresh of ${refreshed} holding${refreshed === 1 ? "" : "s"}`,
      reverse: {
        kind: "none",
        reason:
          "putting an old market price back would drop the holding's price symbol and stop it " +
          "refreshing again: ask me to refresh prices instead",
      },
    });
    const worth = await ctx.actions.getNetWorth();
    lines.push(`Net worth is now ${formatMoney(worth.netWorthCents, ctx.currency)}.`);
  }

  return { status: "ok", tool: "refresh_prices", reply: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Re-exports, so a caller needs one import
// ---------------------------------------------------------------------------

export { listNames, resolveName } from "./resolve";
export { agentUndoJournal, UndoJournal } from "./undo";
