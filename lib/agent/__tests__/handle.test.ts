/**
 * The orchestrator's routing rules.
 *
 * These are the properties that stop being true the moment someone "simplifies"
 * `handle.ts`, and each one is a real way money gets mis-filed:
 *
 *  1. **An unknown slash command never reaches the model.** `/recnt` must come
 *     back as a typo with a suggestion. Falling through would let a 26M model
 *     guess what the user wanted to do with their money. Asserted by counting
 *     calls to a stub model that MUST stay at zero.
 *
 *  2. **Every model call is normalized first.** Measured: `10 groceries`
 *     produced `{"date":"2023-10-27"}`. zod accepts it, so only
 *     `normalizeModelCall` can catch it — and the user has to be TOLD, or a
 *     silently corrected date is indistinguishable from a silently wrong one.
 *
 *  3. **A single-shot model returning two calls loses one, out loud.** Silence
 *     there makes a half-executed message look complete.
 *
 *  4. **The model being down leaves the product usable.** Slash and quick
 *     commands are the ~90% path.
 *
 *  5. **`/yes` answers the newest pending write and retires the older ones**, so
 *     a forgotten confirmation cannot post money later.
 *
 * The model is always a stub here: no Python, no checkpoint, no sockets, no
 * 12-second JIT warmup. Everything below the model is real — real executor, real
 * server actions, real database file.
 *
 * Timezone-safe: `today` is always passed explicitly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDomainDb,
  seedBudget,
  seedCategory,
  type DomainDb,
} from "@/app/actions/__tests__/support/domain-fixture";
import { clearPendingToolCalls, pendingToolCalls } from "@/lib/agent/execute";
import {
  handleMessage,
  NEEDLE_START_HINT,
  type NeedleClient,
  type NeedleResult,
} from "@/lib/agent/handle";
import type { QuickCommandLike } from "@/lib/agent/slash";
import { UndoJournal } from "@/lib/agent/undo";
import { toDateKey, todayKey as realTodayKey, type DateKey } from "@/lib/dates";

let temp: DomainDb;
let journal: UndoJournal;

/** A fixed day, so relative-date resolution is assertable. 2026-07-15 is a Wednesday. */
const TODAY: DateKey = "2026-07-15";

const QUICK: QuickCommandLike[] = [
  { command: "coffee", categoryName: "Groceries", amountCents: 450, comment: "flat white" },
  { command: "rent", categoryName: "Rent", amountCents: 120_000, comment: null },
];

beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 1, name: "Groceries", type: "Expense" });
  seedCategory(temp, { id: 2, name: "Rent", type: "Expense" });
  seedCategory(temp, { id: 3, name: "Grooming", type: "Expense" });
  seedBudget(temp, {
    categoryId: 1,
    period: "monthly",
    limitCents: 10_000,
    effectiveFrom: "2020-01-01",
  });
  journal = new UndoJournal();
  clearPendingToolCalls();
});

afterEach(async () => {
  clearPendingToolCalls();
  await temp.cleanup();
});

// ---------------------------------------------------------------------------
// Stub model
// ---------------------------------------------------------------------------

type Stub = NeedleClient & { calls: Array<{ query: string; toolsJson: string }> };

/** A model that always answers with `result`, and records that it was consulted. */
function stubModel(result: NeedleResult): Stub {
  const calls: Array<{ query: string; toolsJson: string }> = [];
  const client = (async (query: string, toolsJson: string) => {
    calls.push({ query, toolsJson });
    return result;
  }) as Stub;
  client.calls = calls;
  return client;
}

function okResult(calls: Array<{ name: string; arguments: Record<string, unknown> }>): NeedleResult {
  return { status: "ok", calls, raw: JSON.stringify(calls), ms: 42 };
}

function send(message: string, needle: NeedleClient | null, debug = false) {
  return handleMessage(message, {
    today: TODAY,
    debug,
    quickCommands: QUICK,
    needle,
    context: { journal },
  });
}

function rows() {
  return temp.query("SELECT id, amount_cents, category_id, date, comment FROM transactions ORDER BY id");
}

function dateKeyOf(row: Record<string, unknown>): DateKey {
  return toDateKey(new Date(Number(row.date) * 1000));
}

