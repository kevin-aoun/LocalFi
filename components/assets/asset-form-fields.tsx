"use client";

import type { Dispatch, SetStateAction } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ASSET_TYPES,
  COMMODITY_CHOICES,
  CRYPTO_CHOICES,
  purchaseTotalFor,
  type AssetFormData,
} from "./asset-form-logic";
import { formatMoney } from "@/lib/money";

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
        useLivePrice: category === "Crypto" || category === "Investments" ? true : prev.useLivePrice,
        currency: category === "Crypto" || category === "Investments" ? "USD" : prev.currency,
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
        {usesLivePricing && <p className="text-xs text-muted-foreground">Amounts are recorded in USD.</p>}
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

export function InvestmentFields({ formData, setFormData, editing = false }: FormProps & { editing?: boolean }) {
  const isStock = formData.category === "Investments";
  const purchaseTotal = editing ? null : purchaseTotalFor(formData);
  return (
    <>
      {isStock ? (
        <div className="space-y-2">
          <Label htmlFor="ticker">Stock / ETF ticker</Label>
          <Input id="ticker" value={formData.ticker} maxLength={20} autoCapitalize="characters" autoComplete="off" spellCheck={false} onChange={(e) => setFormData((prev) => ({ ...prev, ticker: e.target.value.toUpperCase() }))} placeholder="AAPL, CSPX…" required />
        </div>
      ) : (
        <div className="space-y-2"><Label htmlFor="cryptoSymbol">Coin</Label><Select value={formData.cryptoSymbol} onValueChange={(value) => setFormData((prev) => ({ ...prev, cryptoSymbol: value as AssetFormData["cryptoSymbol"] }))}><SelectTrigger id="cryptoSymbol"><SelectValue /></SelectTrigger><SelectContent>{CRYPTO_CHOICES.map((choice) => <SelectItem key={choice.symbol} value={choice.symbol}>{choice.label} ({choice.symbol})</SelectItem>)}</SelectContent></Select></div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="quantityCoins">{isStock ? "Shares" : "Coins"}</Label>
          <Input id="quantityCoins" inputMode="decimal" value={formData.quantityCoins} onChange={(e) => setFormData((prev) => ({ ...prev, quantityCoins: e.target.value }))} placeholder="0.00000000" required />
          <p className="text-xs text-muted-foreground">Enter the exact quantity received, including fractions.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="unitPrice">Price (USD)</Label>
          <Input id="unitPrice" type="number" step="0.0001" min="0.0001" value={formData.unitPrice} onChange={(e) => setFormData((prev) => ({ ...prev, unitPrice: e.target.value }))} placeholder="0.0000" required={!editing} />
          <p className="text-xs text-muted-foreground">{editing ? "Average price per unit, including recorded fees." : `Price per ${isStock ? "share" : "coin"} at purchase, before fees. Up to four decimal places.`}</p>
        </div>
      </div>
      {!editing && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="purchaseFees">Fees (USD)</Label>
            <Input id="purchaseFees" type="number" step="0.01" min="0" value={formData.fees} onChange={(e) => setFormData((prev) => ({ ...prev, fees: e.target.value }))} placeholder="0.00" />
            <p className="text-xs text-muted-foreground">Included in cash spent and break-even.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="purchaseDate">Purchase date</Label>
            <DatePicker id="purchaseDate" value={formData.purchaseDate} onChange={(date) => {
              if (date) setFormData((prev) => ({ ...prev, purchaseDate: date }));
            }} className="w-full" />
          </div>
        </div>
      )}
      {!editing && purchaseTotal !== null && (
        <div className="flex items-center justify-between gap-3 text-sm" aria-live="polite">
          <span className="text-muted-foreground">Cash paid, including fees</span>
          <strong className="tabular-nums" data-private-value>{formatMoney(purchaseTotal, "USD")}</strong>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Market prices update automatically in Assets and Reports.</p>
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
        <div className="space-y-2"><Label htmlFor="quantityOz">Ounces (oz)</Label><Input id="quantityOz" type="number" step="any" min="0" value={formData.quantityOz} onChange={(e) => onOzChange(e.target.value)} placeholder="0.0000" required /></div>
        <div className="space-y-2"><Label htmlFor="quantityGrams">Grams (g)</Label><Input id="quantityGrams" type="number" step="any" min="0" value={formData.quantityGrams} onChange={(e) => onGramsChange(e.target.value)} placeholder="0.00" /></div>
      </div>
    </>
  );
}
