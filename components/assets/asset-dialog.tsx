"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createAsset, updateAsset } from "@/app/actions/assets";
import {
  createLivePricedAsset,
  getLivePriceQuote,
  updateLivePricedAsset,
} from "@/app/actions/crypto";
import { AlertCircle, Loader2, TrendingUp } from "lucide-react";
import { centsToDecimal, formatMoney, tryParseAmount, type Cents } from "@/lib/money";
import {
  describePriceError,
  holdingValueCents,
  type PriceQuote,
} from "@/lib/prices";
import {
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
  /** Current value in integer cents, denominated in `currency`. */
  currentValueCents: Cents;
  currency: string;
  notes?: string | null;
  commodityType?: string | null;
  quantity?: number | null;
  unit?: string | null;
  /** Which feed prices this holding: "XAU" (SwissQuote) or "BTC" (CoinGecko). */
  priceSymbol?: string | null;
  /** When the stored value last came from a live quote — used to say "stale". */
  pricedAt?: Date | number | string | null;
  useLivePrice?: boolean;
};

type AssetDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset?: Asset | null;
  onSuccess: () => void;
};

/** Text for the moment a stored value was last priced, or null if it never was. */
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
  onSuccess,
}: AssetDialogProps) {
  const [loading, setLoading] = useState(false);
  /** Server-side failure to show the user; null when there is nothing wrong. */
  const [error, setError] = useState<string | null>(null);
  /** The live quote, or null while it is being fetched / after it failed. */
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  /** Why the last live-price fetch failed, so the UI can say what went wrong. */
  const [priceError, setPriceError] = useState<string | null>(null);
  const [formData, setFormData] = useState<AssetFormData>(emptyAssetForm);

  const { isCommodity, isCrypto, liveSymbol, usesLivePricing, liveUnit, liveQuantityText } = livePricingFor(formData);
  const liveQuantityGiven = liveQuantityText.trim() !== ""; // "0" is a quantity

  /**
   * The computed value, using the SAME function the server uses, so the number
   * previewed here and the number stored cannot disagree: quantity x price,
   * rounded to the cent exactly once.
   */
  const computedValue =
    quote !== null && usesLivePricing && liveQuantityGiven
      ? holdingValueCents(quote, Number(liveQuantityText.trim()), liveUnit)
      : null;

  const storedPricedAt = pricedAtLabel(asset?.pricedAt);

  // Fetch the live quote when the holding or the toggle changes. A failure is
  // recorded and SHOWN: the server will refuse to save rather than store $0, but
  // there is no reason to make the user find that out the hard way.
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
        // Never fall back to a price of 0 — that is how a holding vanishes.
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
      // An explicit null check, not `asset.quantity || 0`: a stored quantity of 0
      // is a quantity, and a null one is not "0 oz".
      setFormData(formFromAsset(asset, centsToDecimal));
    } else {
      setFormData(emptyAssetForm());
    }
  }, [asset, open]);

  // A weight of 0 is a weight. `oz > 0 ? … : ""` blanked the paired field, which
  // is the same "0 is not a value" mistake that broke live pricing server-side.
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
        | Awaited<ReturnType<typeof createLivePricedAsset>>;

      if (usesLivePricing && liveSymbol !== null) {
        // A live-priced holding — metal or coin — goes through the priced-holding
        // action, which records WHICH feed prices it and refuses to save anything
        // at all if the fetch fails.
        const livePriceForm = new FormData();
        livePriceForm.append("priceSymbol", liveSymbol);
        // Send the quantity whenever the field is non-empty: "0" is a quantity,
        // not an absent value, and the server distinguishes the two explicitly.
        if (liveQuantityGiven) {
          livePriceForm.append("quantity", liveQuantityText.trim());
        }
        livePriceForm.append("unit", liveUnit);
        // DECISION: DEC-004 — provider quotes are USD; never relabel them.
        livePriceForm.append("currency", "USD");
        if (formData.notes) {
          livePriceForm.append("notes", formData.notes);
        }
        result = asset
          ? await updateLivePricedAsset(asset.id, livePriceForm)
          : await createLivePricedAsset(livePriceForm);
      } else {
        const formDataObj = new FormData();
        formDataObj.append("category", formData.category);
        formDataObj.append("currentValue", formData.currentValue);
        formDataObj.append("currency", usesLivePricing ? "USD" : formData.currency);
        if (formData.notes) {
          formDataObj.append("notes", formData.notes);
        }

        // Add commodity-specific fields if category is Commodities
        if (isCommodity) {
          formDataObj.append("commodityType", formData.commodityType);
          // Always use oz as the stored unit.
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

      // The action reports failure by RETURNING { error }, not by throwing. This
      // dialog used to close as if the write had succeeded — which is how a
      // live-priced holding could appear to save while nothing was stored.
      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save asset:", err);
      setError(err instanceof Error ? err.message : "Failed to save asset.");
    } finally {
      setLoading(false);
    }
  };

  /** The live-price panel: current price, computed value, and every failure. */
  const livePricePanel = (
    <>
      {usesLivePricing && quote !== null && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-green-50 dark:bg-green-950 px-3 py-2">
          <TrendingUp className="h-3 w-3 text-green-600" />
          <span className="text-sm font-semibold text-green-700 dark:text-green-400" data-private-value>
            {/* A price of 0 is impossible here: lib/prices.ts rejects a
                non-positive price as a malformed response. */}
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
              {/* quantity x price is fractional; rounded to the cent once, in
                  lib/prices.ts, by the same code the server action uses. */}
              {formatMoney(computedValue.valueCents, formData.currency)}
            </div>
          ) : (
            <div role="alert" className="text-sm text-destructive">
              {describePriceError(computedValue.error)}
            </div>
          )}
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
