/**
 * The bridge between "when was this bought" and "what is it worth today".
 *
 * `resolveAcquisitions` (lib/assets/acquisition.ts) decides the acquisition
 * date; `deriveNetWorth` (lib/cash-balance.ts) decides the money. This module is
 * the ONE place that hands the first answer to the second, so no caller has to
 * remember to annotate its asset rows — and so no caller can annotate them a
 * slightly different way.
 *
 * Kept separate from both files on purpose: lib/assets/acquisition.ts must not
 * know about net worth, and lib/cash-balance.ts must not know how to read
 * `assets.linked_transaction_ids`.
 */
import type { StandaloneAsset } from "@/lib/cash-balance";
import type { Cents } from "@/lib/money";

import {
  resolveAcquisitions,
  type AcquisitionAsset,
  type AcquisitionCategory,
  type AcquisitionTransaction,
  type AssetAcquisition,
} from "./acquisition";

/** An `assets` row as every caller already has it: acquisition inputs plus value. */
export type ValuedAsset = AcquisitionAsset & { currentValueCents: Cents };

export type AnnotatedAssets = {
  /** Ready to pass straight to `deriveNetWorth({ standaloneAssets })`. */
  standaloneAssets: StandaloneAsset[];
  /** The full acquisition record per asset id, for any surface that shows it. */
  acquisitions: Map<number, AssetAcquisition>;
};

/**
 * Annotate asset rows with their acquisition date and evidence.
 *
 * Cash rows pass through unannotated — `resolveAcquisitions` skips them because
 * the derived Cash asset was never acquired on a day, and `deriveNetWorth`
 * excludes it from net worth anyway.
 */
export function annotateStandaloneAssets(
  assets: readonly ValuedAsset[],
  transactions: readonly AcquisitionTransaction[],
  categories: readonly AcquisitionCategory[],
): AnnotatedAssets {
  const acquisitions = resolveAcquisitions(assets, transactions, categories);

  const standaloneAssets = assets.map((asset): StandaloneAsset => {
    const acquisition = acquisitions.get(asset.id);
    return {
      id: asset.id,
      category: asset.category,
      currentValueCents: asset.currentValueCents,
      // `?? null`, not `?? undefined`: a Cash row genuinely has no acquisition,
      // and saying so explicitly is what stops a later reader from treating the
      // missing key as "not yet resolved".
      acquiredOn: acquisition?.acquiredOn ?? null,
      acquisitionEvidence: acquisition?.evidence ?? null,
    };
  });

  return { standaloneAssets, acquisitions };
}