/**
 * The day a call with NO `date` argument lands on.
 *
 * `dateArg` in tools.ts defaults an absent date with its own `todayKey()` call,
 * inside the zod schema — so the routed `today` does not reach it. Read from the
 * clock here rather than hard-coded, so this stays correct at any timezone.
 */
function schemaToday(): DateKey {
  return realTodayKey();
}

// ---------------------------------------------------------------------------

describe("handleMessage: nothing to route", () => {
  it("hints instead of calling the model on an empty message", async () => {
    const model = stubModel(okResult([{ name: "get_balances", arguments: {} }]));
    const reply = await send("   ", model);

    expect(reply.source).toBe("help");
    expect(reply.status).toBe("question");
    expect(reply.text).toContain("/help");
    expect(model.calls).toHaveLength(0);
  });

  it("survives a non-string message without throwing", async () => {
    // A JSON body from a webhook is not a type-checked call site.
    const reply = await handleMessage(undefined as unknown as string, { today: TODAY, needle: null });
    expect(reply.status).toBe("question");
  });
});

describe("handleMessage: slash is deterministic", () => {
  it("routes /help to text, with no tool and no model", async () => {
    const model = stubModel(okResult([{ name: "get_balances", arguments: {} }]));
    const reply = await send("/help", model);

    expect(reply.source).toBe("help");
    expect(reply.status).toBe("ok");
    expect(reply.text).toContain("/balance");
    expect(reply.text).toContain("/coffee");
    expect(model.calls).toHaveLength(0);
    expect(rows()).toEqual([]);
  });

  it("NEVER falls through to the model on an unknown command", async () => {
    // Rule 1. A leading "/" is a promise of determinism.
    const model = stubModel(okResult([{ name: "add_transaction", arguments: { amount: "9999", category: "Rent" } }]));
    const reply = await send("/recnt", model);

    expect(reply.status).toBe("unknown");
    expect(reply.source).toBe("slash");
    expect(reply.text).toContain("/recnt");
    // It suggests the nearest command it has — here the user's own /rent, which
    // is one edit away. The point is that it suggests rather than guessing.
    expect(reply.text).toContain("Did you mean /");
    expect(model.calls).toHaveLength(0);
    expect(rows()).toEqual([]);
  });

  it("points at /help when there is no near miss to suggest", async () => {
    const model = stubModel(okResult([]));
    const reply = await send("/zzzzzzz", model);
    expect(reply.status).toBe("unknown");
    expect(reply.text).toContain("/help");
    expect(model.calls).toHaveLength(0);
  });

  it("surfaces a slash argument error rather than guessing", async () => {
    const reply = await send("/recent abc", null);
    expect(reply.status).toBe("error");
    expect(reply.source).toBe("slash");
    expect(rows()).toEqual([]);
  });

  it("executes a built-in read command", async () => {
    const reply = await send("/balance", null);
    expect(reply.status).toBe("ok");
    expect(reply.source).toBe("slash");
    expect(reply.toolName).toBe("get_balances");
    expect(reply.text).toContain("Net worth");
  });

  it("executes a quick command and reports the budget impact", async () => {
    const reply = await send("/coffee", null);

    expect(reply.status).toBe("ok");
    expect(reply.source).toBe("slash");
    expect(reply.toolName).toBe("add_transaction");
    expect(reply.text).toContain("$4.50");
    // Assert the FIGURES, not the period wording. The reply says "this month"
    // only when the budget period is the real current month; with an injected
    // `today` that has drifted from the wall clock it prints the explicit range
    // instead. Both are correct, so pinning the phrase made this test fail on a
    // month rollover rather than on a regression.
    expect(reply.text).toContain("$95.50 left of $100.00");

    const written = rows();
    expect(written).toHaveLength(1);
    expect(written[0].amount_cents).toBe(450);
    expect(written[0].comment).toBe("flat white");
    // Slash never emits a date, so the schema's own default applies — see
    // "the `today` seam" below for why that is the clock and not TODAY.
    expect(dateKeyOf(written[0])).toBe(schemaToday());
  });

  it("accepts an amount override on a quick command", async () => {
    const reply = await send("/coffee 7.25", null);
    expect(reply.status).toBe("ok");
    expect(rows()[0].amount_cents).toBe(725);
  });

  it("works with no quick commands configured at all", async () => {
    const reply = await handleMessage("/balance", {
      today: TODAY,
      quickCommands: [],
      needle: null,
      context: { journal },
    });
    expect(reply.status).toBe("ok");
  });
});

