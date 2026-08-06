/**
 * Pure transformation logic for `scripts/strip-em-dashes.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A GLOBAL SEARCH-AND-REPLACE
 * ---------------------------------------------------------------------------
 * An em dash does several unrelated jobs. Replacing every one of them with the
 * same character produces copy that is worse than what it replaced:
 *
 *     "Nothing is re-derived here — that is what keeps this page honest"
 *       -> " - "   reads like a bullet list that lost its bullet
 *       -> ","     splices two independent clauses
 *       -> ";"     correct
 *
 * So each dash is classified by (a) WHERE it sits (comment / string / JSX text
 * / code) and (b) WHAT FOLLOWS it, and only then rewritten.
 *
 * ---------------------------------------------------------------------------
 * RULE TABLE  (first match wins, top to bottom)
 * ---------------------------------------------------------------------------
 * | # | Rule                | Trigger                                    | Result    |
 * |---|---------------------|--------------------------------------------|-----------|
 * | 0 | skip: code          | dash is not inside a comment/string/JSX     | untouched |
 * | 0 | skip: module/type/  | import path, `LiteralType`, property key,   | untouched |
 * |   |   key/attr          | `data-*`/`className`/`key`/... attribute    |           |
 * | 1 | skip: glyph         | the WHOLE literal is dashes+space ("—")     | untouched |
 * |   |                     | it is a VALUE ("no data"), not punctuation  |           |
 * |1b | skip: quoted glyph  | the dash is inside `...`, "..." or '...'    | untouched |
 * |   |                     | with nothing else in it: the prose is       |           |
 * |   |                     | NAMING the character, not using it          |           |
 * | 2 | range               | tight digit-dash-digit, e.g. `5–15`         | `-`       |
 * | 2 | range (spaced)      | en dash between two date/number operands    | ` - `     |
 * | 3 | pair -> commas      | two dashes, short gap, no `.?!` between     | `,` `,`   |
 * | 3 | pair -> parentheses | ...and the gap already contains a comma     | `(` `)`   |
 * | 4 | label separator     | short line-leading label (UI string, JSX,   | `:`       |
 * |   |                     | or a doc bullet), <=40 chars, no comma      |           |
 * | 5 | connective          | follower is a coordinator (and/but/so/or/   | `,`       |
 * |   |                     | plus), a contrast (not/never/instead), a    |           |
 * |   |                     | subordinator (which/because/when/as), a     |           |
 * |   |                     | participle (including), a preposition, or   |           |
 * |   |                     | an appositive marker (i.e./e.g./namely)     |           |
 * | 6 | independent clause  | follower starts a clause: pronoun (it/that/ | `;`       |
 * |   |                     | they/there/nothing), auxiliary (is/has/     |           |
 * |   |                     | can/must), or an imperative (see/use/note)  |           |
 * | 7 | appositive (default)| anything else — overwhelmingly a determiner | `:`       |
 * |   |                     | ("the"/"a"/"an"), i.e. a noun phrase that   |           |
 * |   |                     | explains what came before                   |           |
 *
 * Rule 7 is the safe default: a colon is grammatical wherever an em dash
 * introduced an explanation, and it never splices two clauses the way a comma
 * would. Sites that reach rule 7 inside USER-VISIBLE text (string/JSX) are
 * flagged `ambiguous` so they can be eyeballed rather than trusted silently.
 *
 * The word lists in rules 5 and 6 were derived from this repository: the
 * frequency of the first word after each of its 906 em dashes was measured, and
 * the head of that distribution ("the" 139, "a" 58, "so" 37, "and" 39, "never"
 * 27, "it" 22, "not" 20, "see" 19, "which" 14, ...) is what the lists cover.
 *
 * ---------------------------------------------------------------------------
 * SPACING CONTRACT
 * ---------------------------------------------------------------------------
 * Punctuation attaches to the word BEFORE the dash and is followed by exactly
 * one space ("path — the" -> "path: the"). Never a doubled space, never a
 * trailing space at end of line. When the dash begins a line inside a block
 * comment, the punctuation is appended to the previous line and the dash is
 * deleted in place, so the `*` gutter and the line count are preserved. The
 * transform never adds or removes a newline; the caller asserts that.
 *
 * Idempotent by construction: a rewritten site no longer contains a dash, and
 * a skipped site is skipped identically on every run.
 */

import ts from "typescript";

export const EM_DASH = "—";
export const EN_DASH = "–";
export const HORIZONTAL_BAR = "―";

const DASH_RE = /[—–―]/;

