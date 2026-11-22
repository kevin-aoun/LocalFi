import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..", "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const page = read("app/(dashboard)/transactions/page.tsx");
const DISPATCH = 'window.dispatchEvent(new Event("localfi:financial-updated"))';

describe("Transactions reloads once per write", () => {
  it("reloads through each write's own callback, not the shared event as well", () => {
    expect(page).not.toMatch(/addEventListener\(\s*"localfi:financial-updated"/);
    expect(page.match(/onSuccess=\{loadData\}/g)).toHaveLength(3);
    expect(page).toMatch(/onConfirmed=\{async \(\) => \{[^}]*await loadData\(\);/);
    expect(page).toMatch(/await deleteTransaction\(transactionToDelete\)[\s\S]*?await loadData\(\);/);
    expect(page).toMatch(/addEventListener\("focus", refresh\)/);
  });

  it("still tells the sidebar about every write", () => {
    expect(page).toContain(DISPATCH);
    for (const file of [
      "components/transactions/transaction-dialog.tsx",
      "components/transactions/transfer-dialog.tsx",
      "components/transactions/confirm-pending-transaction.tsx",
    ]) {
      expect(read(file)).toContain(DISPATCH);
    }
    expect(read("components/shared/sidebar.tsx")).toMatch(/addEventListener\("localfi:financial-updated"/);
  });
});
