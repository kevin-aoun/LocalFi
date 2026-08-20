

import fs from "node:fs";
import path from "node:path";
import {
  findSegments,
  type DashChar,
  type SiteKind,
  type SourcePlan,
  collisionProbes,
  planSource,
} from "./strip-em-dashes-logic";

const ROOT = process.cwd();
const DEFAULT_ROOTS = ["app", "components", "lib"];
const EXCLUDED_DIRS = new Set(["node_modules", ".next", "data", "drizzle", ".git"]);
const BACKUP_ROOT = ".strip-em-dashes-backups";
const HELP = `Usage: strip-em-dashes [options]

Options:
  --write                 apply changes after creating backups
  --dry-run               preview changes (default)
  --include-tests         include __tests__ directories
  --only=comments|strings|jsx|all
  --dashes=em,en,bar
  --paths=app,components,lib
  --show=<count>
  --quiet
`;

interface Options {
  write: boolean;
  kinds?: ReadonlySet<SiteKind>;
  dashes?: ReadonlySet<DashChar>;
  includeTests: boolean;
  roots: string[];
  show: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    write: false,
    includeTests: false,
    roots: DEFAULT_ROOTS,
    show: Number.POSITIVE_INFINITY,
    quiet: false,
  };

  for (const arg of argv) {
    if (arg === "--write") options.write = true;
    else if (arg === "--dry-run") options.write = false;
    else if (arg === "--include-tests") options.includeTests = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg.startsWith("--only=")) {
      const value = arg.slice("--only=".length);
      if (value !== "all") {
        const map: Record<string, SiteKind> = {
          comments: "comment",
          comment: "comment",
          strings: "string",
          string: "string",
          jsx: "jsx",
        };
        const kinds = value.split(",").map((v) => map[v.trim()]);
        if (kinds.some((k) => !k)) fail(`--only accepts comments|strings|jsx|all, got "${value}"`);
        options.kinds = new Set(kinds);
      }
    } else if (arg.startsWith("--dashes=")) {
      const allowed: DashChar[] = ["em", "en", "bar"];
      const values = arg.slice("--dashes=".length).split(",").map((v) => v.trim() as DashChar);
      if (values.some((v) => !allowed.includes(v))) fail(`--dashes accepts em,en,bar`);
      options.dashes = new Set(values);
    } else if (arg.startsWith("--paths=")) {
      options.roots = arg.slice("--paths=".length).split(",").map((v) => v.trim()).filter(Boolean);
    } else if (arg.startsWith("--show=")) {
      options.show = Number(arg.slice("--show=".length));
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else {
      fail(`unknown argument "${arg}" (try --help)`);
    }
  }

  return options;
}

function fail(message: string): never {
  process.stderr.write(`strip-em-dashes: ${message}\n`);
  process.exit(2);
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

function isTestFile(file: string): boolean {
  return file.split(path.sep).includes("__tests__");
}

function discover(options: Options): { files: string[]; testFiles: string[] } {
  const all: string[] = [];
  for (const root of options.roots) walk(path.join(ROOT, root), all);
  all.sort();
  const testFiles = all.filter(isTestFile);
  const files = options.includeTests ? all : all.filter((f) => !isTestFile(f));
  return { files, testFiles };
}

const rel = (file: string) => path.relative(ROOT, file);

interface Hunk {
  line: number;
  before: string[];
  after: string[];
}

function lineHunks(original: string, transformed: string): Hunk[] {
  const a = original.split("\n");
  const b = transformed.split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) {
      current = null;
      continue;
    }
    if (current && current.line + current.before.length === i + 1) {
      current.before.push(a[i]);
      current.after.push(b[i]);
      continue;
    }
    current = { line: i + 1, before: [a[i]], after: [b[i]] };
    hunks.push(current);
  }
  return hunks;
}

