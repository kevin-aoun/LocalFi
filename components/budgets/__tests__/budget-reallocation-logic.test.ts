import { describe, expect, it } from "vitest";

import {
  draftedReallocationCents,
  reallocationMaximumCents,
  reallocationOverflowCents,
} from "../budget-reallocation-logic";

describe("budget reallocation draft", () => {
  it("caps the move at budgeted minus confirmed spending", () => {
    expect(reallocationMaximumCents(50_000, 12_345)).toBe(37_655);
    expect(reallocationMaximumCents(50_000, 55_000)).toBe(0);
  });

  it("keeps percentages based on the allocation and exposes overflow inline", () => {
    const candidate = draftedReallocationCents("percentage", "50", 50_000);
    expect(candidate).toBe(25_000);
    expect(reallocationOverflowCents(candidate, 12_000)).toBe(13_000);
    expect(reallocationOverflowCents(draftedReallocationCents("amount", "120", 50_000), 12_000)).toBeNull();
  });
});
