import { describe, expect, it } from "vitest";

import {
  idleTimeoutSecurityWarning,
} from "../settings-logic";

describe("inactivity timeout settings", () => {
  it("warns when a timeout is longer than thirty minutes", () => {
    expect(idleTimeoutSecurityWarning(30)).toBeNull();
    expect(idleTimeoutSecurityWarning(31)).toMatch(/unattended device/i);
  });
});
