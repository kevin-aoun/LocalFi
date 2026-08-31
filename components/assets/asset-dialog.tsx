"use client";

import { useState, useEffect, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createAsset, updateAsset } from "@/app/actions/assets";
import { createTransaction } from "@/app/actions/transactions";
import {
  createLivePricedAsset,
  getLivePriceQuote,
  updateLivePricedAsset,
} from "@/app/actions/crypto";
import { AlertCircle, Loader2, TrendingUp } from "lucide-react";
import { todayKey } from "@/lib/dates";
import { centsToDecimal, formatMoney, negateCents, sumCents, tryParseAmount, type Cents } from "@/lib/money";
import {
  describePriceError,
  holdingValueCents,
  type PriceQuote,
} from "@/lib/prices";
import {
  cryptoPurchaseForm,
  emptyAssetForm,
  formFromAsset,
  gramsToOz,
  livePricingFor,
  ozToGrams,
  type AssetFormData,
} from "./asset-form-logic";
import {
  AssetCategoryField,
  AssetValueFields,
  CommodityFields,
  CryptoFields,
} from "./asset-form-fields";

type Asset = {
  id: number;
  category: string;

  currentValueCents: Cents;
  currency: string;
  notes?: string | null;
  commodityType?: string | null;
  quantity?: number | null;
  unit?: string | null;

  priceSymbol?: string | null;

  pricedAt?: Date | number | string | null;
  useLivePrice?: boolean;
  costBasisCents?: Cents | null;
};

type AssetDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset?: Asset | null;
  accounts?: Array<{ id: number; name: string; currency: string; kind?: string; archived?: boolean }>;
  categories?: Array<{ id: number; name: string; type: string }>;
  cryptoPurchase?: boolean;
  initialPurchaseAccountId?: number | null;
  initialPurchaseCategoryId?: number | null;
  onSuccess: () => void;
};

