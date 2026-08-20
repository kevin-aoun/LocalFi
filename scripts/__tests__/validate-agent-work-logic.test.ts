import { describe, expect, it } from "vitest";

import { planValidation } from "../validate-agent-work-logic";

function ids(files: string[], existing: string[] = files): string[] {
  const present = new Set(existing);
  return planValidation(files, { exists: (file) => present.has(file) }).commands.map((item) => item.id);
}

describe("agent work validation planning", () => {
  it("keeps guidance-only changes lightweight", () => {
    const plan = planValidation(["AGENTS.md", ".claude/rules/frontend.md"], {
      exists: () => true,
    });

    expect(plan.validateGuidance).toBe(true);
    expect(plan.commands).toEqual([]);
    expect(plan.notes).toContain("Documentation-only change; no application-wide command selected.");
  });

  it("selects lint, typecheck, and the nearest component tests", () => {
    expect(ids(
      ["components/budgets/budget-form-logic.ts"],
      ["components/budgets/budget-form-logic.ts", "components/budgets/__tests__"],
    )).toEqual(["lint", "typecheck", "test"]);
  });

  it("adds timezone coverage for date changes", () => {
    expect(ids(
      ["lib/dates.ts"],
      ["lib/dates.ts", "lib/__tests__/dates.test.ts"],
    )).toEqual(["lint", "typecheck", "test", "test:tz"]);
  });

  it("routes migrations to the database suite", () => {
    expect(ids(
      ["drizzle/migrations/0016_example.sql"],
      ["drizzle/migrations/0016_example.sql", "lib/db/__tests__"],
    )).toEqual(["test"]);
  });

  it("falls back to the complete test suite when no focused mapping exists", () => {
    const plan = planValidation(["app/providers.tsx"], {
      exists: (file) => file === "app/providers.tsx",
    });

    expect(plan.commands.map((item) => item.id)).toEqual(["lint", "typecheck", "test"]);
    expect(plan.commands.at(-1)?.args).toEqual(["run", "test"]);
  });

  it("uses release gates for full validation", () => {
    const plan = planValidation([], { full: true });
    expect(plan.validateGuidance).toBe(true);
    expect(plan.commands.map((item) => item.id)).toEqual(["check", "build", "compose"]);
  });
});
