import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCategory, updateCategory, getCategories } from "@/app/actions/categories";
import { createTransaction, updateTransaction } from "@/app/actions/transactions";
import { createRecurringTransaction } from "@/app/actions/recurring";
import { createDomainDb, execOn, form, seedAccount, seedCategory, seedTransaction, type DomainDb } from "./support/domain-fixture";

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

describe("amount-only entries stay out of trade categories", () => {
  beforeEach(() => {
    seedCategory(temp, { id: 21, name: "Groceries", type: "Expense" });
    seedCategory(temp, { id: 22, name: "Demo stock", type: "Investment" });
    execOn(temp, (db) => db.run("UPDATE categories SET investment_kind = 'stock' WHERE id = 22"));
  });

  it("refuses to move a plain transaction into a stock category but keeps legacy rows editable", async () => {
    seedTransaction(temp, { id: 1, categoryId: 21, accountId: 9, amountCents: 1_000, dateKey: "2026-01-02", pending: true });
    expect(await updateTransaction(1, form({ categoryId: "22", amount: "10" }))).toMatchObject({ error: expect.stringMatching(/records units and a price/) });
    seedTransaction(temp, { id: 2, categoryId: 22, accountId: 9, amountCents: 500, dateKey: "2026-01-03", pending: true });
    expect(await updateTransaction(2, form({ categoryId: "22", comment: "Monthly contribution" }))).toMatchObject({ success: true });
  });

  it("refuses recurring templates that would generate amount-only trades", async () => {
    const template = form({ name: "Broker", frequency: "monthly", interval: "1", startDate: "2026-01-01", amount: "100", accountId: "9", categoryId: "22" });
    expect(await createRecurringTransaction(template)).toMatchObject({ error: expect.stringMatching(/records units and a price/) });
    expect(await createRecurringTransaction(form({ ...Object.fromEntries(template), categoryId: "21" }))).toMatchObject({ success: true });
  });
});
