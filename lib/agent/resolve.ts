/**
 * Deterministic name resolution: a free string from the model -> a real row id.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * The model is never handed an enum. Needle's schema dialect has no enum keyword
 * (see lib/agent/tool-schema.ts), and a 26M-parameter model asked to reproduce
 * one of fifteen exact category names will not do it reliably. So `category`,
 * `account` and `asset` arrive as free text — "groceries", "grocery", "Grocery
 * Shopping" — and matching them to a row is OUR job, done here, with a fixed
 * ladder of rules and no fuzzy tie-breaking:
 *
 *   1. exact       — case-insensitive, whitespace-trimmed
 *   2. normalized  — case, punctuation, diacritics and inner whitespace folded
 *   3. prefix      — a unique row whose name STARTS WITH the query
 *   4. substring   — a unique row whose name CONTAINS the query
 *   5. otherwise   — ambiguous (tied rows) or not-found (closest candidates)
 *
 * THE RULE THAT MATTERS: when a stage matches two different rows, this module
 * returns `ambiguous` and the caller must ask. It never picks the first, the
 * shortest or the most recently used. Silently choosing between "Groceries" and
 * "Gifts" for "g" is how money lands in the wrong category, and a wrong category
 * is invisible: it corrupts a budget, a breakdown and a savings rate at once,
 * and nothing in the UI flags it.
 *
 * A missing name is a QUESTION, never an insert. This module cannot create a
 * category (it takes rows as an argument and returns a verdict), which is the
 * structural version of that promise — see rule 4 in lib/agent/tools.ts on
 * bounding the blast radius by omission.
 *
 * Pure by construction: candidate rows are passed in, never fetched, so every
 * rule above is unit-testable without a database.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * Anything with an id and a display name.
 *
 * `aliases` exists because some rows have no single name: a standalone asset row
 * carries a category ("Commodities"), an optional note ("Grandma's ring"), a
 * commodity type ("Gold") and a price symbol ("XAU"), and the user may say any
 * of them. Aliases participate in every stage; a match on two aliases of the
 * SAME row is not ambiguous.
 */
export type Resolvable = {
  id: number;
  name: string;
  aliases?: readonly (string | null | undefined)[];
};

/** Which rung of the ladder produced a match. Useful for logging and tests. */
export type MatchKind = "exact" | "normalized" | "prefix" | "substring";

export type Resolution<T extends Resolvable> =
  | { status: "resolved"; query: string; row: T; matchedOn: MatchKind }
  /** Two or more DIFFERENT rows tied at the same stage. The caller must ask. */
  | { status: "ambiguous"; query: string; matchedOn: MatchKind; candidates: T[] }
  /** Nothing matched. `suggestions` are the closest rows, possibly empty. */
  | { status: "not-found"; query: string; suggestions: T[] };

