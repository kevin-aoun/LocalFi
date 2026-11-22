import type { Database } from "sql.js";
import { pricedHolding } from "@/lib/prices";

export const INVESTMENT_KINDS = ["stock", "crypto", "commodity"] as const;
export type InvestmentKind = (typeof INVESTMENT_KINDS)[number];

/**
 * Stock, crypto and commodity categories hold trades with units and a price.
 * A bare amount there would create a row the trade form cannot reopen.
 */
export function assertAmountOnlyCategory(category: { name: string; investmentKind?: string | null } | undefined): void {
  if (category?.investmentKind) {
    throw new Error(`${category.name} records units and a price. Enter it as a trade in Transactions.`);
  }
}

export function investmentKindForSymbol(symbol: string): InvestmentKind | null {
  const category = pricedHolding(symbol)?.assetCategory;
  return category === "Investments" ? "stock" : category === "Crypto" ? "crypto" : category === "Commodities" ? "commodity" : null;
}

// Only migration uses names; subsequent renames preserve the configured form.
export function initializeAssetCategories(raw: Database): void {
  const defaults = [
    { kind: "stock", name: "Stock", aliases: ["stock", "stocks", "investment", "investments", "etf", "etfs"], icon: "TrendingUp", color: "#10b981" },
    { kind: "crypto", name: "Crypto", aliases: ["crypto", "cryptocurrency", "cryptocurrencies"], icon: "Coins", color: "#8b5cf6" },
    { kind: "commodity", name: "Commodities", aliases: ["commodity", "commodities", "gold", "metals"], icon: "Coins", color: "#f59e0b" },
  ];
  for (const item of defaults) {
    for (const alias of item.aliases) {
      raw.run("UPDATE categories SET investment_kind = ? WHERE type = 'Investment' AND investment_kind IS NULL AND lower(trim(name)) = ?", [item.kind, alias]);
    }
    const statement = raw.prepare("SELECT 1 FROM categories WHERE investment_kind = ? LIMIT 1");
    statement.bind([item.kind]);
    const exists = statement.step();
    statement.free();
    if (exists) continue;
    raw.run(`INSERT INTO categories (name, type, investment_kind, icon, color, display_order)
      SELECT ?, 'Investment', ?, ?, ?, COALESCE(MAX(display_order), -1) + 1 FROM categories WHERE true
      ON CONFLICT(name) DO NOTHING`, [item.name, item.kind, item.icon, item.color]);
  }
}
