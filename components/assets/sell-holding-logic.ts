import { toDateKey } from "@/lib/dates";
import { investmentKindForSymbol, type InvestmentKind } from "@/lib/investments/categories";
import { tryParseAmount } from "@/lib/money";
import { pricedHolding } from "@/lib/prices";
import { toTransactionFormData, transactionCashAmount } from "@/components/transactions/transaction-form-logic";

/**
 * A holding the Sell dialog can sell. Priced holdings sell units at a price
 * through the ordinary trade form; manual holdings (property, vehicles, other)
 * sell in full for their proceeds.
 */
export type SaleTarget =
  | {
      kind: "priced";
      label: string;
      symbol: string;
      unit: string;
      quantity: string;
      currency: string;
      investmentKind: InvestmentKind;
    }
  | { kind: "manual"; assetId: number; label: string; currency: string };

export type SaleHolding = {
  id: number;
  category: string;
  currency: string;
  priceSymbol?: string | null;
  quantityExact?: string | null;
  instrumentId?: string | null;
};

export type SaleCategory = { id: number; name: string; type: string; investmentKind?: InvestmentKind | null };
export type SaleAccount = { id: number; name: string; currency: string; kind?: string; archived?: boolean };

export type SaleForm = {
  accountId: string;
  categoryId: string;
  date: Date;
  quantity: string;
  unitPrice: string;
  fees: string;
  amount: string;
};

export type SaleRequest =
  | { action: "trade"; formData: FormData }
  | { action: "manual"; assetId: number; formData: FormData };

export function pricedSaleTarget(symbol: string, quantity: string, currency: string, label: string): SaleTarget | null {
  const investmentKind = investmentKindForSymbol(symbol);
  const unit = pricedHolding(symbol)?.defaultUnit;
  if (!investmentKind || !unit || quantity === "0" || quantity.startsWith("-")) return null;
  return { kind: "priced", label, symbol, unit, quantity, currency, investmentKind };
}

/** Classifies a ledger-backed holding; cash, legacy rows and empty positions cannot be sold. */
export function saleTargetFor(holding: SaleHolding, label: string): SaleTarget | null {
  const quantity = holding.quantityExact;
  if (holding.category === "Cash" || !holding.instrumentId || !quantity || quantity === "0") return null;
  if (holding.priceSymbol) return pricedSaleTarget(holding.priceSymbol, quantity, holding.currency, label);
  return { kind: "manual", assetId: holding.id, label, currency: holding.currency };
}

// Priced sales need the category configured for their asset type; manual sales need a plain one.
export function saleCategories<T extends SaleCategory>(categories: readonly T[], target: SaleTarget): T[] {
  return categories.filter((category) => category.type === "Investment" && (target.kind === "priced"
    ? category.investmentKind === target.investmentKind
    : !category.investmentKind));
}

export function saleAccounts<T extends SaleAccount>(accounts: readonly T[], target: SaleTarget): T[] {
  return accounts.filter((account) => !account.archived && account.kind === "asset" && account.currency === target.currency);
}

export function initialSaleForm(
  target: SaleTarget,
  categories: readonly SaleCategory[],
  accounts: readonly SaleAccount[],
  date = new Date(),
): SaleForm {
  return {
    accountId: String(saleAccounts(accounts, target)[0]?.id ?? ""),
    categoryId: String(saleCategories(categories, target)[0]?.id ?? ""),
    date,
    quantity: target.kind === "priced" ? target.quantity : "",
    unitPrice: "",
    fees: "0",
    amount: "",
  };
}

/** The cash the sale will deposit, as a decimal string, or "" while the inputs are incomplete. */
export function saleProceeds(target: SaleTarget, form: SaleForm): string {
  if (target.kind === "manual") return form.amount;
  return transactionCashAmount({ amount: "", instrumentSymbol: target.symbol, quantity: form.quantity, unitPrice: form.unitPrice, fees: form.fees, investmentSide: "sell" });
}

/** Validates the form and builds the request for the matching server action. Throws a user-facing message. */
export function buildSaleRequest(target: SaleTarget, form: SaleForm): SaleRequest {
  if (form.accountId === "") throw new Error(`Choose a ${target.currency} account to receive the proceeds.`);
  if (form.categoryId === "") throw new Error("Choose an Investment category for this sale.");
  if (Number.isNaN(form.date.getTime())) throw new Error("Choose a valid date.");
  if (target.kind === "priced") {
    return {
      action: "trade",
      formData: toTransactionFormData({
        categoryId: form.categoryId,
        accountId: form.accountId,
        amount: "",
        comment: `Sell ${target.label}`,
        date: form.date,
        pending: false,
        instrumentSymbol: target.symbol,
        instrumentUnit: target.unit,
        quantity: form.quantity,
        unitPrice: form.unitPrice,
        fees: form.fees,
        investmentSide: "sell",
      }),
    };
  }
  const proceeds = tryParseAmount(form.amount);
  if (proceeds === null) throw new Error("Enter the sale proceeds.");
  if (proceeds < 0) throw new Error("Sale proceeds cannot be negative.");
  const formData = new FormData();
  formData.set("accountId", form.accountId);
  formData.set("categoryId", form.categoryId);
  formData.set("amount", form.amount.trim());
  formData.set("date", toDateKey(form.date));
  formData.set("comment", `Sold ${target.label}`);
  return { action: "manual", assetId: target.assetId, formData };
}