describe("handleMessage: the model path", () => {
  it("drops a date the model invented and says so", async () => {
    // Rule 2, and the exact measured failure: "10 groceries" -> 2023-10-27.
    const model = stubModel(
      okResult([{ name: "add_transaction", arguments: { amount: "10", category: "Groceries", date: "2023-10-27" } }]),
    );
    const reply = await send("10 groceries", model);

    expect(reply.source).toBe("model");
    expect(reply.status).toBe("ok");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].query).toBe("10 groceries");

    // The note must reach the USER, not just the log.
    expect(reply.notes?.join(" ")).toContain("invented");
    expect(reply.text).toContain("invented");

    // And the row is filed today, not in 2023 — which is the whole point.
    expect(dateKeyOf(rows()[0])).not.toBe("2023-10-27");
    expect(dateKeyOf(rows()[0])).toBe(schemaToday());
  });

  it("resolves a relative date from the message, not from the model", async () => {
    const model = stubModel(
      okResult([
        { name: "add_transaction", arguments: { amount: "43.50", category: "Groceries", date: "yesterday" } },
      ]),
    );
    const reply = await send("spent 43.50 at groceries yesterday", model);

    expect(reply.status).toBe("ok");
    expect(dateKeyOf(rows()[0])).toBe("2026-07-14");
  });

  it("executes only the first of several calls and names what it dropped", async () => {
    // Rule 3. Needle is single-shot; two calls means one of them is a fabrication
    // or a misparse, and either way the user must know it did not happen.
    const model = stubModel(
      okResult([
        { name: "add_transaction", arguments: { amount: "10", category: "Groceries" } },
        { name: "add_transaction", arguments: { amount: "500", category: "Rent" } },
      ]),
    );
    const reply = await send("10 groceries and 500 rent", model);

    expect(reply.status).toBe("ok");
    expect(reply.notes?.join(" ")).toContain("ignored");
    expect(reply.text).toContain("separately");

    const written = rows();
    expect(written).toHaveLength(1);
    expect(written[0].amount_cents).toBe(1_000);
  });

  it("asks rather than guessing when the model names no tool", async () => {
    const model = stubModel(okResult([]));
    const reply = await send("hello there", model);

    expect(reply.source).toBe("model");
    expect(reply.status).toBe("question");
    expect(rows()).toEqual([]);
  });

  it("passes a model-produced confirmation through with instructions", async () => {
    const model = stubModel(
      okResult([{ name: "add_transaction", arguments: { amount: "4000", category: "Rent" } }]),
    );
    const reply = await send("4000 rent", model);

    expect(reply.status).toBe("confirm");
    expect(reply.text).toContain("$4,000.00");
    // Without this line the user is stuck staring at a prompt with no verb.
    expect(reply.text).toContain("/yes");
    expect(reply.text).toContain("/no");
    expect(rows()).toEqual([]);
  });

  it("carries an executor question through unchanged", async () => {
    const model = stubModel(
      okResult([{ name: "add_transaction", arguments: { amount: "10", category: "gro" } }]),
    );
    const reply = await send("10 on gro", model);

    expect(reply.status).toBe("question");
    expect(reply.text).toContain("Groceries");
    expect(reply.text).toContain("Grooming");
    expect(rows()).toEqual([]);
  });

  it("does not report success when the model's arguments are unreadable", async () => {
    const model = stubModel(
      okResult([{ name: "add_transaction", arguments: { amount: "several", category: "Groceries" } }]),
    );
    const reply = await send("a few quid on groceries", model);

    expect(reply.status).toBe("error");
    expect(reply.text).toContain("Nothing was saved");
    expect(rows()).toEqual([]);
  });

  it("sends the tool payload, not a description of it", async () => {
    const model = stubModel(okResult([{ name: "get_balances", arguments: {} }]));
    await send("what have I got", model);

    const payload = JSON.parse(model.calls[0].toolsJson) as Array<{ name: string }>;
    // Every tool must be present: Needle's encoder truncates the TAIL silently,
    // so the last tool is the canary.
    expect(payload.map((tool) => tool.name)).toContain("add_transaction");
    expect(payload.map((tool) => tool.name)).toContain("refresh_prices");
  });
});

