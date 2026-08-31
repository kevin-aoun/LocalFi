"use client";

import type { Dispatch, SetStateAction } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ASSET_TYPES,
  COMMODITY_CHOICES,
  CRYPTO_CHOICES,
  type AssetFormData,
} from "./asset-form-logic";

type FormProps = {
  formData: AssetFormData;
  setFormData: Dispatch<SetStateAction<AssetFormData>>;
};

export function AssetCategoryField({ formData, setFormData }: FormProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="category">Category</Label>
      <Select value={formData.category} onValueChange={(category) => setFormData((prev) => ({
        ...prev,
        category,
        useLivePrice: category === "Crypto" ? true : prev.useLivePrice,
        currency: category === "Crypto" ? "USD" : prev.currency,
      }))} required>
        <SelectTrigger id="category"><SelectValue /></SelectTrigger>
        <SelectContent>{ASSET_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}
export function AssetValueFields({ formData, setFormData, usesLivePricing }: FormProps & { usesLivePricing: boolean }) {
  return (
    <>
      {!usesLivePricing && (
        <div className="space-y-2">
          <Label htmlFor="currentValue">Current Value</Label>
          <Input id="currentValue" type="number" step="0.01" min="0" value={formData.currentValue} onChange={(e) => setFormData((prev) => ({ ...prev, currentValue: e.target.value }))} placeholder="0.00" required />
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="currency">Currency</Label>
        <Input id="currency" value={usesLivePricing ? "USD" : formData.currency} disabled={usesLivePricing} onChange={(e) => setFormData((prev) => ({ ...prev, currency: e.target.value.toUpperCase() }))} placeholder="USD" required />
        {usesLivePricing && <p className="text-xs text-muted-foreground">Live provider quotes are stored and displayed in USD.</p>}
      </div>
    </>
  );
}

function LivePriceCheckbox({ formData, setFormData }: FormProps) {
  return (
    <Label className="flex items-center gap-2">
      <Checkbox id="useLivePrice" checked={formData.useLivePrice} onCheckedChange={(checked) => setFormData((prev) => ({ ...prev, useLivePrice: checked === true, currency: checked === true ? "USD" : prev.currency }))} />
      <span className="cursor-pointer text-sm font-normal">Live Price</span>
    </Label>
  );
}

export function CryptoFields({ formData, setFormData }: FormProps) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="cryptoSymbol">Coin</Label><Select value={formData.cryptoSymbol} onValueChange={(value) => setFormData((prev) => ({ ...prev, cryptoSymbol: value as AssetFormData["cryptoSymbol"] }))}><SelectTrigger id="cryptoSymbol"><SelectValue /></SelectTrigger><SelectContent>{CRYPTO_CHOICES.map((choice) => <SelectItem key={choice.symbol} value={choice.symbol}>{choice.label} ({choice.symbol})</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label>Pricing</Label><LivePriceCheckbox formData={formData} setFormData={setFormData} /></div>
      </div>
      {formData.useLivePrice && <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="quantityCoins">Quantity (coins)</Label><Input id="quantityCoins" type="number" step="0.00000001" min="0" value={formData.quantityCoins} onChange={(e) => setFormData((prev) => ({ ...prev, quantityCoins: e.target.value }))} placeholder="0.00000000" required /><p className="text-xs text-muted-foreground">Fractions are exact: 0.0345 means 0.0345 {formData.cryptoSymbol}.</p></div><div className="space-y-2"><Label htmlFor="paidAmount">Paid (USD)</Label><Input id="paidAmount" type="number" step="0.01" min="0" value={formData.paidAmount} onChange={(e) => setFormData((prev) => ({ ...prev, paidAmount: e.target.value }))} placeholder="0.00" required /><p className="text-xs text-muted-foreground">Your cost basis. It is used for live profit or loss.</p></div></div>}
    </>
  );
}

export function CommodityFields({ formData, setFormData, onOzChange, onGramsChange }: FormProps & { onOzChange: (value: string) => void; onGramsChange: (value: string) => void }) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="commodityType">Type</Label><Select value={formData.commodityType} onValueChange={(commodityType) => setFormData((prev) => ({ ...prev, commodityType }))} required><SelectTrigger id="commodityType"><SelectValue /></SelectTrigger><SelectContent>{COMMODITY_CHOICES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label>Pricing</Label><LivePriceCheckbox formData={formData} setFormData={setFormData} /></div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="quantityOz">Ounces (oz)</Label><Input id="quantityOz" type="number" step="0.0001" min="0" value={formData.quantityOz} onChange={(e) => onOzChange(e.target.value)} placeholder="0.0000" required /></div>
        <div className="space-y-2"><Label htmlFor="quantityGrams">Grams (g)</Label><Input id="quantityGrams" type="number" step="0.01" min="0" value={formData.quantityGrams} onChange={(e) => onGramsChange(e.target.value)} placeholder="0.00" /></div>
      </div>
    </>
  );
}
