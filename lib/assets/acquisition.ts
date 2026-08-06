/**
 * WHEN WAS THIS ASSET BOUGHT — the single definition, for the whole app.
 *
 * ## Why this module exists
 *
 * An asset's value cannot start fluctuating until it is owned, so it cannot
 * start affecting net worth until it is owned. That makes "the day it was
 * acquired" a first-class property of every holding, not a detail internal to
 * the history reconstructor.
 *
 * The precedence below was written once, inside `resolveHoldings` in
 * lib/history/reconstruct.ts, and was about to be written a second time for the
 * live net-worth path. Two definitions of "when was this bought" would drift,
 * and the day they disagreed the chart and the headline figure would disagree
 * too — silently, and only about the past. So the rule lives here, and
 * lib/history/reconstruct.ts, lib/cash-balance.ts's callers and the asset dialog
 * all read it from this file.
 *
 * ## The precedence, in order. First match wins.
 *
 * 1. **`linked_transaction_ids`** — an explicit link the user made. If it names
 *    more than one real transaction the EARLIEST one dates the acquisition (you
 *    own something from the first payment, not the last). An explicit link beats
 *    any inference, always. Evidence: `linked_transaction`.
 *
 * 2. **An inferred ledger match** — the earliest counted Investment transaction
 *    whose CATEGORY NAME equals the asset's category ("Commodities" -> the Gold
 *    row). This is only used when the asset is the ONLY non-Cash asset in that
 *    category. With two Crypto rows and one Crypto purchase there is no honest
 *    way to say which row the purchase bought, so the inference is REFUSED
 *    rather than guessed, and `ambiguityNote` says why. Evidence:
 *    `inferred_from_category`.
 *
 * 3. **`assets.created_at`** — the day the row was added to the app. The ledger
 *    contains no event dating this holding, so this is a labelled FALLBACK, not
 *    a fact: it says "not before this", which is the strongest true claim
 *    available. Such an asset is `unbacked` — it still counts towards net worth
 *    today (a gift, mining income or a pre-ledger holding is really owned), but
 *    every surface that shows it must say its provenance is missing. Evidence:
 *    `asset_created_at`.
 *
 * ## What this module deliberately does NOT do
 *
 * - It never reads the clock. An acquisition date is a property of stored data;
 *   a caller that needs "as of today" passes `today` in itself. (`npm run
 *   test:tz` runs the suite at UTC+14 and UTC-11.)
 * - It never invents a transaction, and it never drops an asset from net worth
 *   for lacking one. Quietly removing an unbacked holding would be its own kind
 *   of lie; naming it is the honest move.
 * - It never converts a quantity to money and never touches a price feed.
 */
import { isDateKey, toDateKey, type DateKey } from "@/lib/dates";
import { formatMoney, type Cents } from "@/lib/money";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * WHICH of the three rules dated this acquisition. This is the precise answer;
 * `AcquisitionSource` below is a two-valued projection of it kept for the
 * history reconstructor's existing output shape.
 */
export type AcquisitionEvidence =
  /** `assets.linked_transaction_ids` named a real transaction. */
  | "linked_transaction"
  /** The one asset in its category matched the one purchase in that category. */
  | "inferred_from_category"
  /** Nothing in the ledger dates it; `assets.created_at` is a labelled guess. */
  | "asset_created_at";

/**
 * The coarse source: did the LEDGER date this, or only the row's creation day?
 *
 * Deliberately a projection of `AcquisitionEvidence` rather than a second field
 * with its own rules — `acquisitionSourceOf` is the only place the mapping
 * exists, so the two can never disagree.
 */
export type AcquisitionSource = "ledger" | "asset_created_at";

export function acquisitionSourceOf(evidence: AcquisitionEvidence): AcquisitionSource {
  return evidence === "asset_created_at" ? "asset_created_at" : "ledger";
}

/** The subset of an `assets` row this needs. `createdAt` is the fallback date. */
export type AcquisitionAsset = {
  id: number;
  category: string;
  /** JSON array of transaction ids, as stored. NULL/'' = no explicit link. */
  linkedTransactionIds?: string | null;
  /** Unix seconds or a Date, as drizzle hands it back. */
  createdAt: Date | number;
};

/** The subset of a `transactions` row this needs, already reduced to a day. */
export type AcquisitionTransaction = {
  id?: number;
  dateKey: DateKey;
  amountCents: Cents;
  categoryId?: number | null;
  transferAccountId?: number | null;
  pending?: boolean | null;
  comment?: string | null;
};

export type AcquisitionCategory = { id: number; name: string; type: string };

