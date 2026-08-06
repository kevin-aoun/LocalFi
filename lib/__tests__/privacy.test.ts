import { describe, expect, it } from "vitest";

import { maskPrivacyDigits } from "@/lib/privacy";

describe("privacy digit masking", () => {
  it("replaces digits while preserving currency and punctuation", () => {
    expect(maskPrivacyDigits("$4,812.58")).toBe("$•,•••.••");
    expect(maskPrivacyDigits("2026-08-06 · 50% used")).toBe("••••-••-•• · ••% used");
  });

  it("leaves labels unchanged", () => {
    expect(maskPrivacyDigits("Net worth · Investments")).toBe("Net worth · Investments");
  });
});