function pricedAtLabel(pricedAt: Asset["pricedAt"]): string | null {
  if (pricedAt === null || pricedAt === undefined) return null;
  const date = pricedAt instanceof Date ? pricedAt : new Date(pricedAt);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

export function AssetDialog({
  open,
  onOpenChange,
  asset,
  accounts = [],
  categories = [],
  cryptoPurchase = false,
  initialPurchaseAccountId = null,
  initialPurchaseCategoryId = null,
  onSuccess,
}: AssetDialogProps) {
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const [quote, setQuote] = useState<PriceQuote | null>(null);

  const [priceError, setPriceError] = useState<string | null>(null);
  const [formData, setFormData] = useState<AssetFormData>(emptyAssetForm);
  const [purchaseAccountId, setPurchaseAccountId] = useState("");
  const [purchaseCategoryId, setPurchaseCategoryId] = useState("");

  const { isCommodity, isCrypto, liveSymbol, usesLivePricing, liveUnit, liveQuantityText } = livePricingFor(formData);
  const liveQuantityGiven = liveQuantityText.trim() !== "";


  const computedValue =
    quote !== null && usesLivePricing && liveQuantityGiven
      ? holdingValueCents(quote, Number(liveQuantityText.trim()), liveUnit)
      : null;

  const storedPricedAt = pricedAtLabel(asset?.pricedAt);
  const purchaseAccounts = useMemo(
    () => accounts.filter((account) => account.archived !== true && account.kind !== "liability"),
    [accounts],
  );
  const purchaseCategories = useMemo(
    () => categories.filter((category) => category.type === "Investment"),
    [categories],
  );
  const defaultPurchaseAccountId = purchaseAccounts[0] ? String(purchaseAccounts[0].id) : "";
  const defaultPurchaseCategoryId = purchaseCategories[0] ? String(purchaseCategories[0].id) : "";
  const paidAmountCents = isCrypto ? tryParseAmount(formData.paidAmount) : null;
  const quoteUnitPriceCents = quote === null ? null : tryParseAmount(String(quote.pricePerUnitUsd));
  const profitLossCents =
    computedValue?.ok && paidAmountCents !== null
      ? sumCents([computedValue.valueCents, negateCents(paidAmountCents)])
      : null;




  useEffect(() => {
    if (!open || !usesLivePricing || liveSymbol === null) {
      setQuote(null);
      setPriceError(null);
      return;
    }

    let cancelled = false;
    setPriceError(null);
    getLivePriceQuote(liveSymbol).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setQuote(result.quote);
        setPriceError(null);
      } else {

        setQuote(null);
        setPriceError(describePriceError(result.error));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, usesLivePricing, liveSymbol]);

  useEffect(() => {
    setError(null);
    if (asset) {


      setFormData(formFromAsset(asset, centsToDecimal));
    } else {
      setFormData(cryptoPurchase ? cryptoPurchaseForm() : emptyAssetForm());
      setPurchaseAccountId(initialPurchaseAccountId == null ? defaultPurchaseAccountId : String(initialPurchaseAccountId));
      setPurchaseCategoryId(initialPurchaseCategoryId == null ? defaultPurchaseCategoryId : String(initialPurchaseCategoryId));
    }
  }, [
    asset,
    cryptoPurchase,
    defaultPurchaseAccountId,
    defaultPurchaseCategoryId,
    initialPurchaseAccountId,
    initialPurchaseCategoryId,
    open,
  ]);



  const handleOzChange = (value: string) => {
    const oz = Number(value.trim());
    setFormData((prev) => ({
      ...prev,
      quantityOz: value,
      quantityGrams:
        value.trim() === "" || !Number.isFinite(oz) ? "" : ozToGrams(oz).toFixed(2),
    }));
  };

  const handleGramsChange = (value: string) => {
    const grams = Number(value.trim());
    setFormData((prev) => ({
      ...prev,
      quantityGrams: value,
      quantityOz:
        value.trim() === "" || !Number.isFinite(grams) ? "" : gramsToOz(grams).toFixed(4),
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      let result:
        | Awaited<ReturnType<typeof createAsset>>
        | Awaited<ReturnType<typeof createLivePricedAsset>>
        | Awaited<ReturnType<typeof createTransaction>>;

      if (usesLivePricing && liveSymbol !== null) {
        if (isCrypto && !asset) {
          if (quote === null || quoteUnitPriceCents === null) {
            setError("Wait for the live price before recording this purchase.");
            return;
          }
          if (purchaseAccountId === "" || purchaseCategoryId === "") {
            setError("Choose the account and investment category for this purchase.");
            return;
          }
          const purchase = new FormData();
          purchase.set("accountId", purchaseAccountId);
          purchase.set("categoryId", purchaseCategoryId);
          purchase.set("amount", formData.paidAmount);
          purchase.set("date", todayKey());
          purchase.set("comment", formData.notes.trim() || `Buy ${liveSymbol}`);
          purchase.set("pending", "false");
          purchase.set("instrumentSymbol", liveSymbol);
          purchase.set("quantity", liveQuantityText.trim());
          purchase.set("instrumentUnit", liveUnit);
          purchase.set("unitPrice", String(centsToDecimal(quoteUnitPriceCents)));
          result = await createTransaction(purchase);
        } else {



        const livePriceForm = new FormData();
        livePriceForm.append("priceSymbol", liveSymbol);


        if (liveQuantityGiven) {
          livePriceForm.append("quantity", liveQuantityText.trim());
        }
        if (isCrypto && formData.paidAmount.trim() !== "") {
          livePriceForm.append("paidAmount", formData.paidAmount.trim());
        }
        livePriceForm.append("unit", liveUnit);

        livePriceForm.append("currency", "USD");
        if (formData.notes) {
          livePriceForm.append("notes", formData.notes);
        }
        result = asset
          ? await updateLivePricedAsset(asset.id, livePriceForm)
          : await createLivePricedAsset(livePriceForm);
        }
      } else {
        const formDataObj = new FormData();
        formDataObj.append("category", formData.category);
        formDataObj.append("currentValue", formData.currentValue);
        formDataObj.append("currency", usesLivePricing ? "USD" : formData.currency);
        if (formData.notes) {
          formDataObj.append("notes", formData.notes);
        }


        if (isCommodity) {
          formDataObj.append("commodityType", formData.commodityType);

          if (formData.quantityOz.trim() !== "") {
            formDataObj.append("quantity", formData.quantityOz.trim());
          }
          formDataObj.append("unit", "oz");
          formDataObj.append("useLivePrice", formData.useLivePrice.toString());
        }

        result = asset
          ? await updateAsset(asset.id, formDataObj)
          : await createAsset(formDataObj);
      }




      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }

      onSuccess();
      window.dispatchEvent(new Event("localfi:financial-updated"));
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save asset:", err);
      setError(err instanceof Error ? err.message : "Failed to save asset.");
    } finally {
      setLoading(false);
    }
  };


  const livePricePanel = (
    <>
      {usesLivePricing && quote !== null && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-green-50 dark:bg-green-950 px-3 py-2">
          <TrendingUp className="h-3 w-3 text-green-600" />
          <span className="text-sm font-semibold text-green-700 dark:text-green-400" data-private-value>
            {}
            {formatMoney(tryParseAmount(quote.pricePerUnitUsd) ?? 0, "USD")} per {quote.priceUnit}
          </span>
          <span className="text-xs text-muted-foreground">
            {quote.label} · {quote.provider === "coingecko" ? "CoinGecko" : "SwissQuote"}
          </span>
        </div>
      )}

      {usesLivePricing && priceError !== null && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            <strong>Live price unavailable.</strong> {priceError}
            {asset && storedPricedAt !== null && (
              <>
                {" "}
                Until then this holding keeps its stored value of{" "}
                <strong data-private-value>{formatMoney(asset.currentValueCents, asset.currency)}</strong>, which is
                stale: it was last priced on {storedPricedAt}. Nothing has been overwritten.
              </>
            )}
          </span>
        </div>
      )}

      {usesLivePricing && quote !== null && computedValue !== null && (
        <div className="rounded-md bg-primary/10 px-3 py-2 border border-primary/20">
          <div className="text-xs text-muted-foreground">Total Value</div>
          {computedValue.ok ? (
            <div className="text-lg font-bold text-primary" data-private-value>
              {}
              {formatMoney(computedValue.valueCents, formData.currency)}
            </div>
          ) : (
            <div role="alert" className="text-sm text-destructive">
              {describePriceError(computedValue.error)}
            </div>
          )}
        </div>
      )}

      {isCrypto && usesLivePricing && computedValue?.ok && paidAmountCents !== null && profitLossCents !== null && (
        <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm" data-private-value>
          <div><div className="text-xs text-muted-foreground">Paid</div><div className="font-medium">{formatMoney(paidAmountCents, "USD")}</div></div>
          <div><div className="text-xs text-muted-foreground">Live profit / loss</div><div className={profitLossCents >= 0 ? "font-medium text-emerald-600 dark:text-emerald-400" : "font-medium text-destructive"}>{formatMoney(profitLossCents, "USD")}</div></div>
        </div>
      )}

      {usesLivePricing && quote !== null && formData.currency !== "USD" && (
        <p className="text-xs text-muted-foreground">
          Both price feeds quote in USD; the value above is shown as{" "}
          {formData.currency} without conversion.
        </p>
      )}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {asset ? "Edit Asset" : "Add Asset"}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="min-w-0 space-y-4">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <AssetCategoryField formData={formData} setFormData={setFormData} />
          <AssetValueFields formData={formData} setFormData={setFormData} usesLivePricing={usesLivePricing} />

          {isCrypto && (
            <>
              <CryptoFields formData={formData} setFormData={setFormData} />

              {!asset && usesLivePricing && (
                <div className="space-y-3 rounded-md border p-3">
                  <div>
                    <p className="text-sm font-medium">Record purchase</p>
                    <p className="text-xs text-muted-foreground">
                      This creates one confirmed transaction and decreases the selected account.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="crypto-purchase-account">Paid from</Label>
                      <Select value={purchaseAccountId} onValueChange={setPurchaseAccountId}>
                        <SelectTrigger id="crypto-purchase-account"><SelectValue placeholder="Choose account" /></SelectTrigger>
                        <SelectContent>
                          {purchaseAccounts.map((account) => (
                            <SelectItem key={account.id} value={String(account.id)}>{account.name} ({account.currency})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="crypto-purchase-category">Tag / category</Label>
                      <Select value={purchaseCategoryId} onValueChange={setPurchaseCategoryId}>
                        <SelectTrigger id="crypto-purchase-category"><SelectValue placeholder="Choose investment category" /></SelectTrigger>
                        <SelectContent>
                          {purchaseCategories.map((category) => (
                            <SelectItem key={category.id} value={String(category.id)}>{category.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {(purchaseAccounts.length === 0 || purchaseCategories.length === 0) && (
                    <p role="alert" className="text-xs text-destructive">
                      Add an asset account and an Investment category before recording a coin purchase.
                    </p>
                  )}
                </div>
              )}

              {livePricePanel}
            </>
          )}

          {isCommodity && (
            <>
              <CommodityFields formData={formData} setFormData={setFormData} onOzChange={handleOzChange} onGramsChange={handleGramsChange} />

              {livePricePanel}
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Input
              id="notes"
              value={formData.notes}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, notes: e.target.value }))
              }
              placeholder="Additional details"
            />
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {asset ? "Update" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
