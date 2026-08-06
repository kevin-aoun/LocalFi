/**
 * The undo journal for writes made THROUGH THE AGENT.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * `undo_last` is what makes the write tools acceptable at all (rule 5 in
 * lib/agent/tools.ts). Chat is a typo-prone medium and a 26M model misparses; the
 * user needs a one-word escape hatch that does not require finding the row in a
 * table. So every write the executor performs is recorded here together with
 * exactly what is needed to reverse it — a created transaction's id, an asset's
 * previous value — or with an honest note that it cannot be reversed.
 *
 * ============================================================================
 * WHY IT IS MEMORY-ONLY
 * ============================================================================
 *
 * The journal is NOT persisted, and specifically not to a file under `data/`.
 * `lib/db/client.ts` serializes writers with an IN-PROCESS lock and `saveDb()`
 * rewrites the entire database file; a second writer under `data/` risks
 * last-writer-wins over the whole ledger. A lost undo list after a restart costs
 * the user one manual delete. Losing the database costs them their financial
 * history. So the journal lives in memory, and the honest consequence is stated
 * in the reply ("nothing to undo") rather than papered over with invented
 * durability.
 *
 * ============================================================================
 * WHAT UNDO GUARANTEES
 * ============================================================================
 *
 * - **Idempotent.** An entry is marked undone the moment its reversal succeeds,
 *   and `takeUndoable()` never returns it again. Undoing twice cannot delete a
 *   second, unrelated row — the failure mode this exists to prevent.
 * - **Honest.** An effect that cannot be reversed with what was recorded is
 *   journalled as `{ kind: "none", reason }`, and `undo_last` says so instead of
 *   doing something approximate. Approximate undo of money is worse than none.
 * - **Bounded.** The last `capacity` entries only; the journal is a safety valve,
 *   not an audit log. The database is the audit log.
 */
import type { Cents } from "@/lib/money";
import type { DateKey } from "@/lib/dates";

/** How many entries a journal keeps. Older entries fall off the back. */
export const UNDO_JOURNAL_CAPACITY = 20;

/**
 * The recorded inverse of a write.
 *
 * `expect` on a transaction reversal is a cheap identity check: the row is only
 * deleted when the id STILL holds a row with the same amount, so a journal entry
 * can never delete something else that happens to carry that id.
 */
export type UndoAction =
  | {
      kind: "delete-transaction";
      transactionId: number;
      expect: { amountCents: Cents; dateKey: DateKey };
    }
  | {
      kind: "restore-asset-value";
      assetId: number;
      previousValueCents: Cents;
      /** Every other field `updateAsset` overwrites, so restoring changes only the value. */
      snapshot: AssetValueSnapshot;
    }
  | { kind: "none"; reason: string };

/**
 * The fields `app/actions/assets.ts:updateAsset` rewrites from the form. They are
 * captured BEFORE the write so a restore puts the row back exactly, instead of
 * blanking a quantity or a note as a side effect of fixing a value.
 */
export type AssetValueSnapshot = {
  category: string;
  currency: string;
  notes: string | null;
  commodityType: string | null;
  /** A physical quantity, not money. `0` is a real quantity; `null` means absent. */
  quantity: number | null;
  unit: string | null;
  linkedTransactionIds: string | null;
  useLivePrice: boolean;
};

export type UndoRecord = {
  /** Unique within a journal instance. */
  id: string;
  /** The tool that produced the write, e.g. "add_transaction". */
  tool: string;
  /** Epoch millis. Only for display and ordering. */
  at: number;
  /** What was done, phrased for a chat reply: "$10.00 → Groceries on 2026-07-28". */
  label: string;
  reverse: UndoAction;
  /** Set once the reversal has succeeded. A set value makes the entry inert. */
  undoneAt?: number;
};

export type UndoDraft = {
  tool: string;
  label: string;
  reverse: UndoAction;
  /** Injectable clock, for deterministic tests. */
  at?: number;
};

/**
 * A bounded, in-process list of reversible agent writes, newest last.
 *
 * Not thread-shared and not locked: Node runs this on one thread, and the
 * executor awaits each action before recording it.
 */
export class UndoJournal {
  private records: UndoRecord[] = [];
  private sequence = 0;

  constructor(readonly capacity: number = UNDO_JOURNAL_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`UndoJournal capacity must be a positive integer, got ${capacity}`);
    }
  }

  /** Append a write. Returns the stored record, including its generated id. */
  record(draft: UndoDraft): UndoRecord {
    const entry: UndoRecord = {
      id: `undo-${++this.sequence}`,
      tool: draft.tool,
      at: draft.at ?? Date.now(),
      label: draft.label,
      reverse: draft.reverse,
    };
    this.records.push(entry);
    if (this.records.length > this.capacity) {
      this.records = this.records.slice(-this.capacity);
    }
    return entry;
  }

  /**
   * The newest entry that has not been undone, or null.
   *
   * Deliberately returns irreversible entries too. Skipping them would silently
   * undo an OLDER write the user never mentioned; reporting "the last change was
   * a price refresh, which I can't reverse" and stopping is the safe answer.
   */
  peek(): UndoRecord | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].undoneAt === undefined) return this.records[i];
    }
    return null;
  }

  /**
   * Mark an entry undone. Returns false when it is unknown or already undone —
   * the guard that makes a double `undo_last` a no-op.
   */
  markUndone(id: string, at: number = Date.now()): boolean {
    const entry = this.records.find((record) => record.id === id);
    if (!entry || entry.undoneAt !== undefined) return false;
    entry.undoneAt = at;
    return true;
  }

  /** Oldest first. A copy: callers cannot mutate the journal through it. */
  entries(): UndoRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  /** Entries still available to undo, newest first. */
  pending(): UndoRecord[] {
    return this.entries()
      .filter((record) => record.undoneAt === undefined)
      .reverse();
  }

  get size(): number {
    return this.records.length;
  }

  /** Forget everything. Used between tests; there is no user-facing path to it. */
  clear(): void {
    this.records = [];
  }
}

/**
 * The journal the executor uses when a caller does not inject one.
 *
 * Module-level, therefore per-process: in `next dev` it survives across requests
 * but not across a restart or a second worker. That is the documented trade —
 * see the header — and `undo_last` says "nothing to undo" rather than pretending
 * otherwise.
 */
export const agentUndoJournal = new UndoJournal();
