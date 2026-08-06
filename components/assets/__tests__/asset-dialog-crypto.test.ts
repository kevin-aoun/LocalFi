/**
 * Shape guards for the Add/Edit Asset dialog's live-pricing UI.
 *
 * There is no jsdom in this repo, so — exactly like
 * components/__tests__/error-surfacing.test.ts — these assert the shape of the
 * source. Cheap, but they pin the three regressions that actually hurt:
 *
 *   1. the dialog reported success on failure (it must inspect `{ error }`);
 *   2. it defaulted to the always-rejected `Cash` category;
 *   3. money was hand-rolled as `$${x.toFixed(2)}` instead of `formatMoney`.
 *
 * Plus the new requirement: Bitcoin and Ethereum must be pickable as live-priced
 * holdings, with a quantity and a computed value, and a failed/offline fetch must
 * be visible in the UI rather than silently saving $0.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { cryptoPriceSymbols, PRICED_HOLDINGS } from "@/lib/prices";

const source = readFileSync(
  path.join(path.resolve(__dirname, "..", "..", ".."), "components/assets/asset-dialog.tsx"),
  "utf-8",
);

const dialogSource = readFileSync(
  path.join(path.resolve(__dirname, "..", "..", ".."), "components/ui/dialog.tsx"),
  "utf-8",
);

/** Remove comments so prose describing a removed idiom is not a false hit. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{?\s*\/\/.*$/gm, "");
}

describe("Bitcoin and Ethereum are pickable live-priced holdings", () => {
  it("offers both coins from the shared registry, not a hand-written list", () => {
    expect(cryptoPriceSymbols).toEqual(["BTC", "ETH"]);
    expect(PRICED_HOLDINGS.BTC.label).toBe("Bitcoin");
    expect(PRICED_HOLDINGS.ETH.label).toBe("Ethereum");
    expect(source).toMatch(/from "@\/lib\/prices"/);
    expect(source).toMatch(/cryptoPriceSymbols|CRYPTO_CHOICES/);
  });

  it("keeps a Crypto asset in the Crypto category and offers live pricing there", () => {
    expect(source).toMatch(/const ASSET_TYPES = \[[^\]]*"Crypto"/);
    // The live-price controls are no longer gated on Commodities alone.
    expect(source).toMatch(/liveSymbol/);
  });

  it("labels the crypto quantity as a coin count, not a weight", () => {
    expect(source).toMatch(/Quantity \(coins\)/);
    expect(source).toMatch(/"coins"/);
  });

  it("routes a live-priced save through the priced-holding action", () => {
    expect(source).toMatch(/createLivePricedAsset/);
    expect(source).toMatch(/updateLivePricedAsset/);
    expect(source).toMatch(/getLivePriceQuote/);
  });
});

describe("money is never hand-rolled", () => {
  it("formats every amount with formatMoney", () => {
    expect(source).toMatch(/import \{[^}]*formatMoney[^}]*\} from "@\/lib\/money"/);
    const code = stripComments(source);
    // No hand-rolled money: `$${x.toFixed(2)}` and friends.
    expect(code).not.toMatch(/\$\$\{/);
    expect(code).not.toMatch(/\$\{[^}]*toFixed/);
    expect(code).not.toMatch(/"\$"/);
    // The only rounding left is unit conversion for the WEIGHT fields, which is
    // not money: grams <-> troy ounces.
    for (const match of code.match(/\.toFixed\(\d\)/g) ?? []) {
      expect(match).toMatch(/toFixed\(2\)|toFixed\(4\)/);
    }
    expect(code).toMatch(/ozToGrams\(oz\)\.toFixed\(2\)/);
  });

  it("rounds quantity x price to the cent exactly once, through lib/prices", () => {
    expect(source).toMatch(/holdingValueCents/);
  });
});

describe("failure is visible, never a silent $0", () => {
  it("inspects the action result before reporting success", () => {
    const guard = source.indexOf('"error" in result');
    const success = source.indexOf("onSuccess();");
    expect(guard).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(guard);
  });

  it("keeps the failed quote in state and renders it", () => {
    expect(source).toMatch(/priceError/);
    expect(source).toMatch(/role="alert"/);
    expect(source).toMatch(/unavailable/i);
  });

  it("tells the user the stored value is stale rather than overwriting it", () => {
    expect(source).toMatch(/stale|last (known|priced)/i);
    expect(source).toMatch(/pricedAt/);
  });

  it("still refuses to default to the derived Cash category", () => {
    const list = /const ASSET_TYPES = \[([^\]]*)\]/.exec(source);
    expect(list).not.toBeNull();
    expect(list![1]).not.toMatch(/"Cash"/);
    expect(source).toMatch(/const DEFAULT_ASSET_TYPE = "Savings"/);
  });

  it("treats a quantity of 0 as a value, not as absent", () => {
    // `quantity ? … : ""` is the falsy-zero bug that broke live pricing.
    expect(source).toMatch(/trim\(\) !== ""/);
    expect(stripComments(source)).not.toMatch(/quantity \?/);
  });
});

describe("the dialog stays inside the viewport", () => {
  it("scrolls vertically and clips horizontal overflow", () => {
    expect(dialogSource).toMatch(/max-h-\[calc\(100dvh-2rem\)\]/);
    expect(dialogSource).toMatch(/overflow-y-auto/);
    expect(dialogSource).toMatch(/overflow-x-hidden/);
    expect(dialogSource).toMatch(/w-\[calc\(100vw-2rem\)\]/);
  });

  it("stacks paired asset fields on narrow screens", () => {
    expect(source.match(/grid-cols-1 gap-4 sm:grid-cols-2/g)).toHaveLength(3);
  });
});
