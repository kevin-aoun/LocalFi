import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCategory, updateCategory, getCategories } from "@/app/actions/categories";
import { createTransaction } from "@/app/actions/transactions";
import { createDomainDb, form, seedAccount, type DomainDb } from "./support/domain-fixture";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let temp: DomainDb;
beforeEach(async () => {
  temp = await createDomainDb();
  seedAccount(temp, { id: 9, name: "Demo cash", kind: "asset", type: "Checking", openingBalanceCents: 100_000, openingBalanceDate: "2026-01-01" });
});
afterEach(async () => { await temp.cleanup(); });
const categoryForm = (extra = {}) => form({ name: "Demo Stock", type: "Investment", investmentKind: "stock", icon: "Wallet", color: "#000000", ...extra });

describe("category-defined transaction fields", () => {
  it("preserves stock fields through a category rename and rejects crypto under that category", async () => {
    const created = await createCategory(categoryForm());
    if ("error" in created) throw new Error(created.error);
    expect(await updateCategory(created.data.id, categoryForm({ name: "Long term portfolio" }))).toMatchObject({ success: true, data: { investmentKind: "stock" } });
    expect((await getCategories()).find((row) => row.id === created.data.id)).toMatchObject({ name: "Long term portfolio", investmentKind: "stock" });
    const fields = { categoryId: String(created.data.id), accountId: "9", instrumentSymbol: "BTC", instrumentUnit: "coins", quantity: "0.1", unitPrice: "100", fees: "0", date: "2026-01-02" };
    expect(await createTransaction(form(fields))).toHaveProperty("error");
    expect(await createTransaction(form({ ...fields, instrumentSymbol: "STOCK:AAPL", instrumentUnit: "shares" }))).toMatchObject({ success: true });
    expect(await createTransaction(form({ categoryId: String(created.data.id), accountId: "9", amount: "10" }))).toHaveProperty("error");
  });
  it("rejects invalid field configurations and clears them when changing to Expense", async () => {
    expect(await createCategory(categoryForm({ investmentKind: "nope" }))).toHaveProperty("error");
    const created = await createCategory(categoryForm());
    if ("error" in created) throw new Error(created.error);
    expect(await updateCategory(created.data.id, categoryForm({ type: "Expense" }))).toMatchObject({ success: true, data: { investmentKind: null } });
  });
});