export type DashChar = "em" | "en" | "bar";
export type SiteKind = "comment" | "string" | "jsx";

export function dashName(ch: string): DashChar {
  if (ch === EM_DASH) return "em";
  if (ch === EN_DASH) return "en";
  return "bar";
}

export type Rule =
  | "range"
  | "pair-commas"
  | "pair-parens"
  | "label-colon"
  | "connective-comma"
  | "clause-semicolon"
  | "appositive-colon";

export type SkipReason =
  | "code"
  | "module-specifier"
  | "type-literal"
  | "property-key"
  | "jsx-attribute"
  | "glyph"
  | "filtered-kind"
  | "filtered-dash"
  | "no-anchor-text";

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface Change {
  index: number;
  line: number;
  column: number;
  kind: SiteKind;
  dash: DashChar;
  rule: Rule;
  ambiguous: boolean;
  /** A one-line window around the dash, for reporting. */
  probe: string;
}

export interface Skip {
  index: number;
  line: number;
  column: number;
  kind: SiteKind | "code";
  dash: DashChar;
  reason: SkipReason;
  probe: string;
}

export interface Segment {
  /** Inner content range: comment/quote delimiters already excluded. */
  start: number;
  end: number;
  kind: SiteKind;
  /** Set when the segment exists only so its dashes get a precise skip reason. */
  skip?: SkipReason;
  /** True for TemplateHead/Middle/Tail: dash-only content is a separator, not a glyph. */
  interpolated?: boolean;
}

export interface Plan {
  edits: Edit[];
  changes: Change[];
  skips: Skip[];
}

export interface PlanOptions {
  kinds?: ReadonlySet<SiteKind>;
  dashes?: ReadonlySet<DashChar>;
}

/* -------------------------------------------------------------------------- */
/* Word classes                                                               */
/* -------------------------------------------------------------------------- */

/** Rule 5: the dash was doing a comma's job. */
const CONNECTIVE = new Set([
  // coordinators
  "and", "but", "so", "or", "nor", "yet", "plus", "then",
  // contrast / negation
  "not", "never", "rather", "instead", "neither", "no longer",
  // subordinators
  "which", "who", "whom", "whose", "because", "when", "whenever", "while",
  "where", "since", "until", "unless", "except", "if", "after", "before",
  "although", "though", "as",
  // participles used as appositive heads
  "including", "excluding", "meaning", "giving", "leaving", "making", "using",
  "keeping", "returning",
  // appositive markers
  "i.e.", "ie", "e.g.", "eg", "namely", "viz.",
  // prepositions
  "for", "with", "without", "from", "in", "on", "at", "by", "to", "of",
  "about", "over", "under", "per", "via", "against", "into", "onto",
]);

/** Rule 6: what follows is an independent clause. */
const CLAUSE_STARTER = new Set([
  // pronouns and expletives
  "it", "they", "them", "this", "that", "these", "those", "there", "we",
  "you", "he", "she", "i", "nothing", "everything", "something", "anything",
  "nobody", "everyone", "someone",
  // NOTE: "all", "both", "each", "either" and "them" are deliberately absent.
  // They head a noun phrase ("— all of them") far more often than they subject
  // a clause, and a semicolon in front of a noun phrase is simply wrong.
  // auxiliaries and copulas
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had",
  "do", "does", "did", "can", "could", "will", "would", "shall", "should",
  "must", "may", "might", "let", "lets",
  // imperatives that show up in this codebase's asides
  "see", "use", "note", "check", "read", "add", "record", "keep", "treat",
  "prefer", "run", "call", "pass", "ask", "look", "compare", "start", "stop",
  "make", "give", "take", "put", "write", "remove", "delete", "fix", "avoid",
]);

/* -------------------------------------------------------------------------- */
/* Text scanning helpers                                                      */
/* -------------------------------------------------------------------------- */

function lineStartOf(text: string, index: number): number {
  const nl = text.lastIndexOf("\n", index - 1);
  return nl + 1;
}

function isBlank(s: string): boolean {
  return /^[ \t\r]*$/.test(s);
}

/**
 * True when `i` holds a comment continuation marker (`*` or the second `/` of
 * `//`) rather than a real character of prose. A `*` only counts when the whole
 * line up to it is blank, so markdown emphasis (`*before*`) is left alone.
 */
function markerLengthAt(text: string, i: number, lower: number): number {
  if (i < lower) return 0;
  const c = text[i];
  if (c === "*") {
    return isBlank(text.slice(lineStartOf(text, i), i)) ? 1 : 0;
  }
  if (c === "/" && i - 1 >= lower && text[i - 1] === "/") {
    return isBlank(text.slice(lineStartOf(text, i - 1), i - 1)) ? 2 : 0;
  }
  return 0;
}

