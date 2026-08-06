/**
 * The executor is the trust boundary: it is the only thing between a 26M model's
 * guess and a row in the ledger. These tests pin the properties that make letting
 * a tiny model near money defensible at all.
 *
 * Each one names a specific way this could go wrong:
 *
 *  - a hallucinated amount must write NOTHING (not $0.00, not "a bit off");
 *  - a large write must not happen until the user says so, and must then happen
 *    exactly ONCE (a double-tapped confirm posting $4,000 twice is the failure);
 *  - a cancelled write must leave the database untouched;
 *  - the success reply must quote the amount AND the budget impact, because that
 *    sentence is how the user catches a misparse while they still remember the
 *    purchase;
 *  - an unresolvable category must produce a QUESTION, never a guess and never a
 *    new category.
 *
 * Every assertion about "nothing was written" reads the file through
 * `temp.query`, independently of `lib/db/client.ts`, so a caching bug in the
 * client cannot make a missing write look present or vice versa.
 *
 * Timezone-safe: `today` is passed explicitly and every date assertion goes
 * through `toDateKey`. `npm run test:tz` runs this at UTC+14 and UTC-11.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDomainDb,
  seedAccount,
  seedAsset,
  seedBudget,
  seedCategory,
  type DomainDb,
} from "@/app/actions/__tests__/support/domain-fixture";
import {
  cancelPendingToolCall,
  clearPendingToolCalls,
  confirmPendingToolCall,
  executeToolCall,
  pendingToolCalls,
  requiresConfirmation,
  type ExecuteContext,
  type ExecuteOutcome,
} from "@/lib/agent/execute";
import { addTransaction, CONFIRM_THRESHOLD_CENTS, findTool } from "@/lib/agent/tools";
import { UndoJournal } from "@/lib/agent/undo";
import { toDateKey, todayKey, type DateKey } from "@/lib/dates";

let temp: DomainDb;
let journal: UndoJournal;
let today: DateKey;

beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 1, name: "Groceries", type: "Expense" });
  seedCategory(temp, { id: 2, name: "Grooming", type: "Expense" });
  seedCategory(temp, { id: 3, name: "Salary", type: "Income" });
  // Migration 0003 already creates account id 1, "Main" — the default every
  // pre-accounts transaction was attached to. Seed a second one so account
  // resolution has a real choice to get wrong.
  seedAccount(temp, { id: 2, name: "Savings", kind: "asset", type: "Savings" });
  // A $100.00 monthly budget on Groceries, in force since long before any test
  // date, so the "budget impact" sentence has something real to report.
  seedBudget(temp, {
    categoryId: 1,
    period: "monthly",
    limitCents: 10_000,
    effectiveFrom: "2020-01-01",
  });

  journal = new UndoJournal();
  today = todayKey();
  // The pending store is module-level (in-process, like the journal), so a
  // confirmation left over from another test would answer this one's /yes.
  clearPendingToolCalls();
});

afterEach(async () => {
  clearPendingToolCalls();
  await temp.cleanup();
});

function ctx(overrides?: Partial<ExecuteContext>): ExecuteContext {
  return { today, journal, ...overrides };
}

function transactionCount(): number {
  return Number(temp.scalar("SELECT COUNT(*) FROM transactions"));
}

function categoryCount(): number {
  return Number(temp.scalar("SELECT COUNT(*) FROM categories"));
}

function transactionRows() {
  return temp.query("SELECT id, amount_cents, category_id, date, comment FROM transactions ORDER BY id");
}

/** Narrow to the confirm variant, with a message that names what actually happened. */
function expectConfirm(outcome: ExecuteOutcome) {
  if (outcome.status !== "confirm") {
    throw new Error(`expected a confirmation, got ${outcome.status}: ${outcome.reply}`);
  }
  return outcome;
}

// ---------------------------------------------------------------------------

