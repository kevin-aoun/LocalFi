"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  createAsset,
  getAssetAcquisitions,
  setAssetPurchaseLinks,
  updateAsset,
} from "@/app/actions/assets";
import {
  createLivePricedAsset,
  getLivePriceQuote,
  updateLivePricedAsset,
} from "@/app/actions/crypto";
import { AlertCircle, Loader2, TrendingUp, Link } from "lucide-react";
import { centsToDecimal, formatMoney, tryParseAmount, type Cents } from "@/lib/money";
import {
  acquisitionHeadline,
  previewLinkedAcquisition,
  serializeLinkedTransactionIds,
  type AssetAcquisition,
  type PurchaseCandidate,
} from "@/lib/assets/acquisition";
import {
  GRAMS_PER_TROY_OUNCE,
  PRICED_HOLDINGS,
  commodityPriceSymbols,
  cryptoPriceSymbols,
  describePriceError,
  holdingValueCents,
  priceSymbolForCommodityType,
  type PriceQuote,
  type PriceSymbol,
} from "@/lib/prices";

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
  linkedTransactionIds?: string | null;
  useLivePrice?: boolean;
};

type AssetDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset?: Asset | null;
  onSuccess: () => void;
};

/**
 * "Cash" is deliberately ABSENT: it is derived from the transaction ledger by
 * `syncCashAsset`, and both `createAsset` and `updateAsset` reject it outright.
 * Offering it — and, worse, DEFAULTING to it, which this dialog used to do —
 * meant the primary action of "Add Asset" was rejected every single time.
 */
const ASSET_TYPES = ["Savings", "Investments", "Crypto", "Properties", "Vehicles", "Commodities", "Other"];
const DEFAULT_ASSET_TYPE = "Savings";

/**
 * Both live-price pickers come from the registry in lib/prices.ts, so the UI
 * cannot offer something the server has no provider for (and cannot miss
 * something it does).
 */
