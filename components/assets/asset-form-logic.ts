import {
  GRAMS_PER_TROY_OUNCE,
  PRICED_HOLDINGS,
  commodityPriceSymbols,
  cryptoPriceSymbols,
  priceSymbolForCommodityType,
  type PriceSymbol,
} from "@/lib/prices";

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
  paidAmount: string;
  useLivePrice: boolean;
};

export type AssetFormAsset = {
  category: string;
  currentValueCents: number;
  currency: string;
  notes?: string | null;
  commodityType?: string | null;
  quantity?: number | null;
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
    paidAmount: "",
    useLivePrice: false,
  };
}
export function gramsToOz(grams: number): number {
  return grams / GRAMS_PER_TROY_OUNCE;
}

export function ozToGrams(oz: number): number {
  return oz * GRAMS_PER_TROY_OUNCE;
}

export function formFromAsset(asset: AssetFormAsset, centsToDecimal: (cents: number) => number): AssetFormData {
  const hasQuantity = asset.quantity !== null && asset.quantity !== undefined;
  const quantity = hasQuantity ? asset.quantity! : 0;
  const quantityOz = asset.unit === "grams" ? gramsToOz(quantity).toFixed(4) : String(quantity);
  const quantityGrams = asset.unit === "grams" ? String(quantity) : ozToGrams(quantity).toFixed(2);
  const storedCrypto = cryptoPriceSymbols.find((symbol) => symbol === asset.priceSymbol);
  const useLivePrice = asset.useLivePrice || false;

  return {
    category: asset.category,
    currentValue: centsToDecimal(asset.currentValueCents).toString(),

    currency: useLivePrice ? "USD" : asset.currency,
    notes: asset.notes || "",
    commodityType: asset.commodityType || "Gold",
    cryptoSymbol: storedCrypto ?? "BTC",
    quantityOz: hasQuantity ? quantityOz : "",
    quantityGrams: hasQuantity ? quantityGrams : "",
    quantityCoins: hasQuantity ? String(quantity) : "",
    paidAmount: asset.costBasisCents == null ? "" : centsToDecimal(asset.costBasisCents).toString(),
    useLivePrice,
  };
}

export function livePricingFor(form: AssetFormData) {
  const isCommodity = form.category === "Commodities";
  const isCrypto = form.category === "Crypto";
  const supportsLivePrice = isCommodity || isCrypto;
  const liveSymbol: PriceSymbol | null = !supportsLivePrice
    ? null
    : isCrypto
      ? form.cryptoSymbol
      : priceSymbolForCommodityType(form.commodityType);
  const usesLivePricing = form.useLivePrice && liveSymbol !== null;
  return {
    isCommodity,
    isCrypto,
    liveSymbol,
    usesLivePricing,
    liveUnit: isCrypto ? "coins" : "oz",
    liveQuantityText: isCrypto ? form.quantityCoins : form.quantityOz,
  } as const;
}
