import { groupAccountsByKind } from "@/components/accounts/account-form-logic";
import { normalizeCurrency } from "@/components/assets/currency-totals";
import { negateCents, sumCents, type Cents } from "@/lib/money";

import { countedAssets, type SidebarViewInput } from "../../sidebar-assets";

/** Independent re-computation of the sidebar totals that tests compare against. */
export function auditSidebarTotals(input: SidebarViewInput): {
  totalAssetsCents: Cents;
  totalLiabilitiesCents: Cents;
  netWorthCents: Cents;
  standaloneAssetsCents: Cents;
  currencyTotals: Array<{
    currency: string;
    totalAssetsCents: Cents;
    totalLiabilitiesCents: Cents;
    netWorthCents: Cents;
    standaloneAssetsCents: Cents;
  }>;
} {
  const grouped = groupAccountsByKind(input.accounts, { includeArchived: true });
  type Parts = {
    assets: Cents[];
    liabilities: Cents[];
    standalone: Cents[];
  };
  const buckets = new Map<string, Parts>();
  const bucketFor = (currency: string) => {
    const code = normalizeCurrency(currency);
    const existing = buckets.get(code);
    if (existing) return existing;
    const created: Parts = { assets: [], liabilities: [], standalone: [] };
    buckets.set(code, created);
    return created;
  };

  for (const total of input.netWorth.currencyTotals) {
    bucketFor(total.currency).assets.push(total.unassignedCents);
  }
  for (const row of grouped.assets) {
    bucketFor(row.currency).assets.push(row.balanceCents);
  }
  for (const row of grouped.liabilities) {
    const bucket = bucketFor(row.currency);

    if (row.balanceCents < 0) bucket.liabilities.push(negateCents(row.balanceCents));
    else bucket.assets.push(row.balanceCents);
  }

  for (const asset of countedAssets(input.assets)) {
    const bucket = bucketFor(asset.currency);
    bucket.standalone.push(asset.currentValueCents);
    bucket.assets.push(asset.currentValueCents);
  }

  const currencyTotals = [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, parts]) => {
      const totalAssetsCents = sumCents(parts.assets);
      const totalLiabilitiesCents = sumCents(parts.liabilities);
      return {
        currency,
        totalAssetsCents,
        totalLiabilitiesCents,
        netWorthCents: sumCents([totalAssetsCents, negateCents(totalLiabilitiesCents)]),
        standaloneAssetsCents: sumCents(parts.standalone),
      };
    });
  const aggregate = currencyTotals.length === 1 ? currencyTotals[0] : null;

  return {
    totalAssetsCents: aggregate?.totalAssetsCents ?? 0,
    totalLiabilitiesCents: aggregate?.totalLiabilitiesCents ?? 0,
    netWorthCents: aggregate?.netWorthCents ?? 0,
    standaloneAssetsCents: aggregate?.standaloneAssetsCents ?? 0,
    currencyTotals,
  };
}
