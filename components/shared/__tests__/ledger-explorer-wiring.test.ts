import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const source = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

describe("Ledger explorer product wiring", () => {
  it("guards the direct route with the persisted preference and a Settings explanation", () => {
    const page = source("app/(dashboard)/ledger/page.tsx");
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page.indexOf("await getSettings()"))
      .toBeLessThan(page.indexOf("getLedgerExplorerPage()"));
    expect(page).toContain("if (!preferences.showLedger)");
    expect(page).toContain("Your append-only journal is still active");
    expect(page).toContain('href="/settings"');
    expect(page).toContain('"error" in verificationResult ? verificationResult.error : null');
  });

  it("commits replacement filters only after success and supersedes stale requests", () => {
    const explorer = source("components/ledger/ledger-explorer.tsx");
    const resultErrorBranch = explorer.indexOf('if ("error" in result)');
    const activeFilterCommit = explorer.indexOf("setActiveFilters(query.filters ?? {})");

    expect(activeFilterCommit).toBeGreaterThan(resultErrorBranch);
    expect(explorer).toContain("const requestId = ++pageRequestId.current");
    expect(explorer).toContain("requestId !== pageRequestId.current");
    expect(explorer).toContain("requestId === pageRequestId.current");
    expect(explorer).toContain("const requestId = ++verificationRequestId.current");
    expect(explorer).toContain("requestId !== verificationRequestId.current");
    expect(explorer).toContain("initialVerificationError");
    expect(explorer).toContain("setRetryRequest({ query, replace, targetEventId })");
    expect(explorer).not.toContain("LEDGER_EXPLORER_DEFAULT_PAGE_SIZE");
    expect(explorer).not.toContain("pageSize:");
  });

  it("re-fetches database settings after a successful toggle and updates the sidebar immediately", () => {
    const settings = source("app/(dashboard)/settings/page.tsx");
    const sidebar = source("components/shared/sidebar.tsx");
    const persistedRead = settings.indexOf("const persisted = await getSettings()");
    const notification = settings.indexOf('new Event("localfi:settings-updated")');
    expect(persistedRead).toBeGreaterThan(settings.indexOf("if (!ok)"));
    expect(notification).toBeGreaterThan(persistedRead);
    expect(settings).toContain("setShowLedger(previous)");
    expect(sidebar).toContain('window.addEventListener("localfi:settings-updated"');
    expect(sidebar).toContain("const settingsData = await getSettings()");
    expect(sidebar).toContain('item.name !== "Ledger" || showLedger');
  });

  it("uses the frozen virtualized linked-timeline design with bounded loaded DOM", () => {
    const explorer = source("components/ledger/ledger-explorer.tsx");
    expect(explorer).toContain('from "@/lib/ledger/explorer-contract"');
    expect(explorer).not.toContain('from "@/lib/ledger/explorer"');
    expect(explorer).toContain("useVirtualizer({");
    expect(explorer).toContain("getItemKey: (index) => events[index]?.eventId");
    expect(explorer).toContain("overscan: 5");
    expect(explorer).toContain("ref={virtualizer.measureElement}");
    expect(explorer).toContain("virtualizer.measure()");
    expect(explorer).toContain("Load older");
    expect(explorer).toContain("ArrowDown");
    expect(explorer).not.toMatch(/react-?flow/i);
  });

  it("masks values and purges deferred payload state as soon as privacy activates", () => {
    const explorer = source("components/ledger/ledger-explorer.tsx");
    expect(explorer).toContain("data-privacy-exempt");
    expect(explorer).toContain("{event.description || \"Journal event\"}");
    expect(explorer).toContain("privateValue(signedMoney");
    expect(explorer).toContain("privateValue(signedQuantity");
    expect(explorer).toContain("privacyEnabled || !browserReady");
    expect(explorer).toContain("shouldRequestLedgerEventPayload");
    expect(explorer).toContain("getLedgerEventPayload(eventId)");
    expect(explorer).toContain("payloadRequestGeneration.current += 1");
    expect(explorer).toContain("setPayloads({})");
    expect(explorer).toContain("Canonical payload and metadata are hidden while privacy mode is on.");
    expect(explorer).not.toMatch(/aria-label=\{[^}]*signedMoney/);
    expect(explorer).not.toMatch(/aria-label=\{[^}]*quantityDelta/);
  });

  it("loads, expands, scrolls to, and focuses amended events outside the loaded virtual page", () => {
    const explorer = source("components/ledger/ledger-explorer.tsx");
    expect(explorer).toContain("onNavigateToAmended");
    expect(explorer).toContain("{ filters: { search: event.amendsEventId } }");
    expect(explorer).toContain("setExpanded(targetEventId ? new Set([targetEventId]) : new Set())");
    expect(explorer).toContain("virtualizer.scrollToIndex(index, { align: \"center\" })");
    expect(explorer).toContain("watchLedgerToggleMount");
    expect(explorer).toContain("new MutationObserver(onMutation)");
    expect(explorer).toContain("target.focus({ preventScroll: true })");
    expect(explorer).toContain("The amended event loaded, but its toggle did not mount");
    expect(explorer).toContain("retryRequest.targetEventId");
    expect(explorer).not.toContain("requestAnimationFrame");
    expect(explorer).not.toContain('href={`#ledger-event-${event.amendsEventId}`}');
  });

  it("queries raw ledger tables without importing the collapsed current-movement reader", () => {
    const query = source("lib/ledger/explorer.ts");
    expect(query).toContain("FROM ledger_events e");
    expect(query).toContain("FROM ledger_movements m");
    expect(query).toContain("ORDER BY e.sequence DESC, m.position ASC");
    expect(query).not.toContain("readCurrentMovements");
    expect(query).not.toContain("readPositionStates");
  });
});