/**
 * Walk backwards from `from` over whitespace and comment gutters. Returns the
 * index just AFTER the last real character of prose, or -1 when the segment has
 * no prose before this point.
 */
function anchorBefore(text: string, from: number, lower: number): number {
  let i = from - 1;
  while (i >= lower) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i -= 1;
      continue;
    }
    const marker = markerLengthAt(text, i, lower);
    if (marker > 0) {
      i -= marker;
      continue;
    }
    return i + 1;
  }
  return -1;
}

/**
 * Walk forwards from `from` over whitespace and comment gutters. Returns the
 * index of the next real character of prose, or -1.
 */
function anchorAfter(text: string, from: number, upper: number): number {
  let i = from;
  while (i < upper) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i += 1;
      continue;
    }
    if (c === "*" && isBlank(text.slice(lineStartOf(text, i), i))) {
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/" && isBlank(text.slice(lineStartOf(text, i), i))) {
      i += 2;
      continue;
    }
    return i;
  }
  return -1;
}

/** Trailing spaces/tabs after the dash, and whether the line ends right there. */
function spaceRunAfter(
  text: string,
  dashIndex: number,
  upper: number,
): { end: number; atEol: boolean; hadSpace: boolean } {
  let i = dashIndex + 1;
  let hadSpace = false;
  while (i < upper && (text[i] === " " || text[i] === "\t")) {
    hadSpace = true;
    i += 1;
  }
  const atEol = i < text.length && (text[i] === "\n" || text[i] === "\r") && i <= upper;
  return { end: i, atEol, hadSpace };
}

/** Start of the whitespace run immediately before the dash, on the same line. */
function spaceRunBefore(text: string, dashIndex: number, lower: number): number {
  let i = dashIndex;
  while (i > lower && (text[i - 1] === " " || text[i - 1] === "\t")) i -= 1;
  return i;
}

