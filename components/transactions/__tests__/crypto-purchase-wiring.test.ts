import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { transactionInvestmentKind } from "../transaction-form-logic";

const root = path.resolve(__dirname, "..", "..", "..");
const dialog = readFileSync(path.join(root, "components/transactions/transaction-dialog.tsx"), "utf8");
const page = readFileSync(path.join(root, "app/(dashboard)/transactions/page.tsx"), "utf8");
const home = readFileSync(path.join(root, "app/(dashboard)/page.tsx"), "utf8");

describe("one category-driven transaction form", () => {
  it("uses configured fields after renames and keeps plain investment categories plain", () => {
    expect(transactionInvestmentKind({ type: "Investment", investmentKind: "stock" })).toBe("stock");
    expect(transactionInvestmentKind({ type: "Investment", investmentKind: "crypto" })).toBe("crypto");
    expect(transactionInvestmentKind({ type: "Investment" })).toBeNull();
    expect(transactionInvestmentKind({ type: "Expense" }, "BTC")).toBeNull();
    expect(transactionInvestmentKind({ type: "Investment" }, "BTC")).toBe("crypto");
  });
  it("keeps category above description and customizes fields inside the same dialog", () => {
    expect(dialog.indexOf('htmlFor="category"')).toBeLessThan(dialog.indexOf('htmlFor="comment"'));
    expect(dialog).toContain("<InvestmentFields kind={investmentKind}");
    expect(page).not.toMatch(/AssetDialog|cryptoPurchase|onCreateCryptoPurchase/);
    expect(dialog).not.toMatch(/startCryptoPurchase|Get provider preview/);
    const fields = readFileSync(path.join(root, "components/transactions/investment-fields.tsx"), "utf8");
    expect(fields).toMatch(/id="investment-quantity"[^>]*data-private-input/);
  });
  it("removes Home's creation entry points", () => {
    expect(home).not.toMatch(/openAddDialog|Add Your First Asset|setDialogOpen\(true\)/);
    expect(home).toContain('href="/transactions"');
  });
});