describe("handleMessage: when the model is not there", () => {
  it("stays useful and says how to start it", async () => {
    // Rule 4.
    const reply = await send("spent 12 on something", stubModel({ status: "unavailable", reason: "connection refused" }));

    expect(reply.source).toBe("system");
    expect(reply.status).toBe("error");
    expect(reply.text).toContain("connection refused");
    expect(reply.text).toContain("/help");
    expect(reply.text).toContain(NEEDLE_START_HINT);
  });

  it("still runs slash commands with the model down", async () => {
    const reply = await send("/coffee", null);
    expect(reply.status).toBe("ok");
    expect(rows()).toHaveLength(1);
  });

  it("reports a model error without implying a write happened", async () => {
    const reply = await send(
      "10 groceries",
      stubModel({ status: "model-error", reason: "generate() raised" }),
    );
    expect(reply.status).toBe("error");
    expect(reply.text).toContain("nothing was saved");
    expect(rows()).toEqual([]);
  });

  it("asks for a rephrase when the output is unparseable", async () => {
    const reply = await send("mumble mumble", stubModel({ status: "unparseable", raw: "I think maybe" }));
    expect(reply.source).toBe("model");
    expect(reply.status).toBe("question");
    expect(reply.text).toContain("10 groceries");
    // The raw output is debug material, not something to show by default.
    expect(reply.debug).toBeUndefined();
  });

  it("surfaces the raw output only with debug on", async () => {
    const reply = await send("mumble mumble", stubModel({ status: "unparseable", raw: "I think maybe" }), true);
    expect(reply.debug?.raw).toBe("I think maybe");
  });

  it("treats a throwing client as a failure, never as a silent no-op", async () => {
    const thrower: NeedleClient = async () => {
      throw new Error("socket hang up");
    };
    const reply = await send("10 groceries", thrower);
    expect(reply.status).toBe("error");
    expect(reply.text).toContain("socket hang up");
    expect(rows()).toEqual([]);
  });

  it("refuses a shape it does not recognise rather than trusting it", async () => {
    const nonsense = stubModel({ status: "fine" } as unknown as NeedleResult);
    const reply = await send("10 groceries", nonsense);
    expect(reply.status).toBe("error");
    expect(rows()).toEqual([]);
  });
});

describe("handleMessage: confirmations", () => {
  async function askForALargeWrite() {
    const model = stubModel(
      okResult([{ name: "add_transaction", arguments: { amount: "4000", category: "Rent" } }]),
    );
    const asked = await send("4000 rent", model);
    expect(asked.status).toBe("confirm");
  }

  it("saves exactly once on /yes", async () => {
    await askForALargeWrite();
    const reply = await send("/yes", null);

    expect(reply.status).toBe("ok");
    expect(reply.text).toContain("$4,000.00");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].amount_cents).toBe(400_000);
    expect(pendingToolCalls()).toHaveLength(0);
  });

  it("saves nothing on /no", async () => {
    await askForALargeWrite();
    const reply = await send("/no", null);

    expect(reply.status).toBe("ok");
    expect(reply.text).toContain("Nothing was saved");
    expect(rows()).toEqual([]);
    expect(pendingToolCalls()).toHaveLength(0);
  });

  it("a second /yes cannot re-save the same write", async () => {
    await askForALargeWrite();
    await send("/yes", null);
    const second = await send("/yes", null);

    expect(second.status).toBe("error");
    expect(rows()).toHaveLength(1);
  });

  it("answers the NEWEST request and retires the older one", async () => {
    // Rule 5. Without this, the sequence below leaves a $4,000 write armed, and a
    // later /yes posts money nobody asked for.
    await askForALargeWrite();
    const second = stubModel(
      okResult([{ name: "add_transaction", arguments: { amount: "900", category: "Rent" } }]),
    );
    expect((await send("900 rent", second)).status).toBe("confirm");
    expect(pendingToolCalls()).toHaveLength(2);

    const reply = await send("/yes", null);
    expect(reply.status).toBe("ok");
    expect(reply.text).toContain("$900.00");
    expect(reply.notes?.join(" ")).toContain("older");
    expect(reply.text).toContain("$4,000.00"); // named in the note, not saved

    expect(rows()).toHaveLength(1);
    expect(rows()[0].amount_cents).toBe(90_000);

    // Nothing is left armed.
    expect(pendingToolCalls()).toHaveLength(0);
    const again = await send("/yes", null);
    expect(again.status).toBe("error");
    expect(rows()).toHaveLength(1);
  });

  it("says plainly that /yes had nothing to answer", async () => {
    const reply = await send("/yes", null);
    expect(reply.status).toBe("error");
    expect(reply.text).toContain("Nothing is waiting");
    expect(rows()).toEqual([]);
  });

  it("treats /no with nothing pending as reassurance, not an error", async () => {
    const reply = await send("/no", null);
    expect(reply.status).toBe("ok");
    expect(reply.text).toContain("nothing was saved");
  });
});

