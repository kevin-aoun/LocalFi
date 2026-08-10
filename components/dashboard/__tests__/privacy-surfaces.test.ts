import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("privacy-sensitive dashboard surfaces", () => {
  it("uses fixed private input styling and tags the text opening balance", () => {
    const css = read("app/globals.css");
    const accountDialog = read("components/accounts/account-dialog.tsx");
    expect(css).toContain("input[data-private-input]");
    expect(css).not.toContain("-webkit-text-security");
    expect(css).toContain("hsl(var(--foreground))");
    expect(css).not.toContain("currentColor");
    expect(accountDialog).toContain("data-private-input");
    expect(accountDialog).toContain("data-private-value");
  });

  it("keeps hidden-holding action labels free of amounts", () => {
    const source = read("components/dashboard/asset-table-card.tsx");
    expect(source).toContain("aria-label={`Show ${holding.name} again`}");
    expect(source).not.toContain("aria-label={`Show ${holding.name} (${holding.amountLabel}) again`}");
  });

  it("marks imported descriptions as prose exemptions", () => {
    expect(read("components/transactions/import-dialog.tsx")).toContain(
      'data-privacy-exempt>{row.comment}',
    );
  });

  it("marks rendered quick-command comments as prose and keeps purchase-link UI removed", () => {
    expect(read("components/assets/asset-dialog.tsx")).not.toContain("candidate.comment");
    expect(read("components/settings/quick-commands-manager.tsx")).toContain(
      'className="text-muted-foreground text-xs" data-privacy-exempt',
    );
  });
});
