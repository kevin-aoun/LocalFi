"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { pricedHolding, PRICE_SYMBOLS } from "@/lib/prices";
import { investmentKindForSymbol, type InvestmentKind } from "@/lib/investments/categories";
import type { InvestmentSide } from "@/lib/investments/trades";

export type InvestmentForm = {
  instrumentSymbol: string;
  quantity: string;
  unitPrice: string;
  instrumentUnit: string;
  fees: string;
  investmentSide: InvestmentSide;
};

export function emptyInvestment(kind: InvestmentKind | null = null): InvestmentForm {
  const instrumentSymbol = kind === "crypto" ? "BTC" : kind === "commodity" ? "XAU" : "";
  return { instrumentSymbol, quantity: "", unitPrice: "", instrumentUnit: pricedHolding(instrumentSymbol)?.defaultUnit ?? "", fees: "0", investmentSide: "buy" };
}

export function InvestmentFields({ kind, value, onChange }: {
  kind: InvestmentKind;
  value: InvestmentForm;
  onChange: (value: InvestmentForm) => void;
}) {
  const set = (patch: Partial<InvestmentForm>) => onChange({ ...value, ...patch });
  const quantityLabel = kind === "stock" ? "Shares" : kind === "crypto" ? "Coins" : "Troy ounces";
  return (
    <div className="space-y-4" data-private-value>
      <div className="space-y-2">
        <Label htmlFor="investment-side">Action</Label>
        <Select value={value.investmentSide} onValueChange={(side) => set({ investmentSide: side as InvestmentSide })}>
          <SelectTrigger id="investment-side"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="buy">Buy</SelectItem><SelectItem value="sell">Sell</SelectItem></SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="instrument-symbol">{kind === "stock" ? "Ticker" : kind === "crypto" ? "Coin" : "Metal"}</Label>
        {kind === "stock" ? (
          <Input id="instrument-symbol" value={value.instrumentSymbol.replace(/^STOCK:/, "")} placeholder="e.g. CSPX, AAPL"
            onChange={(event) => set({ instrumentSymbol: event.target.value.trim() ? `STOCK:${event.target.value.toUpperCase()}` : "", instrumentUnit: "shares" })} required />
        ) : (
          <Select value={value.instrumentSymbol} onValueChange={(symbol) => set({ instrumentSymbol: symbol, instrumentUnit: pricedHolding(symbol)?.defaultUnit ?? "" })} required>
            <SelectTrigger id="instrument-symbol"><SelectValue placeholder="Select instrument" /></SelectTrigger>
            <SelectContent>{PRICE_SYMBOLS.filter((symbol) => investmentKindForSymbol(symbol) === kind).map((symbol) => (
              <SelectItem key={symbol} value={symbol}>{symbol} · {pricedHolding(symbol)?.label}</SelectItem>
            ))}</SelectContent>
          </Select>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="investment-quantity">{quantityLabel}</Label>
          <Input id="investment-quantity" inputMode="decimal" data-private-input value={value.quantity} placeholder="0.000001" onChange={(event) => set({ quantity: event.target.value })} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="investment-unit-price">Price (USD){kind === "commodity" ? " / oz" : ""}</Label>
          <Input id="investment-unit-price" type="number" min="0.0001" step="0.0001" value={value.unitPrice} placeholder="0.0000" onChange={(event) => set({ unitPrice: event.target.value })} required />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="investment-fees">Fees (USD)</Label>
        <Input id="investment-fees" type="number" min="0" step="0.01" value={value.fees} onChange={(event) => set({ fees: event.target.value })} />
      </div>
    </div>
  );
}