export type AssetAcquisition = {
  assetId: number;
  /** The first day this asset contributes anything. Before it: exactly 0. */
  acquiredOn: DateKey;
  evidence: AcquisitionEvidence;
  /** `ledger` unless the date is only `assets.created_at`. */
  source: AcquisitionSource;
  /** The transaction that dated it, when there was one. */
  transactionId: number | null;
  /** What the ledger says was paid, when there was a purchase transaction. */
  costCents: Cents | null;
  /** Every linked transaction id that resolved to a real row, earliest first. */
  linkedTransactionIds: number[];
  /**
   * True when NO transaction backs this holding, so `acquiredOn` is a guess from
   * `assets.created_at`. It still counts towards net worth — it is flagged, not
   * removed.
   */
  unbacked: boolean;
  /** Set when an inference was possible but refused, saying why. */
  ambiguityNote: string | null;
  /** One sentence, safe to show the user verbatim. */
  explanation: string;
};

// ---------------------------------------------------------------------------
// linked_transaction_ids: the stored JSON, read and written in one place
// ---------------------------------------------------------------------------

/**
 * Read `assets.linked_transaction_ids`.
 *
 * Tolerant on purpose — a malformed or hand-edited column must not crash net
 * worth — but never inventive: anything that is not an integer id is dropped,
 * duplicates collapse, and order is preserved. An id of 0 is not a real row id
 * in SQLite's AUTOINCREMENT sequence, but it is still an integer and is kept:
 * dropping it here would be a falsy-zero bug, and the id simply fails to resolve
 * against the ledger, which is handled explicitly.
 */