/** The word that follows the dash, lowercased, with trailing punctuation kept and stripped. */
function followerWord(text: string, at: number, upper: number): { raw: string; bare: string } {
  const m = /^\S+/.exec(text.slice(at, upper));
  const raw = (m ? m[0] : "").toLowerCase();
  const bare = raw.replace(/^[("'`*_[]+/, "").replace(/[)"'`*_\],;:]+$/, "");
  return { raw, bare };
}

function normalizeProse(s: string): string {
  return s.replace(/\n[ \t]*(?:\*|\/\/)?[ \t]?/g, " ");
}

function probeAround(text: string, index: number): string {
  const from = Math.max(lineStartOf(text, index), index - 48);
  const nl = text.indexOf("\n", index);
  const to = Math.min(nl === -1 ? text.length : nl, index + 48);
  return text.slice(from, to).trim();
}

/* -------------------------------------------------------------------------- */
/* Segment discovery (TypeScript AST)                                         */
/* -------------------------------------------------------------------------- */

/**
 * JSX attributes whose value is machine-readable, not prose. A dash in any of
 * these is either meaningful or invisible; either way, do not touch it.
 * Everything NOT listed (title, placeholder, aria-label, description, label,
 * alt, ...) is treated as user-visible text.
 */
const CODE_JSX_ATTRIBUTES = new Set([
  "classname", "class", "key", "id", "href", "src", "srcset", "style", "type",
  "name", "value", "htmlfor", "d", "viewbox", "fill", "stroke", "role", "rel",
  "target", "accept", "pattern", "form", "action", "method", "as", "sizes",
  "media", "charset", "content", "property", "http-equiv", "datatype",
]);

function jsxAttributeIsCode(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("data-") || CODE_JSX_ATTRIBUTES.has(lower);
}

function literalSkipReason(node: ts.StringLiteralLike): SkipReason | undefined {
  const parent = node.parent;
  if (!parent) return undefined;

  if (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) return "module-specifier";
  if (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) return "module-specifier";
  if (ts.isImportTypeNode(parent)) return "module-specifier";
  if (ts.isExternalModuleReference(parent)) return "module-specifier";
  if (ts.isModuleDeclaration(parent) && parent.name === node) return "module-specifier";
  if (
    ts.isCallExpression(parent) &&
    parent.arguments[0] === node &&
    (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(parent.expression) && parent.expression.text === "require"))
  ) {
    return "module-specifier";
  }

  if (ts.isLiteralTypeNode(parent)) return "type-literal";

  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return "property-key";
  }
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return "property-key";
  if (ts.isComputedPropertyName(parent)) return "property-key";

  if (ts.isJsxAttribute(parent) && parent.initializer === node) {
    const name = ts.isIdentifier(parent.name) ? parent.name.text : parent.name.getText();
    return jsxAttributeIsCode(name) ? "jsx-attribute" : undefined;
  }

  return undefined;
}

/**
 * Every range of a source file that holds prose. Delimiters (`/**`, `*&#47;`,
 * quotes, backticks, `${`) are excluded, so the returned ranges contain only
 * text a human reads.
 */
export function findSegments(text: string, fileName: string): Segment[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const literals: Segment[] = [];
  const comments: Segment[] = [];
  const seenComments = new Set<number>();

  const pushComment = (range: ts.CommentRange) => {
    if (seenComments.has(range.pos)) return;
    seenComments.add(range.pos);
    const isBlock = range.kind === ts.SyntaxKind.MultiLineCommentTrivia;
    const openLength = isBlock ? (text.startsWith("/**", range.pos) ? 3 : 2) : 2;
    const closeLength = isBlock ? 2 : 0;
    comments.push({
      start: range.pos + openLength,
      end: Math.max(range.pos + openLength, range.end - closeLength),
      kind: "comment",
    });
  };

  const pushCommentsAt = (position: number) => {
    for (const range of ts.getLeadingCommentRanges(text, position) ?? []) pushComment(range);
    for (const range of ts.getTrailingCommentRanges(text, position) ?? []) pushComment(range);
  };

  const visit = (node: ts.Node): void => {
    // Walk TOKENS, not just named children: a comment can sit in the trivia of
    // punctuation (`|` in a union type, `,` in an argument list), and
    // `forEachChild` never visits those, so those comments would be invisible.
    pushCommentsAt(node.pos);
    pushCommentsAt(node.end);

    // `{/* ... */}` in JSX holds no child token, so its comment is invisible to
    // the trivia walk above. Look inside the braces explicitly.
    if (ts.isJsxExpression(node) && !node.expression) {
      pushCommentsAt(node.getStart(sourceFile) + 1);
    }

    if (ts.isJsxText(node)) {
      literals.push({ start: node.getStart(sourceFile), end: node.end, kind: "jsx" });
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const start = node.getStart(sourceFile);
      literals.push({
        start: start + 1,
        end: node.end - 1,
        kind: "string",
        skip: literalSkipReason(node),
      });
    } else if (
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      const start = node.getStart(sourceFile);
      const trailing = node.kind === ts.SyntaxKind.TemplateTail ? 1 : 2;
      literals.push({
        start: start + 1,
        end: node.end - trailing,
        kind: "string",
        interpolated: true,
      });
    }

    for (const child of node.getChildren(sourceFile)) visit(child);
  };

  visit(sourceFile);
  pushCommentsAt(0);
  pushCommentsAt(sourceFile.endOfFileToken.pos);

  // A `//` or `/*` sitting inside JSX text or a string is not a comment. The
  // trivia scanner can be fooled by JSX children, so drop overlaps.
  const overlapsLiteral = (seg: Segment) =>
    literals.some((lit) => seg.start < lit.end && lit.start < seg.end);

  const realComments = comments.filter((c) => !overlapsLiteral(c));

  // Consecutive `//` lines are one thought. Merge them so a dash at the end of
  // one line can see the word that follows it on the next.
  realComments.sort((a, b) => a.start - b.start);
  const merged: Segment[] = [];
  for (const comment of realComments) {
    const previous = merged[merged.length - 1];
    if (previous && /^\r?\n[ \t]*\/\/[ \t]?$/.test(text.slice(previous.end, comment.start))) {
      previous.end = comment.end;
      continue;
    }
    merged.push(comment);
  }

  return [...merged, ...literals].sort((a, b) => a.start - b.start);
}

/* -------------------------------------------------------------------------- */
/* The transformation                                                         */
/* -------------------------------------------------------------------------- */

/** True when the literal is a dash used AS A VALUE, e.g. `formatShare(null) -> "—"`. */
function isGlyphSegment(text: string, seg: Segment): boolean {
  if (seg.interpolated) return false;
  const body = text.slice(seg.start, seg.end);
  if (!DASH_RE.test(body)) return false;
  return body.replace(/[—–―]/g, "").trim() === "";
}

/**
 * Rule 1b: the dash is QUOTED, so it is being named rather than used.
 *
 * Prose about the placeholder glyph is full of it:
 *
 *     lib/reports.ts:310
 *     A fraction as a percentage string, or "—" when there is no number
 *
 *     components/assets/currency-totals.ts
 *     `12.34%`, or `—` when the share is undefined.
 *
 * Rewriting those to `":"` or `` `:` `` documents the code incorrectly, which
 * is worse than leaving a dash in a comment. A delimited span on the dash's own
 * line that contains nothing but dashes is a reference to the character.
 */
function isQuotedGlyph(text: string, seg: Segment, dashIndex: number): boolean {
  const from = Math.max(lineStartOf(text, dashIndex), seg.start);
  const nl = text.indexOf("\n", dashIndex);
  const to = Math.min(nl === -1 ? text.length : nl, seg.end);
  const line = text.slice(from, to);
  const offset = dashIndex - from;

  for (const quote of ["`", '"', "'"]) {
    const pattern = new RegExp(`${quote}([^${quote}\\n]*)${quote}`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const start = match.index + 1;
      const end = start + match[1].length;
      if (offset < start || offset >= end) continue;
      if (match[1].replace(/[—–―]/g, "").trim() === "") return true;
    }
  }
  return false;
}

/** Rule 4: a short label at the head of a line, e.g. `Asset — money you hold`. */
function isLabelSeparator(text: string, seg: Segment, dashIndex: number): boolean {
  const lineStart = Math.max(lineStartOf(text, dashIndex), seg.start);
  let label = text.slice(lineStart, dashIndex);

  if (seg.kind === "comment") {
    // Only doc BULLETS carry labels; flowing prose does not. Note that `*` is
    // deliberately NOT a bullet character here: it is the JSDoc gutter, and
    // treating it as a bullet makes every single comment line look like a
    // label.
    const bullet = /^[ \t]*(?:\*[ \t]*)?(?:[-+•]|\d+\.)[ \t]+(.*)$/.exec(label);
    if (!bullet) return false;
    label = bullet[1];
  }

  label = label.trim();
  if (label === "") return false;
  if (label.length > 40) return false;
  if (/[,.;:!?]/.test(label)) return false;
  return true;
}

/** Rule 2: `5–15`, `2020—2024`. Tight on both sides, digits on both sides. */
function isTightRange(text: string, dashIndex: number, seg: Segment): boolean {
  const before = dashIndex - 1 >= seg.start ? text[dashIndex - 1] : "";
  const after = dashIndex + 1 < seg.end ? text[dashIndex + 1] : "";
  return /\d/.test(before) && /\d/.test(after);
}

const DATE_OPERAND = /(?:\d{1,4}|[A-Z][a-z]{2,8}\s+\d{1,2}(?:,\s*\d{4})?|\$\{[^}]*\})\s*$/;
const DATE_OPERAND_AHEAD = /^\s*(?:\d{1,4}|[A-Z][a-z]{2,8}\s+\d{1,2}|\$\{[^}]*\})/;

