import { describe, expect, it } from "vitest";

import {
  canContinueAfterRecovery,
  initialVaultPanelMode,
} from "../vault-panel-logic";

describe("vault panel state", () => {
  it("routes absent and legacy databases to setup and encrypted vaults to unlock", () => {
    expect(initialVaultPanelMode("uninitialized")).toBe("setup");
    expect(initialVaultPanelMode("locked")).toBe("unlock");
  });

  it("does not continue past a one-time recovery secret without deliberate confirmation", () => {
    expect(canContinueAfterRecovery(false)).toBe(false);
    expect(canContinueAfterRecovery(true)).toBe(true);
  });
});