function backupAll(files: string[]): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(ROOT, BACKUP_ROOT, stamp);
  for (const file of files) {
    const target = path.join(dir, rel(file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    const copied = fs.readFileSync(target, "utf8");
    if (copied !== fs.readFileSync(file, "utf8")) {
      throw new Error(`backup of ${rel(file)} does not match the original`);
    }
  }
  return dir;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const { files, testFiles } = discover(options);

  const plans = new Map<string, SourcePlan>();
  const totals = { em: 0, en: 0, bar: 0 };
  const changedByKind: Record<SiteKind, number> = { comment: 0, string: 0, jsx: 0 };
  const changedByDash: Record<DashChar, number> = { em: 0, en: 0, bar: 0 };
  const changedByRule = new Map<string, number>();
  const skippedByReason = new Map<string, number>();
  const lineCountBroken: string[] = [];
  let ambiguous = 0;

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (!/[—–―]/.test(text)) continue;
    const plan = planSource(text, file, { kinds: options.kinds, dashes: options.dashes });

    totals.em += plan.totals.em;
    totals.en += plan.totals.en;
    totals.bar += plan.totals.bar;
    for (const skip of plan.skips) {
      skippedByReason.set(skip.reason, (skippedByReason.get(skip.reason) ?? 0) + 1);
    }
    if (plan.changes.length === 0) continue;

    if (plan.original.split("\n").length !== plan.transformed.split("\n").length) {
      lineCountBroken.push(rel(file));
      continue;
    }

    for (const change of plan.changes) {
      changedByKind[change.kind] += 1;
      changedByDash[change.dash] += 1;
      changedByRule.set(change.rule, (changedByRule.get(change.rule) ?? 0) + 1);
      if (change.ambiguous) ambiguous += 1;
    }
    plans.set(file, plan);
  }

  if (!options.quiet) {
    for (const [file, plan] of plans) {
      const hunks = lineHunks(plan.original, plan.transformed);
      process.stdout.write(`\n--- a/${rel(file)}\n+++ b/${rel(file)}\n`);
      const shown = hunks.slice(0, options.show);
      for (const hunk of shown) {
        const rules = plan.changes
          .filter((c) => c.line >= hunk.line && c.line < hunk.line + hunk.before.length)
          .map((c) => `${c.kind}/${c.rule}`);
        process.stdout.write(
          `@@ -${hunk.line},${hunk.before.length} +${hunk.line},${hunk.after.length} @@ ${[...new Set(rules)].join(" ")}\n`,
        );
        for (const line of hunk.before) process.stdout.write(`-${line}\n`);
        for (const line of hunk.after) process.stdout.write(`+${line}\n`);
      }
      if (hunks.length > shown.length) {
        process.stdout.write(`... ${hunks.length - shown.length} more hunk(s)\n`);
      }
    }
  }

  const collisions: { source: string; test: string; probe: string }[] = [];
  const suspects: { source: string; test: string }[] = [];
  const testTexts = testFiles.map((file) => {
    const text = fs.readFileSync(file, "utf8");


    const inAssertions = /[—–―]/.test(text)
      ? findSegments(text, file).some(
          (seg) => seg.kind !== "comment" && !seg.skip && /[—–―]/.test(text.slice(seg.start, seg.end)),
        )
      : false;
    return { file, text, inAssertions };
  });

  for (const [file, plan] of plans) {
    if (isTestFile(file)) continue;
    const changedIndices = new Set(plan.changes.filter((c) => c.kind !== "comment").map((c) => c.index));


    const probes = new Set(
      collisionProbes(plan.original, file)
        .filter((p) => changedIndices.has(p.index))
        .map((p) => p.probe),
    );
    for (const probe of probes) {
      for (const test of testTexts) {
        if (test.text.includes(probe)) collisions.push({ source: rel(file), test: rel(test.file), probe });
      }
    }




    if (changedIndices.size === 0) continue;
    const base = path.basename(file).replace(/\.tsx?$/, "");
    for (const test of testTexts) {
      if (path.basename(test.file) !== `${base}.test.ts`) continue;
      if (!test.inAssertions) continue;
      if (collisions.some((c) => c.source === rel(file) && c.test === rel(test.file))) continue;
      suspects.push({ source: rel(file), test: rel(test.file) });
    }
  }

  const found = totals.em + totals.en + totals.bar;
  const changed = plans.size === 0 ? 0 : [...plans.values()].reduce((n, p) => n + p.changes.length, 0);

  const out: string[] = [];
  out.push("");
  out.push("=".repeat(72));
  out.push(options.write ? "WRITE" : "DRY RUN (default) — nothing will be written without --write");
  out.push("=".repeat(72));
  out.push(`roots               ${options.roots.join(", ")}`);
  out.push(`__tests__           ${options.includeTests ? "INCLUDED (--include-tests)" : "EXCLUDED by default"}`);
  out.push(`--only              ${options.kinds ? [...options.kinds].join(",") : "all"}`);
  out.push(`--dashes            ${options.dashes ? [...options.dashes].join(",") : "em,en,bar"}`);
  out.push("");
  out.push(`files scanned       ${files.length}`);
  out.push(`files with changes  ${plans.size}`);
  out.push(`sites found         ${found}  (em ${totals.em}, en ${totals.en}, bar ${totals.bar})`);
  out.push(`sites changed       ${changed}  (em ${changedByDash.em}, en ${changedByDash.en}, bar ${changedByDash.bar})`);
  out.push(
    `  by site kind      comment ${changedByKind.comment}, string ${changedByKind.string}, jsx ${changedByKind.jsx}`,
  );
  for (const [rule, count] of [...changedByRule].sort((a, b) => b[1] - a[1])) {
    out.push(`  ${rule.padEnd(18)}${count}`);
  }
  out.push(`sites skipped       ${found - changed}`);
  for (const [reason, count] of [...skippedByReason].sort((a, b) => b[1] - a[1])) {
    out.push(`  ${reason.padEnd(18)}${count}`);
  }
  out.push(`ambiguous changes   ${ambiguous}  (user-visible text that fell through to the default colon)`);

  if (lineCountBroken.length > 0) {
    out.push("");
    out.push(`!! ${lineCountBroken.length} file(s) DROPPED because the rewrite changed the line count:`);
    for (const file of lineCountBroken) out.push(`   ${file}`);
  }

  out.push("");
  if (collisions.length === 0 && suspects.length === 0) {
    out.push("test collisions     none detected");
  }
  if (collisions.length > 0) {
    out.push(`!! TEST COLLISIONS (certain)  ${collisions.length} — the test asserts the exact string being rewritten:`);
    for (const c of collisions) {
      out.push(`   ${c.source}`);
      out.push(`     asserted in ${c.test}`);
      out.push(`     ${JSON.stringify(c.probe)}`);
    }
  }
  if (suspects.length > 0) {
    out.push("");
    out.push(
      `!! TEST COLLISIONS (likely)   ${suspects.length} — user-facing copy changes here and the matching test still contains a dash`,
    );
    out.push("   (interpolated copy such as `${start} – ${end}` cannot be matched literally; check these by hand):");
    for (const s of suspects) out.push(`   ${s.source}  <->  ${s.test}`);
  }
  if (collisions.length > 0 || suspects.length > 0) {
    out.push("   Fix the tests in the same commit, or re-run with --include-tests.");
  }

  process.stdout.write(`${out.join("\n")}\n`);

  if (!options.write) {
    process.stdout.write("\nDry run only. Re-run with --write to apply.\n");
    return;
  }
  if (plans.size === 0) {
    process.stdout.write("\nNothing to write.\n");
    return;
  }

  let backupDir: string;
  try {
    backupDir = backupAll([...plans.keys()]);
  } catch (error) {
    process.stderr.write(`\nREFUSING TO WRITE: backup failed — ${String(error)}\n`);
    process.exit(1);
  }
  process.stdout.write(`\nBackup of every file about to change: ${rel(backupDir)}\n`);

  for (const [file, plan] of plans) fs.writeFileSync(file, plan.transformed, "utf8");
  process.stdout.write(`Wrote ${plans.size} file(s).\n`);
}

main();