/** Rule 2 (spaced): an EN dash between two dates or numbers is a range, not punctuation. */
function isSpacedRange(text: string, dashIndex: number, seg: Segment, dash: DashChar): boolean {
  if (dash !== "en") return false;
  // `${start} – ${end}`: the operands are interpolated, so they are not visible
  // inside the segment. An EN dash alone between two substitutions is a range
  // by convention; an EM dash in the same position is a label separator.
  if (seg.interpolated && text.slice(seg.start, seg.end).replace(/[—–―]/g, "").trim() === "") {
    return true;
  }
  const before = text.slice(seg.start, dashIndex);
  const after = text.slice(dashIndex + 1, seg.end);
  return DATE_OPERAND.test(before) && DATE_OPERAND_AHEAD.test(after);
}

function attachLeft(
  text: string,
  dashIndex: number,
  seg: Segment,
  punctuation: string,
): { edits: Edit[] } | null {
  const anchor = anchorBefore(text, dashIndex, seg.start);
  const { end: afterEnd, atEol, hadSpace } = spaceRunAfter(text, dashIndex, seg.end);
  const atSegmentEnd = afterEnd >= seg.end;
  const space = atEol || (atSegmentEnd && !hadSpace) ? "" : " ";

  if (anchor < 0) {
    // Nothing precedes the dash inside this segment. That is normal for a
    // fragment like `" — day first"` or a `${a} — ${b}` separator: the
    // punctuation still belongs against whatever is concatenated before it.
    const from = spaceRunBefore(text, dashIndex, seg.start);
    if (text.slice(from, dashIndex).includes("\n")) return null;
    return { edits: [{ start: from, end: afterEnd, text: punctuation + space }] };
  }

  if (!text.slice(anchor, dashIndex).includes("\n")) {
    return { edits: [{ start: anchor, end: afterEnd, text: punctuation + space }] };
  }

  // The dash opens a line inside a block comment. Put the punctuation at the
  // end of the previous line and delete the dash where it stands, so the `*`
  // gutter and the line count survive.
  const rest = text.slice(afterEnd, seg.end);
  if (rest.trim() === "") return null;
  return {
    edits: [
      { start: anchor, end: anchor, text: punctuation },
      { start: dashIndex, end: afterEnd, text: "" },
    ],
  };
}

