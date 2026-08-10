import { describe, expect, it } from "vitest";

import { PRIVACY_MASKED_ATTRIBUTES, PRIVACY_MASK_TOKEN } from "@/lib/privacy";

describe("privacy provider contract", () => {
  it("limits reversible masking to accessible value-bearing attributes", () => {
    expect(PRIVACY_MASKED_ATTRIBUTES).toEqual(["aria-label", "aria-valuetext", "title"]);
    expect(PRIVACY_MASK_TOKEN).toBe("••••");
  });
});