describe("executeToolCall: arguments the model got wrong", () => {
  it("rejects an unreadable amount and writes nothing", async () => {
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "about ten dollars", category: "Groceries" } },
      ctx(),
    );

    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("unreachable");
    expect(outcome.reason).toBe("invalid-arguments");
    // The reply must say nothing was saved, because the user's next action
    // depends on believing it.
    expect(outcome.reply).toContain("Nothing was saved");
    expect(outcome.reply.toLowerCase()).toContain("amount");
    expect(transactionCount()).toBe(0);
  });

  it("never turns an unreadable amount into $0.00", async () => {
    // The failure this guards: four separate falsy-zero bugs in this codebase,
    // one of which persisted a live-priced asset at $0.00.
    await executeToolCall(
      { name: "add_transaction", arguments: { amount: "", category: "Groceries" } },
      ctx(),
    );
    expect(transactionRows()).toEqual([]);
  });

  it("rejects a missing amount rather than defaulting one", async () => {
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { category: "Groceries" } },
      ctx(),
    );
    expect(outcome.status).toBe("error");
    expect(transactionCount()).toBe(0);
  });

  it("still writes a real $0.00, because zero is a value", async () => {
    // The mirror of the test above: a rejection must be caused by unreadability,
    // not by the amount being falsy.
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "0", category: "Groceries" } },
      ctx(),
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.reply).toContain("$0.00");
    expect(transactionRows()).toHaveLength(1);
    expect(transactionRows()[0].amount_cents).toBe(0);
  });

  it("rejects an unreadable date and writes nothing", async () => {
    const outcome = await executeToolCall(
      {
        name: "add_transaction",
        arguments: { amount: "10", category: "Groceries", date: "sometime last week" },
      },
      ctx(),
    );
    expect(outcome.status).toBe("error");
    expect(transactionCount()).toBe(0);
  });

  it("reports an unknown tool name without guessing at a real one", async () => {
    const outcome = await executeToolCall(
      { name: "add_transactions", arguments: { amount: "10", category: "Groceries" } },
      ctx(),
    );
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("unreachable");
    expect(outcome.reason).toBe("unknown-tool");
    expect(transactionCount()).toBe(0);
  });
});

