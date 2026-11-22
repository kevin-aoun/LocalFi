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

const assetRoot = path.join(path.resolve(__dirname, ".."));
const source = ["asset-dialog.tsx", "asset-form-fields.tsx", "asset-form-logic.ts"]
  .map((file) => readFileSync(path.join(assetRoot, file), "utf-8"))
  .join("\n");

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
    expect(source).toMatch(/category === "Crypto" \|\| category === "Investments" \? true : prev\.useLivePrice/);
  });

  it("labels the shared received units as Shares or Coins", () => {
    expect(source).toMatch(/isStock \? "Shares" : "Coins"/);
    expect(source).toMatch(/"coins"/);
  });

  it("always collects the fixed purchase price and keeps market previews out of the shared purchase fields", () => {
    expect(source).toMatch(/Price \(USD\)/);
    expect(source).toMatch(/Price per/);
    expect(source).toMatch(/step="0\.0001"/);
    const fields = source.slice(source.indexOf("export function InvestmentFields"), source.indexOf("export function CommodityFields"));
    expect(fields).not.toMatch(/LivePriceCheckbox|formData\.useLivePrice/);
    expect(source).not.toMatch(/Live profit \/ loss|purchase.set\("refreshPrice"/);
  });

  it("routes a live-priced save through the priced-holding refresh action", () => {
    expect(source).toMatch(/updateLivePricedAsset/);
    expect(source).toMatch(/getLivePriceQuote/);
  });

  it("adds only manually valued holdings; priced purchases stay in Transactions", () => {
    expect(source).toMatch(/options=\{asset \? ASSET_TYPES : MANUAL_ASSET_TYPES\}/);
    expect(source).not.toMatch(/createLivePricedAsset|createTransaction|cryptoPurchase|Paid from/);
    expect(source.match(/<AssetCategoryField\b/g)).toHaveLength(1);
  });
});

describe("confirmed purchases no longer depend on manual asset linking", () => {
  it("does not offer the superseded transaction-link workflow", () => {
    expect(source).not.toMatch(/setAssetPurchaseLinks/);
    expect(source).not.toMatch(/linkedTransactionIds/);
    expect(source).not.toMatch(/then link it here/i);
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
    expect(code).not.toMatch(/\.toFixed\(/);
    expect(code).toContain("commodityQuantityFields");
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
    expect(source).toMatch(/const DEFAULT_ASSET_TYPE = "Properties"/);
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
