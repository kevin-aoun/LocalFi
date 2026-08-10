import { describe, expect, it } from "vitest";

import { isPrivacyExempt } from "@/components/shared/privacy-provider";
import { maskPrivacyAttribute, maskPrivacyDigits, PRIVACY_MASK_TOKEN } from "@/lib/privacy";

describe("privacy digit masking", () => {
  it("uses one fixed token regardless of the value's magnitude or shape", () => {
    expect(maskPrivacyDigits("$4,812.58")).toBe(PRIVACY_MASK_TOKEN);
    expect(maskPrivacyDigits("2026-08-06 · 50% used")).toBe(PRIVACY_MASK_TOKEN);
    expect(maskPrivacyDigits("999999999999999999")).toBe(PRIVACY_MASK_TOKEN);
  });

  it("leaves labels unchanged", () => {
    expect(maskPrivacyDigits("Net worth · Investments")).toBe("Net worth · Investments");
  });

  it("does not alter prose that has been marked exempt by the DOM masker", () => {
    const exemptProse = "Report generated in 2026: figures omitted";
    const exemptParent = { closest: () => ({}) };
    const ordinaryParent = { closest: () => null };

    expect(isPrivacyExempt(exemptParent)).toBe(true);
    expect(isPrivacyExempt(ordinaryParent)).toBe(false);
    expect(
      isPrivacyExempt(exemptParent) ? exemptProse : maskPrivacyDigits(exemptProse),
    ).toBe(exemptProse);
  });

  it("masks accessible labels without losing their original value", () => {
    const label = "Show Emergency Fund ($12,345.67) again";
    expect(maskPrivacyAttribute(label)).toBe(PRIVACY_MASK_TOKEN);
    expect(maskPrivacyAttribute("Show Emergency Fund again")).toBe("Show Emergency Fund again");
  });
});
