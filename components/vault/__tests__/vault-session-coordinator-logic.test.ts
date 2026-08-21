import { describe, expect, it } from "vitest";

import {
  statusRequest,
  vaultStatusIsUnlocked,
} from "../vault-session-coordinator-logic";

describe("vault session coordinator", () => {
  it("checks without extending an idle session", () => {
    expect(statusRequest(false)).toEqual({ method: "GET" });
  });

  it("touches the session only after genuine client activity", () => {
    expect(statusRequest(true)).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  });

  it("keeps financial UI visible only for an unlocked status", () => {
    expect(vaultStatusIsUnlocked({ status: "unlocked" })).toBe(true);
    expect(vaultStatusIsUnlocked({ status: "locked" })).toBe(false);
    expect(vaultStatusIsUnlocked({ status: "uninitialized" })).toBe(false);
    expect(vaultStatusIsUnlocked({})).toBe(false);
  });
});