function attachRight(text: string, dashIndex: number, seg: Segment, punctuation: string): { edits: Edit[] } | null {
  const anchor = anchorBefore(text, dashIndex, seg.start);
  const { end: afterEnd } = spaceRunAfter(text, dashIndex, seg.end);
  if (anchor < 0 || text.slice(anchor, dashIndex).includes("\n")) {
    return { edits: [{ start: dashIndex, end: afterEnd, text: punctuation }] };
  }
  return { edits: [{ start: anchor, end: afterEnd, text: ` ${punctuation}` }] };
}

function classifyFollower(text: string, dashIndex: number, seg: Segment): Rule {
  const at = anchorAfter(text, dashIndex + 1, seg.end);
  if (at < 0) return "appositive-colon";
  const { raw, bare } = followerWord(text, at, seg.end);
  if (CONNECTIVE.has(bare) || CONNECTIVE.has(raw)) return "connective-comma";
  if (CLAUSE_STARTER.has(bare) || CLAUSE_STARTER.has(raw)) return "clause-semicolon";
  return "appositive-colon";
}

/**
 * Rule 8: do not put a second colon on a line that already has one.
 *
 * The colon rules are the safe default because a colon is grammatical wherever a
 * dash introduces an explanation, and unlike a comma it can never splice. But
 * "safe" is not the same as "readable". A log line like
 *
 *     `[prices] ${type}: ${code} — ${message}`
 *
 * becomes `[prices] gold: NETWORK: message` — three segments, two colons, and no
 * way to tell which one is the real separator. The dash was carrying a DIFFERENT
 * rank of separation than the colon beside it, and collapsing both to one glyph
 * destroys that hierarchy.
 *
 * So when a colon rule fires on a line that already contains a colon, step down
 * to a comma, or to a semicolon when the follower starts an independent clause
 * (where a comma would splice). Only the text on the dash's own line counts: a
 * colon three lines up in a JSDoc block is not a collision.
 *
 * ## Why interpolated segments are measured differently
 *
 * A template literal is split by the scanner into one segment per span, so the
 * dash in `` `[prices] ${type}: ${code} — ${msg}` `` sits in a segment whose
 * entire content is " — ". Clamping the search to that segment would find no
 * colon and miss the very collision this rule exists for. For those, widen to
 * the physical source line, which is where the reader sees the collision anyway.
 *
 * For an ordinary string the clamp is kept, because the colon in
 * `note: "in credit — overpaid"` belongs to the CODE, not to the sentence, and
 * the reader of that message never sees it.
 */
function avoidColonCollision(text: string, dashIndex: number, seg: Segment, rule: Rule): Rule {
  if (rule !== "label-colon" && rule !== "appositive-colon") return rule;

  const floor = seg.interpolated ? 0 : seg.start;
  const ceiling = seg.interpolated ? text.length : seg.end;
  const lineStart = Math.max(floor, text.lastIndexOf("\n", dashIndex) + 1);
  const lineBreak = text.indexOf("\n", dashIndex);
  const lineEnd = lineBreak < 0 ? ceiling : Math.min(ceiling, lineBreak);
  const line = text.slice(lineStart, lineEnd);

  // A `::` or a `?:` is TypeScript, not prose, and never a real collision here
  // because rule 0 already excluded code. Plain `:` is what we care about.
  if (!line.includes(":")) return rule;

  return classifyFollower(text, dashIndex, seg) === "clause-semicolon"
    ? "clause-semicolon"
    : "connective-comma";
}

const PUNCTUATION: Record<Rule, string> = {
  "range": "-",
  "pair-commas": ",",
  "pair-parens": "(",
  "label-colon": ":",
  "connective-comma": ",",
  "clause-semicolon": ";",
  "appositive-colon": ":",
};

