

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

  start: number;
  end: number;
  kind: SiteKind;

  skip?: SkipReason;

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

const CONNECTIVE = new Set([

  "and", "but", "so", "or", "nor", "yet", "plus", "then",

  "not", "never", "rather", "instead", "neither", "no longer",

  "which", "who", "whom", "whose", "because", "when", "whenever", "while",
  "where", "since", "until", "unless", "except", "if", "after", "before",
  "although", "though", "as",

  "including", "excluding", "meaning", "giving", "leaving", "making", "using",
  "keeping", "returning",

  "i.e.", "ie", "e.g.", "eg", "namely", "viz.",

  "for", "with", "without", "from", "in", "on", "at", "by", "to", "of",
  "about", "over", "under", "per", "via", "against", "into", "onto",
]);

const CLAUSE_STARTER = new Set([

  "it", "they", "them", "this", "that", "these", "those", "there", "we",
  "you", "he", "she", "i", "nothing", "everything", "something", "anything",
  "nobody", "everyone", "someone",

  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had",
  "do", "does", "did", "can", "could", "will", "would", "shall", "should",
  "must", "may", "might", "let", "lets",

  "see", "use", "note", "check", "read", "add", "record", "keep", "treat",
  "prefer", "run", "call", "pass", "ask", "look", "compare", "start", "stop",
  "make", "give", "take", "put", "write", "remove", "delete", "fix", "avoid",
]);

function lineStartOf(text: string, index: number): number {
  const nl = text.lastIndexOf("\n", index - 1);
  return nl + 1;
}

function isBlank(s: string): boolean {
  return /^[ \t\r]*$/.test(s);
}

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

function spaceRunBefore(text: string, dashIndex: number, lower: number): number {
  let i = dashIndex;
  while (i > lower && (text[i - 1] === " " || text[i - 1] === "\t")) i -= 1;
  return i;
}

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

export function findSegments(text: string, fileName: string): Segment[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
     true,
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

    pushCommentsAt(node.pos);
    pushCommentsAt(node.end);

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

  const overlapsLiteral = (seg: Segment) =>
    literals.some((lit) => seg.start < lit.end && lit.start < seg.end);

  const realComments = comments.filter((c) => !overlapsLiteral(c));

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

function isGlyphSegment(text: string, seg: Segment): boolean {
  if (seg.interpolated) return false;
  const body = text.slice(seg.start, seg.end);
  if (!DASH_RE.test(body)) return false;
  return body.replace(/[—–―]/g, "").trim() === "";
}

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


function isLabelSeparator(text: string, seg: Segment, dashIndex: number): boolean {
  const lineStart = Math.max(lineStartOf(text, dashIndex), seg.start);
  let label = text.slice(lineStart, dashIndex);

  if (seg.kind === "comment") {




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


function isTightRange(text: string, dashIndex: number, seg: Segment): boolean {
  const before = dashIndex - 1 >= seg.start ? text[dashIndex - 1] : "";
  const after = dashIndex + 1 < seg.end ? text[dashIndex + 1] : "";
  return /\d/.test(before) && /\d/.test(after);
}

const DATE_OPERAND = /(?:\d{1,4}|[A-Z][a-z]{2,8}\s+\d{1,2}(?:,\s*\d{4})?|\$\{[^}]*\})\s*$/;
const DATE_OPERAND_AHEAD = /^\s*(?:\d{1,4}|[A-Z][a-z]{2,8}\s+\d{1,2}|\$\{[^}]*\})/;


function isSpacedRange(text: string, dashIndex: number, seg: Segment, dash: DashChar): boolean {
  if (dash !== "en") return false;



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



    const from = spaceRunBefore(text, dashIndex, seg.start);
    if (text.slice(from, dashIndex).includes("\n")) return null;
    return { edits: [{ start: from, end: afterEnd, text: punctuation + space }] };
  }

  if (!text.slice(anchor, dashIndex).includes("\n")) {
    return { edits: [{ start: anchor, end: afterEnd, text: punctuation + space }] };
  }




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


function avoidColonCollision(text: string, dashIndex: number, seg: Segment, rule: Rule): Rule {
  if (rule !== "label-colon" && rule !== "appositive-colon") return rule;

  const floor = seg.interpolated ? 0 : seg.start;
  const ceiling = seg.interpolated ? text.length : seg.end;
  const lineStart = Math.max(floor, text.lastIndexOf("\n", dashIndex) + 1);
  const lineBreak = text.indexOf("\n", dashIndex);
  const lineEnd = lineBreak < 0 ? ceiling : Math.min(ceiling, lineBreak);
  const line = text.slice(lineStart, lineEnd);



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


    if (isQuotedGlyph(text, seg, index)) {
      skipOne(index, "glyph");
      continue;
    }


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


    const next = indices[cursor + 1];
    if (
      next !== undefined &&
      (!options.dashes || options.dashes.has(dashName(text[next]))) &&
      isParentheticalPair(text, seg, index, next)
    ) {
      const gap = text.slice(index + 1, next);



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

  totals: Record<DashChar, number>;
}


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

      const [head, tail] = probe.split(text[i]);
      if (probe.length < MIN_PROBE_LENGTH) continue;
      if ((head ?? "").trim().length < 4 || (tail ?? "").trim().length < 4) continue;
      probes.push({ index: i, probe });
    }
  }
  return probes;
}
