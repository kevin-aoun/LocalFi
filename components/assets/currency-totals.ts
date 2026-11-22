
import { formatMoney, sumCents, type Cents } from "@/lib/money";

export type ValuedAsset = {
  currentValueCents: Cents;
  currency: string;
};

export type CurrencyTotal = {
  currency: string;
  totalCents: Cents;
  count: number;
};

export function normalizeCurrency(currency: string | null | undefined): string {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  return code === "" ? "USD" : code;
}

export function totalsByCurrency(assets: readonly ValuedAsset[]): CurrencyTotal[] {
  const buckets = new Map<string, Cents[]>();
  for (const asset of assets) {
    const code = normalizeCurrency(asset.currency);
    const bucket = buckets.get(code);
    if (bucket) bucket.push(asset.currentValueCents);
    else buckets.set(code, [asset.currentValueCents]);
  }

  return [...buckets.entries()]
    .map(([currency, values]) => ({
      currency,
      totalCents: sumCents(values),
      count: values.length,
    }))
    .sort(
      (a, b) =>
        Math.abs(b.totalCents) - Math.abs(a.totalCents) || a.currency.localeCompare(b.currency),
    );
}

export function formatCurrencyTotals(totals: readonly CurrencyTotal[]): string {
  if (totals.length === 0) return formatMoney(0);
  return totals.map((t) => formatMoney(t.totalCents, t.currency)).join(" + ");
}

export function shareOfCurrency(
  valueCents: Cents,
  currencyTotalCents: Cents,
): number | null {
  if (currencyTotalCents === 0) return null;
  return (valueCents / currencyTotalCents) * 100;
}

export type AllocationRow = {

  type: string;
  currency: string;
  totalCents: Cents;
  count: number;

  percentage: number | null;
};

export function allocationRows(
  assets: readonly (ValuedAsset & { category: string })[],
): AllocationRow[] {
  const currencyOrder = totalsByCurrency(assets);
  const currencyTotal = new Map(currencyOrder.map((t) => [t.currency, t.totalCents]));
  const rank = new Map(currencyOrder.map((t, i) => [t.currency, i]));

  const buckets = new Map<string, { type: string; currency: string; values: Cents[] }>();
  for (const asset of assets) {
    const currency = normalizeCurrency(asset.currency);
    const key = `${asset.category}\u0000${currency}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.values.push(asset.currentValueCents);
    else buckets.set(key, { type: asset.category, currency, values: [asset.currentValueCents] });
  }

  return [...buckets.values()]
    .map((bucket) => {
      const totalCents = sumCents(bucket.values);
      return {
        type: bucket.type,
        currency: bucket.currency,
        totalCents,
        count: bucket.values.length,
        percentage: shareOfCurrency(totalCents, currencyTotal.get(bucket.currency) ?? 0),
      };
    })
    .sort(
      (a, b) =>
        (rank.get(a.currency) ?? 0) - (rank.get(b.currency) ?? 0) ||
        Math.abs(b.totalCents) - Math.abs(a.totalCents) ||
        a.type.localeCompare(b.type),
    );
}


export function formatShare(percentage: number | null): string {
  return percentage === null ? "—" : `${percentage.toFixed(2)}%`;
}


export function barWidth(percentage: number | null): number {
  if (percentage === null || !Number.isFinite(percentage)) return 0;
  return Math.min(100, Math.max(0, percentage));
}
