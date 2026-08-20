import path from "node:path";

export type ValidationCommandId =
  | "lint"
  | "typecheck"
  | "test"
  | "test:tz"
  | "python"
  | "check"
  | "build"
  | "compose";

export type ValidationCommand = {
  id: ValidationCommandId;
  executable: "node" | "bun" | "python3" | "docker";
  args: string[];
  reason: string;
};

export type ValidationPlan = {
  files: string[];
  commands: ValidationCommand[];
  validateGuidance: boolean;
  notes: string[];
};

export type ValidationPlanOptions = {
  full?: boolean;
  exists?: (repoRelativePath: string) => boolean;
};

const TOOLING_CONFIG = new Set([
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "vitest.config.ts",
  "eslint.config.mjs",
  "next.config.ts",
  "tailwind.config.ts",
  "postcss.config.mjs",
]);

const BUILD_CONFIG = new Set([
  "package.json",
  "bun.lock",
  "next.config.ts",
  "tailwind.config.ts",
  "postcss.config.mjs",
]);

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function normalizeRepoPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function isGuidancePath(file: string): boolean {
  return (
    file === "AGENTS.md" ||
    file === "CLAUDE.md" ||
    file.startsWith(".claude/rules/") ||
    file.startsWith(".cursor/rules/")
  );
}

function isDocumentation(file: string): boolean {
  return /\.(?:md|mdc|txt)$/i.test(file);
}

function isLintable(file: string): boolean {
  return /\.(?:[cm]?[jt]s|tsx)$/i.test(file);
}

function isTypeScriptProjectFile(file: string): boolean {
  return /\.(?:[cm]?[jt]s|tsx)$/i.test(file) || TOOLING_CONFIG.has(file);
}

function isDatabasePath(file: string): boolean {
  return (
    file.startsWith("lib/db/") ||
    file.startsWith("drizzle/") ||
    /^scripts\/(?:db|ledger)-/.test(file) ||
    file === "scripts/backfill-history.ts"
  );
}

function isDateOrLedgerPath(file: string): boolean {
  return (
    file === "lib/dates.ts" ||
    file.startsWith("lib/ledger/") ||
    file.startsWith("components/ledger/") ||
    file === "app/actions/ledger.ts" ||
    /^scripts\/ledger-/.test(file) ||
    /^drizzle\/migrations\/[^/]*ledger/i.test(file)
  );
}

function isComposePath(file: string): boolean {
  return file === "Dockerfile" || file === "docker-compose.yml" || file === "agent/Dockerfile";
}

function testCandidates(file: string): string[] {
  if (/\/__tests__\/.*\.test\.(?:ts|tsx)$/.test(file)) return [file];

  const parts = file.split("/");
  const stem = path.posix.basename(file).replace(/\.(?:[cm]?[jt]s|tsx)$/, "");

  if (parts[0] === "components" && parts[1]) {
    return [`components/${parts[1]}/__tests__`];
  }

  if (parts[0] === "app" && parts[1] === "(dashboard)" && parts[2]) {
    return [`app/(dashboard)/${parts[2]}/__tests__`];
  }

  if (parts[0] === "app" && parts[1] === "actions") {
    if (parts[2] === "budgets") return ["app/actions/__tests__/budgets"];
    if (parts[2] && parts[2] !== "__tests__") {
      return [
        `app/actions/__tests__/${stem}.test.ts`,
        `app/actions/__tests__/${stem}.test.tsx`,
        `app/actions/__tests__/${stem}`,
      ];
    }
  }

  if (parts[0] === "app" && parts[1] === "api" && parts[2] === "agent") {
    return ["lib/agent/__tests__"];
  }

  if (parts[0] === "lib" && ["agent", "db", "history", "ledger"].includes(parts[1] ?? "")) {
    return [`lib/${parts[1]}/__tests__`];
  }

  if (parts[0] === "lib" && parts[1] === "investments") {
    return [
      "app/actions/__tests__/assets-investments.test.ts",
      "components/reports/__tests__/investment-history.test.ts",
    ];
  }

  if (parts[0] === "lib" && parts.length === 2) {
    return [`lib/__tests__/${stem}.test.ts`, `lib/__tests__/${stem}.test.tsx`];
  }

  if (file === "scripts/agent-cli.ts") return ["lib/agent/__tests__"];
  if (/^scripts\/ledger-/.test(file)) return ["lib/ledger/__tests__"];

  if (parts[0] === "scripts" && parts.length === 2) {
    return [
      `scripts/__tests__/${stem}.test.ts`,
      `scripts/__tests__/${stem.replace(/-logic$/, "")}.test.ts`,
    ];
  }

  if (parts[0] === "agent" && file.endsWith(".py")) {
    return ["lib/agent/__tests__/needle-client.test.ts"];
  }

  if (parts[0] === "eval") return ["eval/__tests__"];
  return [];
}

