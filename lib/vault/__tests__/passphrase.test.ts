import { describe, expect, it } from "vitest";

import {
  assessPassphrase,
  parseInactivityTimeout,
  validatePassphraseSubmission,
} from "../passphrase";

describe("vault passphrase policy", () => {
  it("rejects missing, short, and unbounded input", () => {
    expect(assessPassphrase(undefined).valid).toBe(false);
    expect(assessPassphrase("elevenchars").valid).toBe(false);
    expect(assessPassphrase("x".repeat(257)).valid).toBe(false);
  });

  it("warns on common, repeated, and sequential choices", () => {
    for (const passphrase of [
      "password123!",
      "passwordpassword",
      "localfi123456",
      "thisispassword",
      "abababababab",
      "abcdefghijkl",
      "onlylowercase",
    ]) {
      expect(assessPassphrase(passphrase)).toMatchObject({ valid: true });
      expect(assessPassphrase(passphrase).warning).toMatch(/simple|repetitive/i);
      expect(validatePassphraseSubmission(passphrase, false).valid).toBe(false);
      expect(validatePassphraseSubmission(passphrase, true).valid).toBe(true);
    }
  });

  it("accepts a varied long passphrase without weakening it", () => {
    expect(assessPassphrase("cedar harbor lantern 47 violet")).toEqual({
      valid: true,
      warning: null,
      error: null,
    });
  });
});

describe("inactivity timeout bounds", () => {
  it("accepts 1, 15, and 120 and rejects 0, fractions, and 121", () => {
    expect(parseInactivityTimeout(1)).toBe(1);
    expect(parseInactivityTimeout(15)).toBe(15);
    expect(parseInactivityTimeout(120)).toBe(120);
    for (const value of [0, 1.5, 121, "15", null]) {
      expect(() => parseInactivityTimeout(value)).toThrow(/1 to 120/);
    }
  });
});