export function parseLinkedTransactionIds(raw: string | null | undefined): number[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: number[] = [];
  for (const value of parsed) {
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * The canonical stored form, so a round-trip through the dialog cannot rewrite
 * the column into a different-but-equivalent string.
 *
 * Returns `null` for an EMPTY list — "this asset is linked to nothing" is stored
 * as NULL, matching every row written before links existed, rather than as the
 * string "[]" which would read as a second way of saying the same thing.
 */
export function serializeLinkedTransactionIds(ids: readonly number[]): string | null {
  const clean: number[] = [];
  for (const id of ids) {
    if (typeof id !== "number" || !Number.isInteger(id)) continue;
    if (!clean.includes(id)) clean.push(id);
  }
  return clean.length === 0 ? null : JSON.stringify(clean);
}

/**
 * Read the `linkedTransactionIds` field off a submitted form, preserving THREE
 * states — this distinction is the bug that kept the column NULL forever:
 *
 *   - `undefined` — the form never mentioned links. Leave the column alone.
 *     `refreshLivePricedAssets` builds a FormData out of price fields only, so
 *     an action that read "absent" as "empty" erased every link the user had
 *     made, on every scheduled snapshot.
 *   - `null`      — the form said "linked to nothing". Clear the column.
 *   - a string    — the canonical JSON array to store.
 *
 * Everything is re-serialized through `serializeLinkedTransactionIds`, so a
 * duplicated or hand-typed id cannot round-trip into storage.
 *
 * Lives here rather than in a `"use server"` module because such a module may
 * only export async functions, and this must stay synchronous and unit-testable.
 */
export function readLinkedTransactionIdsField(formData: FormData): string | null | undefined {
  if (!formData.has("linkedTransactionIds")) return undefined;
  const raw = formData.get("linkedTransactionIds");
  if (typeof raw !== "string") return null;
  return serializeLinkedTransactionIds(parseLinkedTransactionIds(raw));
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** `assets.created_at` -> a local calendar day. Never via toISOString(). */
export function assetCreatedOnKey(asset: AcquisitionAsset): DateKey {
  const raw = asset.createdAt;
  const date = raw instanceof Date ? raw : new Date(Number(raw) * 1000);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Asset ${asset.id} has an unreadable created_at: ${String(raw)}`);
  }
  return toDateKey(date);
}

/** 'YYYY-MM-DD' sorts chronologically as a string; that is why DateKey exists. */
function byDateKeyThenId(a: AcquisitionTransaction, b: AcquisitionTransaction): number {
  if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? -1 : 1;
  return (a.id ?? 0) - (b.id ?? 0);
}

/**
 * The counted Investment rows, grouped by category NAME, earliest first.
 *
 * "Counted" uses the same three exclusions the balance rule uses, so a purchase
 * that never moved money cannot date an acquisition: pending rows, transfers
 * (which are net-neutral and buy nothing) and rows whose category is missing.
 */
export function investmentPurchasesByCategory(
  transactions: readonly AcquisitionTransaction[],
  categories: readonly AcquisitionCategory[],
): Map<string, AcquisitionTransaction[]> {
  const investmentNames = new Set(
    categories.filter((c) => c.type === "Investment").map((c) => c.name),
  );
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  const byCategory = new Map<string, AcquisitionTransaction[]>();
  for (const tx of transactions) {
    if (tx.pending) continue;
    if (tx.transferAccountId !== null && tx.transferAccountId !== undefined) continue;
    if (tx.categoryId === null || tx.categoryId === undefined) continue;
    const name = nameById.get(tx.categoryId);
    if (name === undefined || !investmentNames.has(name)) continue;
    const bucket = byCategory.get(name);
    if (bucket) bucket.push(tx);
    else byCategory.set(name, [tx]);
  }
  for (const bucket of byCategory.values()) bucket.sort(byDateKeyThenId);
  return byCategory;
}

/**
 * Resolve the acquisition of every asset, applying the precedence in the module
 * docstring exactly once.
 *
 * Cash-category rows are skipped entirely and get no entry: the derived "Cash"
 * asset mirrors the ledger the accounts are derived from, it is excluded from
 * net worth by `deriveNetWorth`, and it was never "acquired" on a day.
 */
export function resolveAcquisitions(
  assets: readonly AcquisitionAsset[],
  transactions: readonly AcquisitionTransaction[],
  categories: readonly AcquisitionCategory[],
): Map<number, AssetAcquisition> {
  const counted = assets.filter((asset) => asset.category !== "Cash");

  const byId = new Map<number, AcquisitionTransaction>();
  for (const tx of transactions) {
    if (tx.id !== undefined && tx.id !== null) byId.set(tx.id, tx);
  }

  const purchasesByCategory = investmentPurchasesByCategory(transactions, categories);

  /** How many non-Cash assets sit in each category — the ambiguity guard. */
  const assetsPerCategory = new Map<string, number>();
  for (const asset of counted) {
    assetsPerCategory.set(asset.category, (assetsPerCategory.get(asset.category) ?? 0) + 1);
  }

  const out = new Map<number, AssetAcquisition>();

  for (const asset of counted) {
    const linkedIds = parseLinkedTransactionIds(asset.linkedTransactionIds);
    const linked = linkedIds
      .map((id) => byId.get(id))
      .filter((tx): tx is AcquisitionTransaction => tx !== undefined)
      .sort(byDateKeyThenId);

    // --- 1. an explicit link
    if (linked.length > 0) {
      const first = linked[0];
      out.set(asset.id, {
        assetId: asset.id,
        acquiredOn: first.dateKey,
        evidence: "linked_transaction",
        source: "ledger",
        transactionId: first.id ?? null,
        costCents: first.amountCents,
        linkedTransactionIds: linked.map((tx) => tx.id!).filter((id) => id !== undefined),
        unbacked: false,
        ambiguityNote: null,
        explanation:
          `Acquired ${first.dateKey} for ${formatMoney(first.amountCents)}, from linked ` +
          `transaction #${first.id ?? "?"}` +
          (linked.length > 1 ? ` (${linked.length} transactions linked; the earliest dates it)` : "") +
          ".",
      });
      continue;
    }

    // --- 2. an inferred ledger match, refused when it would be a guess
    const inCategory = assetsPerCategory.get(asset.category) ?? 0;
    const purchases = purchasesByCategory.get(asset.category) ?? [];
    const createdOn = assetCreatedOnKey(asset);

    if (inCategory === 1 && purchases.length > 0) {
      const first = purchases[0];
      out.set(asset.id, {
        assetId: asset.id,
        acquiredOn: first.dateKey,
        evidence: "inferred_from_category",
        source: "ledger",
        transactionId: first.id ?? null,
        costCents: first.amountCents,
        linkedTransactionIds: [],
        unbacked: false,
        ambiguityNote: null,
        explanation:
          `Acquired ${first.dateKey} for ${formatMoney(first.amountCents)}, inferred from the ` +
          `only "${asset.category}" purchase in the ledger (transaction #${first.id ?? "?"}). ` +
          `Link it explicitly to make this certain.`,
      });
      continue;
    }

    // --- 3. the labelled fallback
    const ambiguityNote =
      inCategory > 1 && purchases.length > 0
        ? `${inCategory} assets share the "${asset.category}" category and ` +
          `${purchases.length} purchase(s) exist there, so no purchase can be attributed to ` +
          `this row without guessing. Link one explicitly.`
        : null;

    out.set(asset.id, {
      assetId: asset.id,
      acquiredOn: createdOn,
      evidence: "asset_created_at",
      source: "asset_created_at",
      transactionId: null,
      costCents: null,
      linkedTransactionIds: [],
      unbacked: true,
      ambiguityNote,
      explanation:
        `No purchase transaction backs this holding, so it is treated as acquired on ` +
        `${createdOn} — the day the row was added, not a recorded purchase. It contributes 0 ` +
        `before that day and its full value from it.` +
        (ambiguityNote === null ? "" : ` ${ambiguityNote}`),
    });
  }

  return out;
}

