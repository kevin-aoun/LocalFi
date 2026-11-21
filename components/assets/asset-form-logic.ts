import {
  GRAMS_PER_TROY_OUNCE,
  PRICED_HOLDINGS,
  commodityPriceSymbols,
  cryptoPriceSymbols,
  priceSymbolForCommodityType,
  stockPriceSymbol,
  pricedHolding,
  type PriceSymbol,
} from "@/lib/prices";
import { todayKey } from "@/lib/dates";
import { purchaseAmountCents, unitPriceFromAmountCents } from "@/lib/investments/cost";
import { parseAmount, sumCents } from "@/lib/money";

export type AssetFormData = {
  category: string;
  currentValue: string;
  currency: string;
  notes: string;
  commodityType: string;
  cryptoSymbol: PriceSymbol;
  quantityOz: string;
  quantityGrams: string;
  quantityCoins: string;
  unitPrice: string;
  ticker: string;
  fees: string;
  purchaseDate: string;
  useLivePrice: boolean;
};

export type AssetFormAsset = {
  category: string;
  currentValueCents: number;
  currency: string;
  notes?: string | null;
  commodityType?: string | null;
  quantity?: number | null;
  quantityExact?: string | null;
  unit?: string | null;
  priceSymbol?: string | null;
  costBasisCents?: number | null;
  useLivePrice?: boolean;
};

export const ASSET_TYPES = [
  "Savings",
  "Investments",
  "Crypto",
  "Properties",
  "Vehicles",
  "Commodities",
  "Other",
];
export const DEFAULT_ASSET_TYPE = "Savings";
export const COMMODITY_CHOICES = commodityPriceSymbols.map(
  (symbol) => PRICED_HOLDINGS[symbol].label,
);
export const CRYPTO_CHOICES = cryptoPriceSymbols.map((symbol) => ({
  symbol,
  label: PRICED_HOLDINGS[symbol].label,
}));

export function purchaseCategoryIdFor(
  categories: readonly { id: number; name: string; type: string }[],
  assetCategory: string,
  preferredId: number | null = null,
): number | null {
  const investments = categories.filter((category) => category.type === "Investment");
  const preferred = investments.find((category) => category.id === preferredId);
  const matching = investments.find((category) => category.name.trim().toLowerCase() === assetCategory.toLowerCase());
  const general = investments.find((category) => ["investment", "investments"].includes(category.name.trim().toLowerCase()));
  return (preferred ?? matching ?? general ?? investments[0])?.id ?? null;
}

export function emptyAssetForm(): AssetFormData {
  return {
    category: DEFAULT_ASSET_TYPE,
    currentValue: "",
    currency: "USD",
    notes: "",
    commodityType: "Gold",
    cryptoSymbol: "BTC",
    quantityOz: "",
    quantityGrams: "",
    quantityCoins: "",
    unitPrice: "",
    ticker: "",
    fees: "0",
    purchaseDate: todayKey(),
    useLivePrice: false,
  };
}

export function cryptoPurchaseForm(): AssetFormData {
  return {
    ...emptyAssetForm(),
    category: "Crypto",
    currency: "USD",
    useLivePrice: true,
  };
}
export function gramsToOz(grams: number): number {
  return grams / GRAMS_PER_TROY_OUNCE;
}

export function ozToGrams(oz: number): number {
  return oz * GRAMS_PER_TROY_OUNCE;
}

export function commodityQuantityFields(value: string, unit: "oz" | "grams") {
  const quantity = Number(value.trim());
  const converted = value.trim() === "" || !Number.isFinite(quantity)
    ? ""
    : String(unit === "oz" ? ozToGrams(quantity) : gramsToOz(quantity));
  return unit === "oz"
    ? { quantityOz: value, quantityGrams: converted }
    : { quantityOz: converted, quantityGrams: value };
}

export function formFromAsset(asset: AssetFormAsset, centsToDecimal: (cents: number) => number): AssetFormData {
  const hasQuantity = asset.quantity !== null && asset.quantity !== undefined;
  const quantity = hasQuantity ? asset.quantity! : 0;
  const weights = commodityQuantityFields(hasQuantity ? String(quantity) : "", asset.unit === "grams" ? "grams" : "oz");
  const storedCrypto = cryptoPriceSymbols.find((symbol) => symbol === asset.priceSymbol);
  const useLivePrice = asset.useLivePrice || false;

  return {
    category: asset.category,
    currentValue: centsToDecimal(asset.currentValueCents).toString(),

    currency: useLivePrice ? "USD" : asset.currency,
    notes: asset.notes || "",
    commodityType: asset.commodityType || "Gold",
    cryptoSymbol: storedCrypto ?? "BTC",
    ...weights,
    quantityCoins: asset.quantityExact ?? (hasQuantity ? String(quantity) : ""),
    unitPrice: hasQuantity && quantity > 0 && (asset.costBasisCents ?? asset.currentValueCents) > 0
      ? unitPriceFromAmountCents(asset.costBasisCents ?? asset.currentValueCents, asset.quantityExact ?? String(quantity))
      : "",
    ticker: asset.priceSymbol?.startsWith("STOCK:") ? pricedHolding(asset.priceSymbol)?.label ?? "" : "",
    fees: "0",
    purchaseDate: todayKey(),
    useLivePrice,
  };
}

export function purchaseTotalFor(form: AssetFormData): number | null {
  try {
    const fees = parseAmount(form.fees.trim() || "0");
    if (fees < 0) return null;
    return sumCents([purchaseAmountCents(form.quantityCoins, form.unitPrice), fees]);
  } catch {
    return null;
  }
}

export function livePricingFor(form: AssetFormData) {
  const isCommodity = form.category === "Commodities";
  const isCrypto = form.category === "Crypto";
  const isStock = form.category === "Investments";
  const isInvestment = isCrypto || isStock;
  const supportsLivePrice = isCommodity || isInvestment;
  const liveSymbol: PriceSymbol | null = !supportsLivePrice
    ? null
    : isStock
      ? stockPriceSymbol(form.ticker)
      : isCrypto
      ? form.cryptoSymbol
      : priceSymbolForCommodityType(form.commodityType);
  const usesLivePricing = isInvestment || (isCommodity && form.useLivePrice);
  return {
    isCommodity,
    isCrypto,
    isStock,
    isInvestment,
    liveSymbol,
    usesLivePricing,
    liveUnit: isStock ? "shares" : isCrypto ? "coins" : "oz",
    liveQuantityText: isInvestment ? form.quantityCoins : form.quantityOz,
  } as const;
}
