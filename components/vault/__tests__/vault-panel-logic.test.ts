import { describe, expect, it } from "vitest";

import {
  canContinueAfterRecovery,
  initialVaultPanelMode,
  setupCredentialFromFragment,
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

  it("accepts only a bounded setup credential from the URL fragment", () => {
    const credential = "a".repeat(64);
    expect(setupCredentialFromFragment(`#setup=${credential}`)).toBe(credential);
    expect(setupCredentialFromFragment("#setup=short")).toBe("");
    expect(setupCredentialFromFragment("#unrelated=value")).toBe("");
  });
});