describe("handleMessage: undo end to end", () => {
  it("logs, then reverses, through the same entry point", async () => {
    expect((await send("/coffee", null)).status).toBe("ok");
    expect(rows()).toHaveLength(1);

    const undone = await send("/undo", null);
    expect(undone.status).toBe("ok");
    expect(undone.toolName).toBe("undo_last");
    expect(undone.text).toContain("Undone");
    expect(rows()).toEqual([]);

    const again = await send("/undo", null);
    expect(again.status).toBe("question");
    expect(again.text).toContain("Nothing to undo");
  });
});

describe("handleMessage: debug", () => {
  it("attaches nothing when debug is off", async () => {
    const model = stubModel(okResult([{ name: "get_balances", arguments: {} }]));
    const reply = await send("what have I got", model);
    expect(reply.debug).toBeUndefined();
  });

  it("attaches raw output, latency and the parsed calls when debug is on", async () => {
    const model = stubModel(okResult([{ name: "get_balances", arguments: {} }]));
    const reply = await send("what have I got", model, true);

    expect(reply.debug?.ms).toBe(42);
    expect(reply.debug?.raw).toContain("get_balances");
    expect(reply.debug?.calls).toHaveLength(1);
  });

  it("never attaches debug to a slash reply, which has no model output", async () => {
    const reply = await send("/balance", null, true);
    expect(reply.debug).toBeUndefined();
  });
});

describe("handleMessage: the `today` seam", () => {
  // A known and deliberately pinned limitation, not an accident. `opts.today`
  // controls relative-date resolution (below) and the executor's period wording,
  // but a call carrying NO date is defaulted by `dateArg` in tools.ts, which
  // calls `todayKey()` itself. So a caller in another timezone can fix
  // "yesterday" but cannot move the bare "10 groceries" case off the server's
  // day. Anyone changing this must change tools.ts, not handle.ts.

  it("controls the date when the message says something relative", async () => {
    const model = stubModel(
      okResult([{ name: "add_transaction", arguments: { amount: "10", category: "Groceries", date: "whenever" } }]),
    );
    await send("10 groceries yesterday", model);
    expect(dateKeyOf(rows()[0])).toBe("2026-07-14");
  });

  it("does NOT control the date when no date is mentioned at all", async () => {
    const model = stubModel(
      okResult([{ name: "add_transaction", arguments: { amount: "10", category: "Groceries" } }]),
    );
    await send("10 groceries", model);
    expect(dateKeyOf(rows()[0])).toBe(realTodayKey());
  });
});

describe("handleMessage: quick commands from settings", () => {
  it("reads them from the database when the caller does not supply them", async () => {
    // The API route and the CLI both rely on this default.
    const reply = await handleMessage("/help", { today: TODAY, needle: null, context: { journal } });
    expect(reply.status).toBe("ok");
    // No quick commands are seeded, so the built-ins must still be listed.
    expect(reply.text).toContain("/balance");
  });
});