/**
 * Rule 3: are these two dashes one parenthetical, or two separate asides?
 *
 * Length turns out to be a poor test. Measured over this repo, genuine pairs
 * run from 2 to 137 characters ("Every table — accounts, categories, ... and
 * settings — as readable JSON" is a real 106-character parenthetical), while
 * every FALSE pair is two dashes in adjacent bullets of a documentation list.
 * So the test is structural: no sentence break, no clause break, no bullet
 * marker and no paragraph break between the two dashes, and prose on both
 * sides. The length cap is only a sanity bound.
 */
const BULLET_IN_GAP = /(?:^|\n)[ \t]*(?:\*[ \t]*)?(?:[-+•]|\d+\.)[ \t]+/;
const PARAGRAPH_BREAK = /\n[ \t]*\*?[ \t]*\n/;

function isParentheticalPair(text: string, seg: Segment, open: number, close: number): boolean {
  const raw = text.slice(open + 1, close);
  const gap = normalizeProse(raw).trim();
  if (gap === "" || gap.length > 150) return false;
  if (/[.?!;:]/.test(gap)) return false;
  if (BULLET_IN_GAP.test(raw)) return false;
  if (PARAGRAPH_BREAK.test(raw)) return false;
  if (anchorBefore(text, open, seg.start) < 0) return false;
  if (anchorAfter(text, close + 1, seg.end) < 0) return false;
  return true;
}

/** Plan every dash inside one prose segment. */
function planSegment(
  text: string,
  seg: Segment,
  sourceFile: ts.SourceFile,
  options: PlanOptions,
): Plan {
  const plan: Plan = { edits: [], changes: [], skips: [] };
  const indices: number[] = [];
  for (let i = seg.start; i < seg.end; i += 1) {
    if (DASH_RE.test(text[i])) indices.push(i);
  }
  if (indices.length === 0) return plan;

  const position = (index: number) => {
    const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, index);
    return { line: line + 1, column: character + 1 };
  };

  const skipAll = (reason: SkipReason) => {
    for (const index of indices) {
      plan.skips.push({
        index,
        ...position(index),
        kind: seg.skip ? "code" : seg.kind,
        dash: dashName(text[index]),
        reason,
        probe: probeAround(text, index),
      });
    }
  };

  if (seg.skip) {
    skipAll(seg.skip);
    return plan;
  }
  if (isGlyphSegment(text, seg)) {
    skipAll("glyph");
    return plan;
  }
  if (options.kinds && !options.kinds.has(seg.kind)) {
    skipAll("filtered-kind");
    return plan;
  }

  const record = (index: number, rule: Rule, edits: Edit[], ambiguous: boolean) => {
    plan.edits.push(...edits);
    plan.changes.push({
      index,
      ...position(index),
      kind: seg.kind,
      dash: dashName(text[index]),
      rule,
      ambiguous,
      probe: probeAround(text, index),
    });
  };

  const skipOne = (index: number, reason: SkipReason) => {
    plan.skips.push({
      index,
      ...position(index),
      kind: seg.kind,
      dash: dashName(text[index]),
      reason,
      probe: probeAround(text, index),
    });
  };

  for (let cursor = 0; cursor < indices.length; cursor += 1) {
    const index = indices[cursor];
    const dash = dashName(text[index]);

    if (options.dashes && !options.dashes.has(dash)) {
      skipOne(index, "filtered-dash");
      continue;
    }

    // Rule 1b: the dash is quoted, so the prose is naming the character.
    if (isQuotedGlyph(text, seg, index)) {
      skipOne(index, "glyph");
      continue;
    }

    // Rule 2: ranges.
    if (isTightRange(text, index, seg)) {
      record(index, "range", [{ start: index, end: index + 1, text: "-" }], false);
      continue;
    }
    if (isSpacedRange(text, index, seg, dash)) {
      const anchor = anchorBefore(text, index, seg.start);
      const { end } = spaceRunAfter(text, index, seg.end);
      const from = anchor >= 0 ? anchor : spaceRunBefore(text, index, seg.start);
      if (!text.slice(from, index).includes("\n")) {
        record(index, "range", [{ start: from, end, text: " - " }], false);
        continue;
      }
    }

    // Rule 3: parenthetical pair.
    const next = indices[cursor + 1];
    if (
      next !== undefined &&
      (!options.dashes || options.dashes.has(dashName(text[next]))) &&
      isParentheticalPair(text, seg, index, next)
    ) {
      const gap = text.slice(index + 1, next);
      // Parentheses read better than commas when the enclosed span already has
      // commas in it. The one thing to avoid is an opening "(" stranded at the
      // end of a line, so require content after the opening dash on its line.
      const openerHasContentAfter = /^[ \t]*\S/.test(text.slice(index + 1, seg.end).split("\n")[0] ?? "");
      const useParens = gap.includes(",") && openerHasContentAfter;
      const open = useParens
        ? attachRight(text, index, seg, "(")
        : attachLeft(text, index, seg, ",");
      const close = useParens
        ? attachLeft(text, next, seg, ")")
        : attachLeft(text, next, seg, ",");
      if (open && close) {
        const rule: Rule = useParens ? "pair-parens" : "pair-commas";
        const ambiguous = normalizeProse(gap).trim().length > 90;
        record(index, rule, open.edits, ambiguous);
        record(next, rule, close.edits, ambiguous);
        cursor += 1;
        continue;
      }
    }

    // Rules 4-7: a single dash. Rule 8 then vetoes a colon that would land on a
    // line already carrying one.
    const chosen: Rule = isLabelSeparator(text, seg, index)
      ? "label-colon"
      : classifyFollower(text, index, seg);
    const rule = avoidColonCollision(text, index, seg, chosen);
    const result = attachLeft(text, index, seg, PUNCTUATION[rule]);
    if (!result) {
      skipOne(index, "no-anchor-text");
      continue;
    }
    const ambiguous = rule === "appositive-colon" && seg.kind !== "comment";
    record(index, rule, result.edits, ambiguous);
  }

  return plan;
}