const COMMODITY_CHOICES = commodityPriceSymbols.map((symbol) => PRICED_HOLDINGS[symbol].label);
const CRYPTO_CHOICES = cryptoPriceSymbols.map((symbol) => ({
  symbol,
  label: PRICED_HOLDINGS[symbol].label,
}));

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
  /** Linkable Investment transactions for the CURRENT category, best first. */
  const [candidates, setCandidates] = useState<PurchaseCandidate[]>([]);
  /** What the ledger currently says about this asset's acquisition; null when adding. */
  const [acquisition, setAcquisition] = useState<AssetAcquisition | null>(null);
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<number[]>([]);
  /** Set while the one-click link is being written, so the button can't double-fire. */
  const [linking, setLinking] = useState(false);
  const [formData, setFormData] = useState({
    category: DEFAULT_ASSET_TYPE,
    currentValue: "",
    currency: "USD",
    notes: "",
    commodityType: "Gold",
    /** Which coin, when the category is Crypto. */
    cryptoSymbol: "BTC" as PriceSymbol,
    quantityOz: "",
    quantityGrams: "",
    /** A COUNT of coins — `unit` is "coins" for crypto, never a weight. */
    quantityCoins: "",
    useLivePrice: false,
  });

  // Convert grams to oz
  const gramsToOz = (grams: number) => grams / GRAMS_PER_TROY_OUNCE;
  const ozToGrams = (oz: number) => oz * GRAMS_PER_TROY_OUNCE;

  const isCommodity = formData.category === "Commodities";
  const isCrypto = formData.category === "Crypto";
  /** Live pricing is available for anything in the registry, not just metals. */
  const supportsLivePrice = isCommodity || isCrypto;
  const liveSymbol: PriceSymbol | null = !supportsLivePrice
    ? null
    : isCrypto
      ? formData.cryptoSymbol
      : priceSymbolForCommodityType(formData.commodityType);
  const usesLivePricing = formData.useLivePrice && liveSymbol !== null;

  /** Crypto is counted in coins; metal is weighed in troy ounces. */
  const liveUnit = isCrypto ? "coins" : "oz";
  const liveQuantityText = isCrypto ? formData.quantityCoins : formData.quantityOz;
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

  /**
   * Acquisition data for EVERY category, not just Commodities.
   *
   * This used to be fetched only when `category === "Commodities"`, and the
   * picker below only rendered there — so a Crypto holding could not be linked
   * to its purchase at all, which is exactly the state the owner's BTC and ETH
   * rows are in. Any asset can be bought, so any asset can be linked.
   *
   * `getAssetAcquisitions` returns the SAME `resolveAcquisitions` answer the
   * net-worth and history paths use, so this panel cannot say "bought on X"
   * while the chart starts the holding on a different day.
   */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getAssetAcquisitions().then((data) => {
      if (cancelled) return;
      setCandidates(data.candidatesByCategory[formData.category] ?? []);
      setAcquisition(
        asset ? (data.acquisitions.find((a) => a.assetId === asset.id) ?? null) : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [open, formData.category, asset]);

  // Load linked transactions when editing
  useEffect(() => {
    if (asset?.linkedTransactionIds) {
      try {
        const parsed: unknown = JSON.parse(asset.linkedTransactionIds);
        setSelectedTransactionIds(
          Array.isArray(parsed)
            ? parsed.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
            : [],
        );
      } catch {
        setSelectedTransactionIds([]);
      }
    } else {
      setSelectedTransactionIds([]);
    }
  }, [asset]);

  useEffect(() => {
    setError(null);
    if (asset) {
      // An explicit null check, not `asset.quantity || 0`: a stored quantity of 0
      // is a quantity, and a null one is not "0 oz".
      const hasQuantity = asset.quantity !== null && asset.quantity !== undefined;
      const quantity = hasQuantity ? (asset.quantity as number) : 0;
      const quantityOz = asset.unit === "grams" ? gramsToOz(quantity).toFixed(4) : String(quantity);
      const quantityGrams = asset.unit === "grams" ? String(quantity) : ozToGrams(quantity).toFixed(2);
      const storedSymbol = asset.priceSymbol ?? null;
      const storedCrypto = cryptoPriceSymbols.find((symbol) => symbol === storedSymbol);

      setFormData({
        category: asset.category,
        // Decimal string for the <input type="number">; the server action parses
        // it back with parseAmount.
        currentValue: centsToDecimal(asset.currentValueCents).toString(),
        currency: asset.currency,
        notes: asset.notes || "",
        commodityType: asset.commodityType || "Gold",
        cryptoSymbol: storedCrypto ?? "BTC",
        quantityOz: hasQuantity ? quantityOz : "",
        quantityGrams: hasQuantity ? quantityGrams : "",
        quantityCoins: hasQuantity ? String(quantity) : "",
        useLivePrice: asset.useLivePrice || false,
      });
    } else {
      setFormData({
        category: DEFAULT_ASSET_TYPE,
        currentValue: "",
        currency: "USD",
        notes: "",
        commodityType: "Gold",
        cryptoSymbol: "BTC",
        quantityOz: "",
        quantityGrams: "",
        quantityCoins: "",
        useLivePrice: false,
      });
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

  const toggleTransaction = (transactionId: number) => {
    setSelectedTransactionIds((prev) =>
      prev.includes(transactionId)
        ? prev.filter((id) => id !== transactionId)
        : [...prev, transactionId],
    );
  };

  /** The acquisition the current selection implies, from the shared rule. */
  const linkPreview = previewLinkedAcquisition(selectedTransactionIds, candidates);

  /**
   * Write ONLY the links. Separate from Update on purpose: recording where a
   * holding came from must not depend on a live price fetch succeeding.
   */
  const handleLinkNow = async () => {
    if (!asset) return;
    setLinking(true);
    setError(null);
    try {
      const result = await setAssetPurchaseLinks(asset.id, selectedTransactionIds);
      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }
      // Re-read the acquisition so the panel shows what was actually stored,
      // rather than what this component hoped was stored.
      const data = await getAssetAcquisitions();
      setAcquisition(data.acquisitions.find((a) => a.assetId === asset.id) ?? null);
      onSuccess();
    } catch (err) {
      console.error("Failed to link purchase:", err);
      setError(err instanceof Error ? err.message : "Failed to link that purchase.");
    } finally {
      setLinking(false);
    }
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
        livePriceForm.append("currency", formData.currency);
        if (formData.notes) {
          livePriceForm.append("notes", formData.notes);
        }
        // ALWAYS send the field, even when nothing is selected. The server reads
        // an ABSENT field as "leave the links alone" and a present-but-empty one
        // as "clear them", so sending it only when non-empty made unlinking
        // impossible. `?? ""` is the empty case, not a missing key.
        livePriceForm.append(
          "linkedTransactionIds",
          serializeLinkedTransactionIds(selectedTransactionIds) ?? "",
        );

        result = asset
          ? await updateLivePricedAsset(asset.id, livePriceForm)
          : await createLivePricedAsset(livePriceForm);
      } else {
        const formDataObj = new FormData();
        formDataObj.append("category", formData.category);
        formDataObj.append("currentValue", formData.currentValue);
        formDataObj.append("currency", formData.currency);
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

        // OUTSIDE the isCommodity branch, always sent: a house, a car or a
        // savings pot is bought too, and gating this on Commodities meant
        // editing any other asset submitted no link field — which, before the
        // server learned to tell "absent" from "empty", erased it.
        formDataObj.append(
          "linkedTransactionIds",
          serializeLinkedTransactionIds(selectedTransactionIds) ?? "",
        );

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
          <span className="text-sm font-semibold text-green-700 dark:text-green-400">
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
                <strong>{formatMoney(asset.currentValueCents, asset.currency)}</strong>, which is
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
            <div className="text-lg font-bold text-primary">
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

  /**
   * WHEN this holding was bought, WHAT it cost, and WHICH transaction says so —
   * plus the honest admission when nothing says so at all.
   *
   * The rule being displayed is not implemented here. `acquisition` comes
   * straight from `resolveAcquisitions`, the one function that decides an
   * acquisition date for the chart, the net-worth figure and this panel alike.
   */
  const acquisitionPanel = (
    <div className="space-y-2 rounded-md border p-3">
      <Label className="flex items-center gap-2 text-sm">
        <Link className="h-3 w-3" />
        Purchase
      </Label>

      {acquisition !== null && (
        <div
          className={
            acquisition.unbacked
              ? "rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs"
              : "rounded-md bg-muted px-3 py-2 text-xs"
          }
        >
          <div className="font-semibold">{acquisitionHeadline(acquisition)}</div>
          {/* The full sentence, including WHY an inference was refused. An
              unbacked holding is NOT removed from net worth — the owner really
              owns it — it is labelled, which is the honest half of the rule. */}
          <p className="mt-1 text-muted-foreground">{acquisition.explanation}</p>
          {acquisition.unbacked && (
            <p className="mt-1 font-medium text-amber-700 dark:text-amber-400">
              This still counts towards your net worth today. Only its start date is a guess.
            </p>
          )}
        </div>
      )}

      {/* What the acquisition BECOMES if the current selection is saved. Shown
          before anything is written, using the same "earliest linked
          transaction wins" rule the server applies. */}
      {linkPreview !== null &&
        (acquisition === null || linkPreview.transactionId !== acquisition.transactionId) && (
          <p className="text-xs text-primary">
            Will be dated {linkPreview.dateKey} at{" "}
            {formatMoney(linkPreview.costCents, formData.currency)} by transaction #
            {linkPreview.transactionId}.
          </p>
        )}

      {candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          There are no Investment transactions to link. Record the purchase as a transaction in an
          Investment category, then link it here — until then this holding&apos;s start date is
          taken from the day its row was created.
        </p>
      ) : (
        <>
          <div className="max-h-44 space-y-1 overflow-y-auto">
            {candidates.map((candidate) => {
              const checked = selectedTransactionIds.includes(candidate.transactionId);
              return (
                <Label
                  key={candidate.transactionId}
                  className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm font-normal hover:bg-muted"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleTransaction(candidate.transactionId)}
                  />
                  <span className="hidden w-24 shrink-0 tabular-nums text-xs text-muted-foreground sm:block">
                    {candidate.dateKey}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {candidate.categoryName}
                    {candidate.comment ? ` · ${candidate.comment}` : ""}
                    {candidate.matchesCategory && (
                      <span className="ml-1 text-xs text-primary">· suggested</span>
                    )}
                  </span>
                  <span className="max-w-24 shrink-0 truncate tabular-nums">
                    {formatMoney(candidate.amountCents, formData.currency)}
                  </span>
                </Label>
              );
            })}
          </div>

          {/* One click, and it writes ONLY the link: no re-price, no rounding,
              no failure when the network is down. Available while editing an
              existing asset; on a new one the selection rides along with Create. */}
          {asset && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={linking}
              onClick={handleLinkNow}
            >
              {linking && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
              {selectedTransactionIds.length === 0
                ? "Unlink all purchases"
                : `Link ${selectedTransactionIds.length} purchase(s) now`}
            </Button>
          )}
        </>
      )}
    </div>
  );

  const livePriceCheckbox = (
    <Label className="flex items-center gap-2">
      <Checkbox
        id="useLivePrice"
        checked={formData.useLivePrice}
        onCheckedChange={(checked) =>
          setFormData((prev) => ({ ...prev, useLivePrice: checked === true }))
        }
      />
      <span className="text-sm font-normal cursor-pointer">Live Price</span>
    </Label>
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

          <div className="space-y-2">
            <Label htmlFor="category">Category</Label>
            <Select
              value={formData.category}
              onValueChange={(value) =>
                setFormData((prev) => ({ ...prev, category: value }))
              }
              required
            >
              <SelectTrigger id="category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSET_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* The manual value input is hidden only when a live price will supply it */}
          {!usesLivePricing && (
            <div className="space-y-2">
              <Label htmlFor="currentValue">Current Value</Label>
              <Input
                id="currentValue"
                type="number"
                step="0.01"
                min="0"
                value={formData.currentValue}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, currentValue: e.target.value }))
                }
                placeholder="0.00"
                required
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="currency">Currency</Label>
            <Input
              id="currency"
              value={formData.currency}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, currency: e.target.value }))
              }
              placeholder="USD"
              required
            />
          </div>

          {/* Crypto: a coin, a coin COUNT, and a live price from CoinGecko */}
          {isCrypto && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="cryptoSymbol">Coin</Label>
                  <Select
                    value={formData.cryptoSymbol}
                    onValueChange={(value) =>
                      setFormData((prev) => ({ ...prev, cryptoSymbol: value as PriceSymbol }))
                    }
                  >
                    <SelectTrigger id="cryptoSymbol">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CRYPTO_CHOICES.map((choice) => (
                        <SelectItem key={choice.symbol} value={choice.symbol}>
                          {choice.label} ({choice.symbol})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Pricing</Label>
                  {livePriceCheckbox}
                </div>
              </div>

              {formData.useLivePrice && (
                <div className="space-y-2">
                  <Label htmlFor="quantityCoins">Quantity (coins)</Label>
                  <Input
                    id="quantityCoins"
                    type="number"
                    /* A coin count, not a weight: 8 decimals is one satoshi. */
                    step="0.00000001"
                    min="0"
                    value={formData.quantityCoins}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, quantityCoins: e.target.value }))
                    }
                    placeholder="0.00000000"
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    How many {PRICED_HOLDINGS[formData.cryptoSymbol].label} you hold: fractions are
                    exact, so 0.0345 means 0.0345 {formData.cryptoSymbol}.
                  </p>
                </div>
              )}

              {livePricePanel}
            </>
          )}

          {/* Commodity-specific fields */}
          {isCommodity && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="commodityType">Type</Label>
                  <Select
                    value={formData.commodityType}
                    onValueChange={(value) =>
                      setFormData((prev) => ({ ...prev, commodityType: value }))
                    }
                    required
                  >
                    <SelectTrigger id="commodityType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COMMODITY_CHOICES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Pricing</Label>
                  {livePriceCheckbox}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="quantityOz">Ounces (oz)</Label>
                  <Input
                    id="quantityOz"
                    type="number"
                    step="0.0001"
                    min="0"
                    value={formData.quantityOz}
                    onChange={(e) => handleOzChange(e.target.value)}
                    placeholder="0.0000"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="quantityGrams">Grams (g)</Label>
                  <Input
                    id="quantityGrams"
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.quantityGrams}
                    onChange={(e) => handleGramsChange(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </div>

              {livePricePanel}
            </>
          )}

          {acquisitionPanel}

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