/**
 * The Investment transactions a user could link to this asset, best first.
 *
 * `matchesCategory` marks the ones whose category name equals the asset's, which
 * is the same signal rule 2 infers from — so the one-click suggestion in the UI
 * and the inference the model performs cannot recommend different rows.
 */
export type PurchaseCandidate = {
  transactionId: number;
  dateKey: DateKey;
  amountCents: Cents;
  categoryName: string;
  comment: string | null;
  matchesCategory: boolean;
};

export function purchaseCandidates(
  assetCategory: string,
  transactions: readonly AcquisitionTransaction[],
  categories: readonly AcquisitionCategory[],
): PurchaseCandidate[] {
  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  const out: PurchaseCandidate[] = [];

  for (const [categoryName, bucket] of investmentPurchasesByCategory(transactions, categories)) {
    for (const tx of bucket) {
      if (tx.id === undefined || tx.id === null) continue;
      out.push({
        transactionId: tx.id,
        dateKey: tx.dateKey,
        amountCents: tx.amountCents,
        categoryName: nameById.get(tx.categoryId as number) ?? categoryName,
        comment: tx.comment ?? null,
        matchesCategory: categoryName === assetCategory,
      });
    }
  }

  // Same-category first, then newest first: the purchase you are looking for is
  // almost always the most recent one in the matching category.
  return out.sort((a, b) => {
    if (a.matchesCategory !== b.matchesCategory) return a.matchesCategory ? -1 : 1;
    if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? 1 : -1;
    return b.transactionId - a.transactionId;
  });
}

/**
 * What the acquisition WOULD become if these candidates were linked — so the
 * dialog can say "this will date the holding to 2025-09-30, $3,800.00" before
 * anything is written, using rule 1 (earliest linked transaction wins) rather
 * than a second, UI-shaped guess.
 *
 * Returns null when nothing is selected: that is "linked to nothing", which
 * falls back to `assets.created_at`, not to an error.
 */
export function previewLinkedAcquisition(
  selectedIds: readonly number[],
  candidates: readonly PurchaseCandidate[],
): { transactionId: number; dateKey: DateKey; costCents: Cents } | null {
  const byId = new Map(candidates.map((c) => [c.transactionId, c]));
  const chosen = selectedIds
    .map((id) => byId.get(id))
    .filter((c): c is PurchaseCandidate => c !== undefined)
    .sort((a, b) => {
      if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? -1 : 1;
      return a.transactionId - b.transactionId;
    });
  if (chosen.length === 0) return null;
  const first = chosen[0];
  return {
    transactionId: first.transactionId,
    dateKey: first.dateKey,
    costCents: first.amountCents,
  };
}

/**
 * A short label for a surface with no room for the full explanation.
 * Never says "bought on X" for a date nothing in the ledger supports.
 */
export function acquisitionHeadline(acquisition: AssetAcquisition): string {
  switch (acquisition.evidence) {
    case "linked_transaction":
      return `Bought ${acquisition.acquiredOn} · ${formatMoney(acquisition.costCents ?? 0)} · transaction #${acquisition.transactionId ?? "?"}`;
    case "inferred_from_category":
      return `Bought ${acquisition.acquiredOn} (inferred) · ${formatMoney(acquisition.costCents ?? 0)} · transaction #${acquisition.transactionId ?? "?"}`;
    case "asset_created_at":
      return `Held since ${acquisition.acquiredOn} — no purchase recorded`;
  }
}

/**
 * Does this asset contribute to net worth on `asOfKey`?
 *
 * The temporal half of the conversion model: before the acquisition day a
 * holding contributes exactly 0, not its current value. `asOfKey` is a
 * PARAMETER — this function never reads the clock.
 */
export function isHeldOn(acquiredOn: DateKey, asOfKey: DateKey): boolean {
  if (!isDateKey(acquiredOn)) throw new Error(`Invalid acquiredOn: ${String(acquiredOn)}`);
  if (!isDateKey(asOfKey)) throw new Error(`Invalid asOfKey: ${String(asOfKey)}`);
  return acquiredOn <= asOfKey;
}
