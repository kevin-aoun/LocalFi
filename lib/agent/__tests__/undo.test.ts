/**
 * `undo_last` and the journal behind it.
 *
 * ============================================================================
 * WHY THIS FILE MATTERS MORE THAN ITS SIZE SUGGESTS
 * ============================================================================
 *
 * `undo_last` is the reason the write tools are acceptable at all. Chat is a
 * typo-prone medium and a 26M model misparses, so the user needs a one-word way
 * back that does not involve hunting for a row in a table. That promise is only
 * worth something if undo is:
 *
 *   - **effective**  — the row is really gone from the file, not just from a list;
 *   - **idempotent** — undoing twice must NOT delete a second, unrelated row.
 *     This is the dangerous one: "undo, undo" is a completely natural thing to
 *     type, and the naive implementation eats the previous week's rent;
 *   - **honest**     — an effect it cannot reverse is reported, never approximated.
 *     Approximate undo of money is worse than no undo;
 *   - **bounded**    — in-memory, so it is empty after a restart, and it says so
 *     instead of pretending otherwise.
 *
 * Row-level assertions read the database file directly through `temp.query`, so
 * "the row is gone" is a fact about the file rather than about a cache.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDomainDb,
  execOn,
  seedAsset,
  seedBudget,
  seedCategory,
  type DomainDb,
} from "@/app/actions/__tests__/support/domain-fixture";
import {
  clearPendingToolCalls,
  confirmPendingToolCall,
  executeToolCall,
  type ExecuteContext,
} from "@/lib/agent/execute";
import { UNDO_JOURNAL_CAPACITY, UndoJournal } from "@/lib/agent/undo";
import { todayKey, type DateKey } from "@/lib/dates";

let temp: DomainDb;
let journal: UndoJournal;
let today: DateKey;

beforeEach(async () => {
  temp = await createDomainDb();
  seedCategory(temp, { id: 1, name: "Groceries", type: "Expense" });
  seedCategory(temp, { id: 2, name: "Rent", type: "Expense" });
  seedBudget(temp, {
    categoryId: 1,
    period: "monthly",
    limitCents: 10_000,
    effectiveFrom: "2020-01-01",
  });
  journal = new UndoJournal();
  today = todayKey();
  clearPendingToolCalls();
});

afterEach(async () => {
  clearPendingToolCalls();
  await temp.cleanup();
});

function ctx(overrides?: Partial<ExecuteContext>): ExecuteContext {
  return { today, journal, ...overrides };
}

function rows() {
  return temp.query("SELECT id, amount_cents, category_id FROM transactions ORDER BY id");
}

async function add(amount: string, category = "Groceries") {
  const outcome = await executeToolCall(
    { name: "add_transaction", arguments: { amount, category } },
    ctx(),
  );
  if (outcome.status !== "ok") {
    throw new Error(`setup write failed (${outcome.status}): ${outcome.reply}`);
  }
  return outcome;
}

const undo = () => executeToolCall({ name: "undo_last", arguments: {} }, ctx());

// ---------------------------------------------------------------------------

describe("undo_last: reversing a create", () => {
  it("removes the row it added", async () => {
    await add("10");
    expect(rows()).toHaveLength(1);

    const outcome = await undo();

    expect(outcome.status).toBe("ok");
    expect(outcome.reply).toContain("Undone");
    expect(outcome.reply).toContain("$10.00");
    expect(outcome.reply).toContain("Groceries");
    // The file, not a cache.
    expect(rows()).toEqual([]);
  });

  it("reports the budget the removal gave back", async () => {
    // The write says "$90.00 left"; the undo has to say the $100.00 is back, or
    // the user cannot tell whether it worked.
    await add("10");
    const outcome = await undo();
    expect(outcome.reply).toContain("$100.00 left of $100.00 this month");
  });

  it("undoes only the newest write, not everything", async () => {
    await add("10");
    await add("25", "Rent");
    expect(rows()).toHaveLength(2);

    await undo();

    const remaining = rows();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].amount_cents).toBe(1_000);
  });

  it("is a no-op the second time — undoing twice must not eat another row", async () => {
    // The failure this exists to prevent: "undo" then "undo" deleting last
    // week's rent because the journal handed out the same entry twice, or walked
    // back one further than the user meant.
    // A pre-existing row that the agent did NOT create. It is not in the journal,
    // so no number of undos may ever touch it.
    execOn(temp, (db) => {
      db.run(
        "INSERT INTO transactions (date, category_id, account_id, amount_cents, pending) VALUES (?, 2, 1, 120000, 0)",
        [Math.floor(Date.now() / 1000)],
      );
    });
    await add("10");
    expect(rows()).toHaveLength(2);

    const first = await undo();
    expect(first.status).toBe("ok");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].amount_cents).toBe(120_000);

    const second = await undo();
    expect(second.status).toBe("question");
    if (second.status !== "question") throw new Error("unreachable");
    expect(second.reason).toBe("nothing-to-undo");
    // The $1,200.00 the agent never created is still there. This is the actual
    // assertion: a second undo deleted nothing.
    expect(rows()).toHaveLength(1);
    expect(rows()[0].amount_cents).toBe(120_000);
  });

  it("walks back through several writes one at a time", async () => {
    await add("10");
    await add("20");
    await add("30");

    await undo();
    await undo();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].amount_cents).toBe(1_000);

    await undo();
    expect(rows()).toEqual([]);

    const extra = await undo();
    expect(extra.status).toBe("question");
  });

  it("refuses to delete a row that has changed since it was added", async () => {
    // Ids are AUTOINCREMENT so they are never reused, but an edit in the UI can
    // still change what the row MEANS. Deleting it anyway would destroy an edit
    // the user made deliberately.
    const created = await add("10");
    expect(created.status).toBe("ok");
    const id = Number(rows()[0].id);

    execOn(temp, (db) => {
      db.run("UPDATE transactions SET amount_cents = 9999 WHERE id = ?", [id]);
    });

    const outcome = await undo();
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("unreachable");
    expect(outcome.reason).toBe("refused");
    expect(outcome.reply).toContain("$99.99");
    expect(outcome.reply).toContain("did not delete");
    // Still there, unchanged by us.
    expect(rows()).toHaveLength(1);
    expect(rows()[0].amount_cents).toBe(9999);
  });

  it("says so calmly when the row is already gone, and moves on", async () => {
    await add("10");
    await add("20");
    const newest = Number(rows()[1].id);
    execOn(temp, (db) => {
      db.run("DELETE FROM transactions WHERE id = ?", [newest]);
    });

    const first = await undo();
    expect(first.status).toBe("ok");
    expect(first.reply).toContain("already gone");

    // The entry is retired, so the next undo addresses the OLDER write instead of
    // repeating itself forever.
    const second = await undo();
    expect(second.status).toBe("ok");
    expect(rows()).toEqual([]);
  });
});

describe("undo_last: with nothing to undo", () => {
  it("replies sensibly on an empty journal instead of erroring", async () => {
    const outcome = await undo();

    expect(outcome.status).toBe("question");
    if (outcome.status !== "question") throw new Error("unreachable");
    expect(outcome.reason).toBe("nothing-to-undo");
    expect(outcome.reply).toContain("Nothing to undo");
    // The honesty requirement: the journal is memory-only, and the reply says so
    // rather than leaving the user to wonder where their history went.
    expect(outcome.reply).toContain("restarts");
    expect(outcome.reply).toContain("transactions page");
  });

  it("does not touch the database when there is nothing to undo", async () => {
    execOn(temp, (db) => {
      db.run(
        "INSERT INTO transactions (date, category_id, account_id, amount_cents, pending) VALUES (?, 1, 1, 5000, 0)",
        [Math.floor(Date.now() / 1000)],
      );
    });
    const before = rows();
    await undo();
    expect(rows()).toEqual(before);
  });

  it("refuses to approximate an irreversible change", async () => {
    // A price refresh cannot be put back: restoring the old number through
    // `updateAsset` would drop `price_symbol` and leave the holding unable to
    // refresh again. So the journal records "none" and undo says so.
    journal.record({
      tool: "refresh_prices",
      label: "a price refresh",
      reverse: { kind: "none", reason: "putting an old price back would unlink the symbol" },
    });

    const outcome = await undo();
    expect(outcome.status).toBe("question");
    if (outcome.status !== "question") throw new Error("unreachable");
    expect(outcome.reason).toBe("not-reversible");
    expect(outcome.reply).toContain("can't reverse it");
    expect(outcome.reply).toContain("Nothing was changed");
  });

  it("stops at an irreversible entry rather than silently undoing an older one", async () => {
    // Skipping past it would delete a transaction the user never mentioned.
    await add("10");
    journal.record({
      tool: "refresh_prices",
      label: "a price refresh",
      reverse: { kind: "none", reason: "no previous price was recorded" },
    });

    const outcome = await undo();
    expect(outcome.status).toBe("question");
    expect(rows()).toHaveLength(1);
  });
});

describe("undo_last: reversing a hand-set holding value", () => {
  it("puts the previous value back without blanking the rest of the row", async () => {
    seedAsset(temp, { category: "Vehicles", currentValueCents: 1_800_000, notes: "Car" });

    const pending = await executeToolCall(
      { name: "set_asset_value", arguments: { asset: "Car", value: "15000" } },
      ctx(),
    );
    if (pending.status !== "confirm") throw new Error(`expected confirm, got ${pending.status}`);
    const written = await confirmPendingToolCall(pending.pending, ctx());
    expect(written.status).toBe("ok");
    expect(Number(temp.scalar("SELECT current_value_cents FROM assets WHERE notes = 'Car'"))).toBe(
      1_500_000,
    );

    const outcome = await undo();
    expect(outcome.status).toBe("ok");
    expect(outcome.reply).toContain("$18,000.00");
    expect(Number(temp.scalar("SELECT current_value_cents FROM assets WHERE notes = 'Car'"))).toBe(
      1_800_000,
    );
    // The note survived: a restore must change the value and nothing else.
    expect(temp.scalar("SELECT notes FROM assets WHERE category = 'Vehicles'")).toBe("Car");
  });

  it("is a no-op the second time", async () => {
    seedAsset(temp, { category: "Vehicles", currentValueCents: 1_800_000, notes: "Car" });
    const pending = await executeToolCall(
      { name: "set_asset_value", arguments: { asset: "Car", value: "15000" } },
      ctx(),
    );
    if (pending.status !== "confirm") throw new Error("expected confirm");
    await confirmPendingToolCall(pending.pending, ctx());

    await undo();
    const second = await undo();
    expect(second.status).toBe("question");
    expect(Number(temp.scalar("SELECT current_value_cents FROM assets WHERE notes = 'Car'"))).toBe(
      1_800_000,
    );
  });
});

describe("UndoJournal", () => {
  it("hands out unique ids and returns the stored record", () => {
    const local = new UndoJournal();
    const a = local.record({ tool: "add_transaction", label: "a", reverse: { kind: "none", reason: "x" } });
    const b = local.record({ tool: "add_transaction", label: "b", reverse: { kind: "none", reason: "x" } });
    expect(a.id).not.toBe(b.id);
    expect(local.size).toBe(2);
  });

  it("marks an entry undone exactly once", () => {
    const local = new UndoJournal();
    const entry = local.record({ tool: "t", label: "l", reverse: { kind: "none", reason: "x" } });

    expect(local.markUndone(entry.id, 1)).toBe(true);
    // The guard that makes a double undo a no-op.
    expect(local.markUndone(entry.id, 2)).toBe(false);
    expect(local.markUndone("undo-does-not-exist")).toBe(false);
  });

  it("skips undone entries when peeking", () => {
    const local = new UndoJournal();
    const first = local.record({ tool: "t", label: "first", reverse: { kind: "none", reason: "x" } });
    const second = local.record({ tool: "t", label: "second", reverse: { kind: "none", reason: "x" } });

    expect(local.peek()?.id).toBe(second.id);
    local.markUndone(second.id, 1);
    expect(local.peek()?.id).toBe(first.id);
    local.markUndone(first.id, 2);
    expect(local.peek()).toBeNull();
  });

  it("is bounded, dropping the oldest entries", () => {
    const local = new UndoJournal(3);
    for (const label of ["a", "b", "c", "d"]) {
      local.record({ tool: "t", label, reverse: { kind: "none", reason: "x" } });
    }
    expect(local.size).toBe(3);
    expect(local.entries().map((entry) => entry.label)).toEqual(["b", "c", "d"]);
  });

  it("defaults to a sane capacity", () => {
    expect(new UndoJournal().capacity).toBe(UNDO_JOURNAL_CAPACITY);
    expect(UNDO_JOURNAL_CAPACITY).toBeGreaterThan(0);
  });

  it("rejects a nonsense capacity instead of quietly accepting it", () => {
    expect(() => new UndoJournal(0)).toThrow();
    expect(() => new UndoJournal(-1)).toThrow();
    expect(() => new UndoJournal(2.5)).toThrow();
  });

  it("hands out copies, so a caller cannot mark its own entries undone", () => {
    const local = new UndoJournal();
    const entry = local.record({ tool: "t", label: "l", reverse: { kind: "none", reason: "x" } });
    const copy = local.entries()[0];
    copy.undoneAt = 12345;
    expect(local.peek()?.id).toBe(entry.id);
  });

  it("lists still-undoable entries newest first", () => {
    const local = new UndoJournal();
    local.record({ tool: "t", label: "old", reverse: { kind: "none", reason: "x" } });
    const mid = local.record({ tool: "t", label: "mid", reverse: { kind: "none", reason: "x" } });
    local.record({ tool: "t", label: "new", reverse: { kind: "none", reason: "x" } });
    local.markUndone(mid.id, 1);

    expect(local.pending().map((entry) => entry.label)).toEqual(["new", "old"]);
  });

  it("forgets everything on clear", () => {
    const local = new UndoJournal();
    local.record({ tool: "t", label: "l", reverse: { kind: "none", reason: "x" } });
    local.clear();
    expect(local.size).toBe(0);
    expect(local.peek()).toBeNull();
  });
});