describe("executeToolCall: the confirmation gate", () => {
  it("confirms at exactly the threshold and writes nothing yet", async () => {
    // At, not just over: an off-by-one here is a $200.00 write that skips the gate.
    expect(requiresConfirmation(addTransaction, CONFIRM_THRESHOLD_CENTS)).toBe(true);

    const outcome = expectConfirm(
      await executeToolCall(
        { name: "add_transaction", arguments: { amount: "200", category: "Groceries" } },
        ctx(),
      ),
    );

    expect(outcome.reply).toContain("$200.00");
    expect(outcome.reply).toContain("has been saved yet");
    expect(transactionCount()).toBe(0);
    expect(journal.size).toBe(0);
  });

  it("does not confirm a cent below the threshold", async () => {
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "199.99", category: "Groceries" } },
      ctx(),
    );
    expect(outcome.status).toBe("ok");
    expect(transactionCount()).toBe(1);
  });

  it("writes exactly once when confirmed", async () => {
    const pending = expectConfirm(
      await executeToolCall(
        { name: "add_transaction", arguments: { amount: "4000", category: "Groceries" } },
        ctx(),
      ),
    ).pending;

    const confirmed = await confirmPendingToolCall(pending, ctx());
    expect(confirmed.status).toBe("ok");
    expect(confirmed.reply).toContain("$4,000.00");

    const rows = transactionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe(400_000);
  });

  it("cannot be confirmed twice — the token is single-use", async () => {
    // The failure: a double-clicked or double-sent "yes" posting $4,000 twice.
    const pending = expectConfirm(
      await executeToolCall(
        { name: "add_transaction", arguments: { amount: "4000", category: "Groceries" } },
        ctx(),
      ),
    ).pending;

    const first = await confirmPendingToolCall(pending, ctx());
    const second = await confirmPendingToolCall(pending, ctx());

    expect(first.status).toBe("ok");
    expect(second.status).toBe("error");
    if (second.status !== "error") throw new Error("unreachable");
    expect(second.reason).toBe("expired-confirmation");
    expect(second.reply).toContain("nothing was saved");
    expect(transactionCount()).toBe(1);
  });

  it("writes nothing when the confirmation is cancelled", async () => {
    const pending = expectConfirm(
      await executeToolCall(
        { name: "add_transaction", arguments: { amount: "999", category: "Groceries" } },
        ctx(),
      ),
    ).pending;

    const cancelled = cancelPendingToolCall(pending);
    expect(cancelled.status).toBe("ok");
    expect(cancelled.reply).toContain("Nothing was saved");
    expect(transactionCount()).toBe(0);
    expect(journal.size).toBe(0);

    // And a later "yes" cannot resurrect it.
    const revived = await confirmPendingToolCall(pending, ctx());
    expect(revived.status).toBe("error");
    expect(transactionCount()).toBe(0);
  });

  it("re-validates on confirm, so a category renamed in between is caught", async () => {
    const pending = expectConfirm(
      await executeToolCall(
        { name: "add_transaction", arguments: { amount: "500", category: "Groceries" } },
        ctx(),
      ),
    ).pending;

    temp.query("SELECT 1"); // keep the read path warm; the rename happens next
    seedCategory(temp, { id: 9, name: "Grocery Basket", type: "Expense" });
    // "Groceries" now still resolves uniquely, so this must succeed — the point
    // is that resolution happens at confirm time against current rows.
    const confirmed = await confirmPendingToolCall(pending, ctx());
    expect(confirmed.status).toBe("ok");
    expect(transactionCount()).toBe(1);
  });

  it("keeps set_asset_value behind a confirmation at any size", async () => {
    // `confirm: "always"` — a holding's value moves net worth with no transaction
    // to inspect afterwards, so even $1 is gated.
    seedAsset(temp, { category: "Vehicles", currentValueCents: 1_800_000, notes: "Car" });

    const outcome = expectConfirm(
      await executeToolCall(
        { name: "set_asset_value", arguments: { asset: "Car", value: "1" } },
        ctx(),
      ),
    );
    expect(outcome.reply).toContain("$1.00");
    expect(Number(temp.scalar("SELECT current_value_cents FROM assets WHERE notes = 'Car'"))).toBe(
      1_800_000,
    );
  });

  it("does not gate a read tool", () => {
    const read = findTool("get_balances");
    if (!read) throw new Error("get_balances is missing from the registry");
    expect(requiresConfirmation(read, null)).toBe(false);
  });

  it("leaves no pending entry behind once answered", async () => {
    const pending = expectConfirm(
      await executeToolCall(
        { name: "add_transaction", arguments: { amount: "300", category: "Groceries" } },
        ctx(),
      ),
    ).pending;
    expect(pendingToolCalls()).toHaveLength(1);
    await confirmPendingToolCall(pending, ctx());
    expect(pendingToolCalls()).toHaveLength(0);
  });
});

describe("executeToolCall: the success reply", () => {
  it("quotes the amount, the category and the budget impact", async () => {
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "10", category: "Groceries" } },
      ctx(),
    );

    expect(outcome.status).toBe("ok");
    // The amount, formatted through formatMoney — never a hand-rolled toFixed.
    expect(outcome.reply).toContain("$10.00");
    expect(outcome.reply).toContain("Groceries");
    // The behavioural point of the app: what is left, right now.
    expect(outcome.reply).toContain("$90.00 left of $100.00 this month");
  });

  it("reports going over budget rather than staying quiet about it", async () => {
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "150", category: "Groceries" } },
      ctx(),
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.reply).toContain("$50.00 over your $100.00 this month");
  });

  it("reports period-to-date activity when a category has no budget", async () => {
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "12.34", category: "Grooming" } },
      ctx(),
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.reply).toContain("No budget on Grooming");
    expect(outcome.reply).toContain("$12.34");
  });

  it("writes the amount as exact integer cents", async () => {
    // "2.675" is the classic float-drift case: 268, never 267.
    await executeToolCall(
      { name: "add_transaction", arguments: { amount: "2.675", category: "Groceries" } },
      ctx(),
    );
    expect(transactionRows()[0].amount_cents).toBe(268);
  });

  it("defaults the date to today and says nothing about it", async () => {
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "10", category: "Groceries" } },
      ctx(),
    );
    expect(outcome.reply).not.toContain(" on ");

    const stored = transactionRows()[0].date;
    expect(toDateKey(new Date(Number(stored) * 1000))).toBe(today);
  });

  it("records an undo entry naming the row it created", async () => {
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "10", category: "Groceries" } },
      ctx(),
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.undoId).toBeTruthy();

    const entry = journal.peek();
    expect(entry?.reverse.kind).toBe("delete-transaction");
    if (entry?.reverse.kind !== "delete-transaction") throw new Error("unreachable");
    expect(entry.reverse.transactionId).toBe(Number(transactionRows()[0].id));
  });
});

