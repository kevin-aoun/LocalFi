import { describe, expect, it } from "vitest";

import { validateAgentGuidance } from "../validate-agent-guidance";

describe("agent guidance", () => {
  it("keeps root guidance and scoped Claude/Cursor rules in sync", () => {
    expect(validateAgentGuidance(process.cwd())).toEqual([]);
  });
});