function command(
  id: ValidationCommandId,
  executable: ValidationCommand["executable"],
  args: string[],
  reason: string,
): ValidationCommand {
  return { id, executable, args, reason };
}

export function planValidation(
  inputFiles: readonly string[],
  options: ValidationPlanOptions = {},
): ValidationPlan {
  const exists = options.exists ?? (() => true);
  const files = uniqueSorted(inputFiles.map(normalizeRepoPath).filter(Boolean));
  const validateGuidance = options.full === true || files.some(isGuidancePath);

  if (options.full) {
    return {
      files,
      validateGuidance,
      notes: ["Full validation requested; focused checks are subsumed by the release gates."],
      commands: [
        command("check", "bun", ["run", "check"], "complete lint, typecheck, and test suite"),
        command("build", "bun", ["run", "build"], "production compilation"),
        command("compose", "docker", ["compose", "config", "--quiet"], "Compose configuration"),
      ],
    };
  }

  const commands: ValidationCommand[] = [];
  const notes: string[] = [];
  const existingFiles = files.filter(exists);
  const toolingChanged = files.some((file) => TOOLING_CONFIG.has(file));
  const buildChanged = files.some((file) => BUILD_CONFIG.has(file) || file.endsWith(".css"));
  const composeChanged = files.some(isComposePath);
  const lintFiles = existingFiles.filter(isLintable);
  const typedCodeChanged = files.some(isTypeScriptProjectFile);
  const pythonFiles = existingFiles.filter((file) => file.endsWith(".py"));
  const databaseChanged = files.some(isDatabasePath);
  const dateOrLedgerChanged = files.some(isDateOrLedgerPath);
  const evalCorpusChanged = files.some((file) => file.startsWith("eval/") && file.endsWith(".jsonl"));
  const nonDocumentationChanged = files.some((file) => !isDocumentation(file));

  if (toolingChanged) {
    commands.push(command("check", "bun", ["run", "check"], "tooling configuration affects the whole project"));
  } else if (typedCodeChanged) {
    if (lintFiles.length > 0) {
      commands.push(
        command(
          "lint",
          "node",
          ["node_modules/eslint/bin/eslint.js", ...lintFiles],
          "changed JavaScript/TypeScript files",
        ),
      );
    }
    commands.push(command("typecheck", "bun", ["run", "typecheck"], "cross-file TypeScript contracts"));
  }

  if (pythonFiles.length > 0) {
    commands.push(
      command(
        "python",
        "python3",
        [
          "-c",
          "import pathlib,sys; [compile(pathlib.Path(p).read_text(), p, 'exec') for p in sys.argv[1:]]",
          ...pythonFiles,
        ],
        "changed Python files parse without writing bytecode",
      ),
    );
  }

  if (!toolingChanged) {
    const candidates = new Set<string>();
    for (const file of files) {
      for (const candidate of testCandidates(file)) {
        if (exists(candidate)) candidates.add(candidate);
      }
    }
    if (databaseChanged && exists("lib/db/__tests__")) candidates.add("lib/db/__tests__");
    if (evalCorpusChanged && exists("eval/__tests__")) candidates.add("eval/__tests__");

    const testTargets = uniqueSorted(candidates);
    const testableCodeChanged = files.some((file) => /\.(?:[cm]?[jt]s|tsx|sql|jsonl)$/i.test(file));
    if (testTargets.length > 0) {
      commands.push(
        command(
          "test",
          "node",
          ["node_modules/vitest/vitest.mjs", "run", ...testTargets],
          "nearest affected regression suites",
        ),
      );
    } else if (testableCodeChanged) {
      commands.push(command("test", "bun", ["run", "test"], "no reliable focused test mapping exists"));
      notes.push("No focused test target matched; using the complete test suite.");
    }
  }

  if (dateOrLedgerChanged) {
    commands.push(command("test:tz", "bun", ["run", "test:tz"], "date/ledger behavior is timezone-sensitive"));
  }
  if (buildChanged && !toolingChanged) {
    commands.push(command("build", "bun", ["run", "build"], "build or stylesheet boundary changed"));
  } else if (buildChanged) {
    commands.push(command("build", "bun", ["run", "build"], "build configuration changed"));
  }
  if (composeChanged) {
    commands.push(command("compose", "docker", ["compose", "config", "--quiet"], "container configuration changed"));
  }

  if (files.length > 0 && commands.length === 0) {
    notes.push(
      nonDocumentationChanged
        ? "No safe automated check is mapped to these files; review them directly."
        : "Documentation-only change; no application-wide command selected.",
    );
  }

  return { files, commands, validateGuidance, notes };
}