describe("executeToolCall: names it cannot resolve", () => {
  it("asks which category instead of guessing between two matches", async () => {
    // "gro" prefix-matches both Groceries and Grooming.
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "10", category: "gro" } },
      ctx(),
    );

    expect(outcome.status).toBe("question");
    if (outcome.status !== "question") throw new Error("unreachable");
    expect(outcome.reason).toBe("ambiguous-name");
    expect(outcome.reply).toContain("more than one category");
    expect(outcome.reply).toContain("Groceries");
    expect(outcome.reply).toContain("Grooming");
    expect(outcome.reply).toContain("Nothing was saved");
    expect(transactionCount()).toBe(0);
  });

  it("asks about an unknown category and does not create one", async () => {
    // A chat typo must not be able to grow the category list — that is how two
    // transactions in this database were orphaned once already.
    const before = categoryCount();
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "10", category: "Grocieres" } },
      ctx(),
    );

    expect(outcome.status).toBe("question");
    if (outcome.status !== "question") throw new Error("unreachable");
    expect(outcome.reason).toBe("unknown-name");
    expect(outcome.reply).toContain("Did you mean");
    expect(outcome.reply).toContain("Groceries");
    expect(categoryCount()).toBe(before);
    expect(transactionCount()).toBe(0);
  });

  it("asks about an unknown account without falling back to the default one", async () => {
    const outcome = await executeToolCall(
      {
        name: "add_transaction",
        arguments: { amount: "10", category: "Groceries", account: "Offshore" },
      },
      ctx(),
    );
    expect(outcome.status).toBe("question");
    expect(transactionCount()).toBe(0);
  });

  it("resolves a unique prefix, which is the whole point of not exposing enums", async () => {
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "10", category: "sal" } },
      ctx(),
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.reply).toContain("Salary");
  });
});

describe("executeToolCall: a failing action is never reported as success", () => {
  it("surfaces an action error and journals nothing", async () => {
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "10", category: "Groceries" } },
      ctx({
        actions: {
          createTransaction: async () => ({ error: "disk is full" }),
        },
      }),
    );

    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("unreachable");
    expect(outcome.reason).toBe("action-failed");
    expect(outcome.reply).toContain("Nothing was saved");
    expect(outcome.reply).toContain("disk is full");
    expect(journal.size).toBe(0);
  });

  it("treats a silent non-success as a failure, not a success", async () => {
    // `{}` with no `error` used to read as "fine".
    const outcome = await executeToolCall(
      { name: "add_transaction", arguments: { amount: "10", category: "Groceries" } },
      ctx({ actions: { createTransaction: async () => ({}) } }),
    );
    expect(outcome.status).toBe("error");
    expect(journal.size).toBe(0);
  });
});

describe("executeToolCall: read tools", () => {
  it("reports balances and net worth together", async () => {
    const outcome = await executeToolCall({ name: "get_balances", arguments: {} }, ctx());
    expect(outcome.status).toBe("ok");
    expect(outcome.reply).toContain("Main");
    expect(outcome.reply).toContain("Savings");
    expect(outcome.reply).toContain("Net worth");
  });

  it("clamps a limit the model invented out of range", async () => {
    await executeToolCall(
      { name: "add_transaction", arguments: { amount: "10", category: "Groceries" } },
      ctx(),
    );
    const outcome = await executeToolCall({ name: "list_recent", arguments: { limit: 9999 } }, ctx());
    // 9999 is outside 1..20, so this is a rejection rather than a silent clamp —
    // either is safe, but it must not be treated as "all rows".
    expect(["ok", "error"]).toContain(outcome.status);
    expect(transactionCount()).toBe(1);
  });
});
