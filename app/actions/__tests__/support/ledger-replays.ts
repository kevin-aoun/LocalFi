import { vi } from "vitest";

import { readDb } from "@/lib/db/client";

// readCurrentMovements starts every full ledger replay with this query.
const REPLAY_QUERY = /SELECT event_id, sequence, effective_date, amends_event_id\s+FROM ledger_events ORDER BY sequence/;

/** Run `fn` against the loaded database and count how many full ledger replays it performed. */
export async function countLedgerReplays<T>(fn: () => Promise<T>): Promise<{ result: T; replays: number }> {
  const raw = await readDb((_db, handle) => handle);
  const prepare = vi.spyOn(raw, "prepare");
  try {
    const result = await fn();
    const replays = prepare.mock.calls.filter(([sql]) => REPLAY_QUERY.test(String(sql))).length;
    return { result, replays };
  } finally {
    prepare.mockRestore();
  }
}
