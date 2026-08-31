import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const componentsRoot = path.resolve(__dirname, "..", "..");
const dialog = readFileSync(path.join(componentsRoot, "transactions", "transaction-dialog.tsx"), "utf-8");
const page = readFileSync(
  path.join(componentsRoot, "..", "app", "(dashboard)", "transactions", "page.tsx"),
  "utf-8",
);

describe("crypto purchase entry points", () => {
  it("routes transaction-page crypto creation through AssetDialog", () => {
    expect(page).toMatch(/import \{ AssetDialog \} from "@\/components\/assets\/asset-dialog"/);
    expect(page).toMatch(/cryptoPurchase/);
    expect(page).toMatch(/onCreateCryptoPurchase=\{openCryptoPurchase\}/);
  });

  it("offers the shared asset form instead of a second new-purchase form", () => {
    expect(dialog).toMatch(/Buying crypto\?/);
    expect(dialog).toMatch(/Add crypto purchase/);
    expect(dialog).toMatch(/onCreateCryptoPurchase/);
  });
});