export type ResolveOptions = {
  /** How many suggestions to return with a `not-found`. Default 3. */
  maxSuggestions?: number;
  /**
   * Minimum similarity (0..1) for a row to be suggested. Default 0.4 — below
   * that the "did you mean" is noise and it is better to list what exists.
   */
  minSimilarity?: number;
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Case-fold and trim only — the cheapest comparison, used by the exact stage. */
function fold(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Fold a name to its comparison form: lowercase, diacritics stripped,
 * punctuation turned into spaces, inner whitespace collapsed.
 *
 *   "  Groceries & Household  " -> "groceries household"
 *   "Café"                      -> "cafe"
 *   "Kid's school-fees"         -> "kid s school fees"
 *
 * Punctuation becomes a SPACE rather than being deleted, so "school-fees" and
 * "school fees" agree while "abc" and "a-b-c" do not silently collapse into one
 * token. Deliberately does not stem or de-pluralize: "gift" vs "gifts" is
 * handled by the prefix stage, where a tie is still reported as ambiguous.
 */
export function normalizeName(value: string): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    // Combining marks left behind by NFD (the accents themselves).
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Every string a row may be called, in priority order, blanks dropped. */
export function namesOf(row: Resolvable): string[] {
  const out: string[] = [];
  for (const candidate of [row.name, ...(row.aliases ?? [])]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed !== "" && !out.some((seen) => fold(seen) === fold(trimmed))) out.push(trimmed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Similarity, for "did you mean"
// ---------------------------------------------------------------------------

/** Classic Levenshtein distance, two rolling rows. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Similarity of two normalized names, 0..1.
 *
 * Edit-distance ratio, lifted when the two share a whole word: "grocery run" vs
 * "Groceries" is far apart character-wise but obviously related, and a shared
 * token is the signal a human would use.
 */
function similarity(query: string, candidate: string): number {
  if (query === "" || candidate === "") return 0;
  const longest = Math.max(query.length, candidate.length);
  const ratio = 1 - editDistance(query, candidate) / longest;

  const queryTokens = new Set(query.split(" "));
  const shared = candidate.split(" ").some((token) => queryTokens.has(token));
  return shared ? Math.max(ratio, 0.6) : ratio;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Rows in input order, one entry per id. */
function dedupe<T extends Resolvable>(rows: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/**
 * Resolve `query` against `rows`.
 *
 * Never throws and never guesses: the outcome is always one of resolved /
 * ambiguous / not-found, and the caller turns the last two into a question.
 */
export function resolveName<T extends Resolvable>(
  query: string,
  rows: readonly T[],
  options?: ResolveOptions,
): Resolution<T> {
  const maxSuggestions = options?.maxSuggestions ?? 3;
  const minSimilarity = options?.minSimilarity ?? 0.4;
  const raw = typeof query === "string" ? query : "";
  const folded = fold(raw);
  const normalized = normalizeName(raw);

  // A blank query cannot match anything, and it must not fall through to the
  // prefix stage — every name starts with "".
  if (normalized === "") {
    return { status: "not-found", query: raw, suggestions: [] };
  }

  const stages: Array<{ kind: MatchKind; test: (candidate: string) => boolean }> = [
    { kind: "exact", test: (candidate) => fold(candidate) === folded },
    { kind: "normalized", test: (candidate) => normalizeName(candidate) === normalized },
    { kind: "prefix", test: (candidate) => normalizeName(candidate).startsWith(normalized) },
    { kind: "substring", test: (candidate) => normalizeName(candidate).includes(normalized) },
  ];

  for (const stage of stages) {
    const hits = dedupe(rows.filter((row) => namesOf(row).some(stage.test)));
    if (hits.length === 1) {
      return { status: "resolved", query: raw, row: hits[0], matchedOn: stage.kind };
    }
    if (hits.length > 1) {
      return { status: "ambiguous", query: raw, matchedOn: stage.kind, candidates: hits };
    }
  }

  // Nothing matched: rank what exists so the caller can say "did you mean".
  const scored = rows
    .map((row) => ({
      row,
      score: Math.max(...namesOf(row).map((name) => similarity(normalized, normalizeName(name))), 0),
    }))
    .filter((entry) => entry.score >= minSimilarity)
    .sort((a, b) => b.score - a.score || rows.indexOf(a.row) - rows.indexOf(b.row))
    .slice(0, maxSuggestions)
    .map((entry) => entry.row);

  return { status: "not-found", query: raw, suggestions: scored };
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

/** "Groceries", "Groceries or Gifts", "Groceries, Gifts or Gas". */
export function listNames(rows: readonly Resolvable[], limit = 8): string {
  const names = rows.slice(0, limit).map((row) => row.name);
  const rest = rows.length - names.length;
  const joined =
    names.length <= 1
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return rest > 0 ? `${joined} (+${rest} more)` : joined;
}

/**
 * The question to ask when a name did not resolve to exactly one row.
 *
 * `label` is the noun as the user would say it ("category", "account", "asset").
 * An ambiguous name lists the tie; an unknown name suggests the closest rows, or
 * lists what exists when nothing is close — because "I don't know that one" with
 * no options is a dead end for the user.
 */
export function describeResolution(
  resolution: Resolution<Resolvable>,
  label: string,
  all: readonly Resolvable[] = [],
): string {
  if (resolution.status === "resolved") return "";
  const asked = resolution.query.trim();

  if (resolution.status === "ambiguous") {
    return (
      `"${asked}" matches more than one ${label}: ${listNames(resolution.candidates)}. ` +
      `Which one? Nothing was saved.`
    );
  }
  if (resolution.suggestions.length > 0) {
    return (
      `I don't have a ${label} called "${asked}". Did you mean ${listNames(resolution.suggestions)}? ` +
      `Nothing was saved.`
    );
  }
  if (all.length === 0) {
    return `I don't have a ${label} called "${asked}", and there are no ${label} rows yet. Nothing was saved.`;
  }
  return (
    `I don't have a ${label} called "${asked}". Your ${label} options are ${listNames(all)}. ` +
    `Nothing was saved.`
  );
}
