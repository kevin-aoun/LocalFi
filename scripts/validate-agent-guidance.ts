import fs from "node:fs";
import path from "node:path";

type Frontmatter = Record<string, string | string[]>;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readFrontmatter(file: string): { data: Frontmatter; body: string } {
  const source = fs.readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);

  const data: Frontmatter = {};
  let listKey: string | null = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const listItem = /^\s+-\s+(.+)$/.exec(rawLine);
    if (listItem && listKey) {
      const current = data[listKey];
      if (!Array.isArray(current)) throw new Error(`${file}: malformed ${listKey} list`);
      current.push(unquote(listItem[1]));
      continue;
    }

    const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(rawLine);
    if (!field) continue;
    const [, key, rawValue] = field;
    if (rawValue.trim() === "") {
      data[key] = [];
      listKey = key;
    } else {
      data[key] = unquote(rawValue);
      listKey = null;
    }
  }
  return { data, body: match[2] };
}

function scalarList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function lineCount(source: string): number {
  return source === "" ? 0 : source.split(/\r?\n/).length;
}

export function validateAgentGuidance(repoRoot = process.cwd()): string[] {
  const errors: string[] = [];
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  const claudePath = path.join(repoRoot, "CLAUDE.md");
  const claudeRulesDir = path.join(repoRoot, ".claude", "rules");
  const cursorRulesDir = path.join(repoRoot, ".cursor", "rules");

  let agentsSource = "";
  if (!fs.existsSync(agentsPath)) errors.push("AGENTS.md is missing");
  else {
    agentsSource = fs.readFileSync(agentsPath, "utf8");
    if (lineCount(agentsSource) > 200) {
      errors.push("AGENTS.md exceeds the 200-line context budget");
    }
  }

  if (!fs.existsSync(claudePath)) errors.push("CLAUDE.md is missing");
  else if (!/^\s*@AGENTS\.md\s*$/m.test(fs.readFileSync(claudePath, "utf8"))) {
    errors.push("CLAUDE.md must import @AGENTS.md");
  }

  if (!fs.existsSync(claudeRulesDir)) {
    errors.push(".claude/rules is missing");
    return errors;
  }
  if (!fs.existsSync(cursorRulesDir)) {
    errors.push(".cursor/rules is missing");
    return errors;
  }

  const canonicalNames = fs.readdirSync(claudeRulesDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  const adapterNames = fs.readdirSync(cursorRulesDir)
    .filter((name) => name.endsWith(".mdc"))
    .sort();

  if (canonicalNames.length === 0) errors.push(".claude/rules has no canonical rules");

  for (const name of canonicalNames) {
    const stem = name.slice(0, -3);
    const canonicalPath = path.join(claudeRulesDir, name);
    const adapterName = `${stem}.mdc`;
    const adapterPath = path.join(cursorRulesDir, adapterName);

    try {
      const canonicalSource = fs.readFileSync(canonicalPath, "utf8");
      const canonical = readFrontmatter(canonicalPath);
      const paths = scalarList(canonical.data.paths);
      if (paths.length === 0) errors.push(`${name}: canonical rule must be path-scoped`);
      if (lineCount(canonicalSource) > 80) errors.push(`${name}: rule exceeds 80 lines`);
      if (!canonical.body.trim().startsWith("# ")) errors.push(`${name}: body needs a title`);
      if (agentsSource && !agentsSource.includes(`.claude/rules/${name}`)) {
        errors.push(`${name}: AGENTS.md must route non-Claude agents to this rule`);
      }

      if (!fs.existsSync(adapterPath)) {
        errors.push(`${name}: missing Cursor adapter ${adapterName}`);
        continue;
      }

      const adapter = readFrontmatter(adapterPath);
      const globs = scalarList(adapter.data.globs);
      if (adapter.data.alwaysApply !== "false") {
        errors.push(`${adapterName}: path-scoped adapter must set alwaysApply: false`);
      }
      if (typeof adapter.data.description !== "string" || !adapter.data.description.trim()) {
        errors.push(`${adapterName}: description is required`);
      }
      if (JSON.stringify(globs) !== JSON.stringify(paths)) {
        errors.push(`${adapterName}: globs must match ${name} paths in the same order`);
      }
      if (!adapter.body.includes(`@.claude/rules/${name}`)) {
        errors.push(`${adapterName}: adapter must reference the canonical Claude rule`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const adapterName of adapterNames) {
    const canonicalName = `${adapterName.slice(0, -4)}.md`;
    if (!canonicalNames.includes(canonicalName)) {
      errors.push(`${adapterName}: no matching canonical rule ${canonicalName}`);
    }
  }

  return errors;
}

export function assertAgentGuidance(repoRoot = process.cwd()): void {
  const errors = validateAgentGuidance(repoRoot);
  if (errors.length > 0) {
    throw new Error(`Agent guidance validation failed:\n- ${errors.join("\n- ")}`);
  }
}