export function applyEdits(text: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

export interface SourcePlan extends Plan {
  original: string;
  transformed: string;
  /** Dash characters present anywhere in the file, before any change. */
  totals: Record<DashChar, number>;
}

/** Plan (and apply, in memory) every change for one source file. */
export function planSource(text: string, fileName: string, options: PlanOptions = {}): SourcePlan {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const segments = findSegments(text, fileName);

  const plan: Plan = { edits: [], changes: [], skips: [] };
  const covered = new Set<number>();
  for (const seg of segments) {
    const segmentPlan = planSegment(text, seg, sourceFile, options);
    plan.edits.push(...segmentPlan.edits);
    plan.changes.push(...segmentPlan.changes);
    plan.skips.push(...segmentPlan.skips);
    for (let i = seg.start; i < seg.end; i += 1) covered.add(i);
  }

  const totals: Record<DashChar, number> = { em: 0, en: 0, bar: 0 };
  for (let i = 0; i < text.length; i += 1) {
    if (!DASH_RE.test(text[i])) continue;
    totals[dashName(text[i])] += 1;
    if (covered.has(i)) continue;
    // Not inside any comment, string or JSX text: this is code.
    const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, i);
    plan.skips.push({
      index: i,
      line: line + 1,
      column: character + 1,
      kind: "code",
      dash: dashName(text[i]),
      reason: "code",
      probe: probeAround(text, i),
    });
  }

  plan.changes.sort((a, b) => a.index - b.index);
  plan.skips.sort((a, b) => a.index - b.index);

  return {
    ...plan,
    original: text,
    transformed: applyEdits(text, plan.edits),
    totals,
  };
}

/**
 * A distinctive window of LITERAL text around a dash, used to pair a source
 * string with a test that asserts on it.
 *
 * Short windows are useless: `"— so"` occurs in half the test suite. Only a
 * window with enough real text on both sides of the dash can identify one
 * specific piece of user-facing copy, so anything shorter than
 * `MIN_PROBE_LENGTH` is dropped rather than reported as a false alarm.
 *
 * This cannot see through interpolation: in `` `${start} – ${end}` `` the
 * operands are code, so there is no literal to match. The caller pairs those
 * by FILE NAME instead.
 */
export const MIN_PROBE_LENGTH = 16;

export function collisionProbes(text: string, fileName: string): { index: number; probe: string }[] {
  const probes: { index: number; probe: string }[] = [];
  for (const seg of findSegments(text, fileName)) {
    if (seg.kind === "comment" || seg.skip) continue;
    for (let i = seg.start; i < seg.end; i += 1) {
      if (!DASH_RE.test(text[i])) continue;
      const from = Math.max(seg.start, lineStartOf(text, i), i - 30);
      const nl = text.indexOf("\n", i);
      const to = Math.min(seg.end, nl === -1 ? text.length : nl, i + 30);
      const probe = text.slice(from, to).trim();
      // Require real text on BOTH sides of the dash, not just a fragment.
      const [head, tail] = probe.split(text[i]);
      if (probe.length < MIN_PROBE_LENGTH) continue;
      if ((head ?? "").trim().length < 4 || (tail ?? "").trim().length < 4) continue;
      probes.push({ index: i, probe });
    }
  }
  return probes;
}
