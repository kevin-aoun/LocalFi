import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("ConfirmPendingTransaction", () => {
  it("offers an explicit today path and exchanges calendar keys at the action boundary", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../confirm-pending-transaction.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("Confirm for today");
    expect(source).toContain("todayKey()");
    expect(source).toContain("toDateKey(date)");
    expect(source).toContain("confirmTransaction(transactionId, dateKey)");
    expect(source).toContain("setOpen(false)");
  });
});
