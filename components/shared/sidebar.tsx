"use client";

/**
 * The app chrome: navigation, and a net-worth panel that is on every page.
 *
 * TWO BUGS THIS REPLACES
 *
 * 1. **The Assets section did nothing.** `toggleCategory` flipped the chevron and
 *    rendered no expanded content at all, and the `+` button had no `onClick`.
 *    Categories now expand into the individual holdings, and the dead button is
 *    gone — replaced by real links to the pages that own the records. Mounting
 *    `AssetDialog` here was the alternative and is wrong: this component lives in
 *    app/(dashboard)/layout.tsx, so the dialog would mount on every route, and on
 *    success only the sidebar could refresh — the dashboard keeps its asset list
 *    in a store and would have gone stale, which is the very disagreement bug 2
 *    is about.
 *
 * 2. **It was a second source of truth.** It called `getAssets()` and grouped the
 *    raw rows, which INCLUDES the derived `Cash` asset that `deriveNetWorth`
 *    deliberately excludes — so it printed a figure the home page had left out,
 *    and showed no accounts at all. It now reads `getNetWorth()` +
 *    `getAccountBalances()`, the same pair the dashboard and /accounts use.
 *
 * All grouping, ordering, subtotalling and phrasing lives in ./sidebar-assets.ts
 * (pure, unit-tested — there is no jsdom in this repo). This file only renders and
 * loads.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  ArrowLeftRight,
  Wallet,
  ChevronRight,
  ChevronDown,
  Landmark,
  Repeat,
  Settings as SettingsIcon,
  BarChart3,
  BadgeDollarSign,
  Globe,
  AlertTriangle,
  Info,
  SlidersHorizontal,
  ListTree,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getAssets } from "@/app/actions/assets";
import { getSettings } from "@/app/actions/settings";
import {
  getAccountBalances,
  getNetWorth,
  type AccountWithBalance,
  type NetWorthView,
} from "@/app/actions/accounts";
import { ThemeToggle } from "./theme-toggle";
import { PrivacyToggle } from "./privacy-toggle";
import { buildSidebarView, type SidebarAssetRow } from "./sidebar-assets";

const navigation = [
  { name: "Home", href: "/", icon: Home },
  { name: "Accounts", href: "/accounts", icon: Landmark },
  { name: "Transactions", href: "/transactions", icon: ArrowLeftRight },
  { name: "Recurring", href: "/recurring", icon: Repeat },
  { name: "Categories", href: "/budgets", icon: Wallet },
  { name: "Reports", href: "/reports", icon: BarChart3 },
  { name: "Travel", href: "/travel", icon: Globe },
  { name: "Ledger", href: "/ledger", icon: ListTree },
  { name: "Settings", href: "/settings", icon: SettingsIcon },
];

export function Sidebar() {
  const pathname = usePathname();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [netWorth, setNetWorth] = useState<NetWorthView | null>(null);
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [assets, setAssets] = useState<SidebarAssetRow[]>([]);
  const [userName, setUserName] = useState("Demo");
  const [showLedger, setShowLedger] = useState(false);
  /** Why the panel could not be loaded; null when there is nothing to report. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // NOTE: `syncCashAssetManually()` used to run here, on mount — a WRITE on
    // every page load. It is gone. The figures below come from `getNetWorth()`,
    // which derives from the ledger itself and EXCLUDES the derived Cash asset,
    // so syncing that row changes nothing rendered here; and every path that
    // touches the ledger (app/actions/transactions.ts, import.ts, recurring.ts)
    // already calls `syncCashAssetWithin` inside its own write transaction, so
    // the row is maintained at the source rather than by whoever opened a page.
    try {
      const [netWorthData, accountsData, assetsData, settingsData] = await Promise.all([
        getNetWorth(),
        // Archived accounts INCLUDED: their balances still count towards the net
        // worth shown here, so hiding them would make the rows stop adding up.
        getAccountBalances({ includeArchived: true }),
        getAssets(),
        getSettings(),
      ]);
      setNetWorth(netWorthData);
      setAccounts(accountsData);
      setAssets(assetsData);
      setUserName(settingsData.userName);
      setShowLedger(settingsData.showLedger);
      setLoadError(null);
    } catch (error) {
      // A rejected load used to leave the panel silently reading "No assets yet",
      // which is indistinguishable from an empty database.
      console.error("Failed to load the sidebar panel:", error);
      setLoadError(
        error instanceof Error ? error.message : "Could not load your accounts and assets.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refreshSettings = async () => {
      try {
        const settingsData = await getSettings();
        setUserName(settingsData.userName);
        setShowLedger(settingsData.showLedger);
      } catch (error) {
        console.error("Failed to refresh sidebar settings:", error);
      }
    };
    window.addEventListener("localfi:settings-updated", refreshSettings);
    return () => window.removeEventListener("localfi:settings-updated", refreshSettings);
  }, []);

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Pure: grouping, per-currency subtotals, liability presentation and the
  // headline formatting all come from ./sidebar-assets.ts. Net worth is ECHOED
  // from `getNetWorth()` and never re-derived here.
  const view = netWorth ? buildSidebarView({ netWorth, accounts, assets }) : null;

  return (
    <div className="flex h-screen w-72 flex-col border-r bg-card">
      {/* Header */}
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <BadgeDollarSign className="h-6 w-6 text-primary" aria-hidden="true" />
        <span className="text-lg font-semibold">LocalFi</span>
      </div>

      {/* Navigation */}
      <nav className="space-y-1 px-3 py-4">
        {navigation.filter((item) => item.name !== "Ledger" || showLedger).map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      <Separator className="mx-3" />

      {/* Net worth: the same figures as the home page and /accounts. */}
      <div data-privacy-content className="flex-1 overflow-y-auto">
        <div className="space-y-1 px-3 py-4">
          <div className="mb-2 flex items-center justify-between px-3">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
              Net worth
            </h3>
            {/* This replaces a `+` button that had no onClick at all. It goes to
                the page that owns accounts; each group below links to the page
                that owns its own records. */}
            <Button asChild variant="ghost" size="sm" className="h-6 w-6 p-0">
              <Link href="/accounts" aria-label="Manage accounts and assets">
                <SlidersHorizontal className="h-4 w-4" />
              </Link>
            </Button>
          </div>

          {loadError && (
            <div
              role="alert"
              className="mx-1 mb-2 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-2 text-xs text-destructive"
            >
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="flex-1">
                {loadError}{" "}
                <button
                  type="button"
                  onClick={() => {
                    setLoading(true);
                    void load();
                  }}
                  className="font-medium underline underline-offset-2"
                >
                  Retry
                </button>
              </span>
            </div>
          )}

          {loading && view === null && !loadError && (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              Loading…
            </div>
          )}

          {view && (
            <>
              <Link
                href="/accounts"
                className="mb-2 block rounded-lg px-3 py-2 transition-colors hover:bg-accent/50"
              >
                <div className="space-y-1">
                  {view.summaries.map((summary) => (
                    <div key={summary.currency}>
                      <div
                        className={cn(
                          "text-xl font-semibold",
                          summary.isNegative && "text-red-600 dark:text-red-400",
                        )}
                      >
                        {summary.netWorthLabel}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {summary.assetsLabel} held · {summary.liabilitiesLabel} owed
                      </div>
                    </div>
                  ))}
                </div>
              </Link>

              {view.isEmpty && (
                <div className="px-3 pb-2 text-xs text-muted-foreground">
                  No accounts or assets yet. Add an account to start tracking.
                </div>
              )}

              {view.groups.map((group) => {
                const isExpanded = expandedGroups.has(group.key);
                return (
                  <div key={group.key}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.key)}
                      aria-expanded={isExpanded}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent/50"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1 text-left">
                        <div className="truncate font-medium">{group.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {group.count} {group.count === 1 ? "item" : "items"}
                        </div>
                      </div>
                      {/*
                        This total sits INSIDE the group's expand/collapse
                        button, so the tooltip trigger must not be focusable:
                        a tab stop nested in a button is broken for keyboard
                        users, and Radix would put button semantics on it.

                        `aria-label` on the descendant is what carries the
                        explanation instead. Name-from-content walks into the
                        button's children and uses a child's `aria-label` in
                        place of its text, so the total AND the mixed-currency
                        caveat are both announced — the tooltip is only the
                        mouse user's copy. The total is repeated inside the
                        label because the label replaces the text it covers.
                      */}
                      <div
                        className="shrink-0 text-right text-sm font-semibold"
                        aria-label={
                          group.mixed
                            ? `${group.totalLabel}: mixed currencies (${group.currencies.join(", ")}), subtotalled separately, no exchange rates applied`
                            : undefined
                        }
                      >
                        {group.mixed ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block">
                                {group.totalLabel}
                                <span className="block text-[10px] font-normal text-amber-600 dark:text-amber-400">
                                  mixed currencies
                                </span>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              {`Mixed currencies (${group.currencies.join(", ")}): subtotalled separately, no exchange rates applied`}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          group.totalLabel
                        )}
                      </div>
                    </button>

                    {/* The block that was missing entirely: the individual
                        holdings behind the chevron. */}
                    {isExpanded && (
                      <div className="mb-1 ml-5 space-y-0.5 border-l pl-2">
                        {group.rows.length === 0 ? (
                          <p className="px-2 py-2 text-xs text-muted-foreground">
                            {group.emptyMessage}
                          </p>
                        ) : (
                          group.rows.map((row) => (
                            <div
                              key={row.key}
                              className="flex items-start justify-between gap-2 rounded-md px-2 py-1.5"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm">{row.name}</div>
                                {row.detail && (
                                  <div className="truncate text-[11px] text-muted-foreground">
                                    {row.detail}
                                  </div>
                                )}
                              </div>
                              <div className="shrink-0 text-right">
                                <div
                                  className={cn(
                                    "font-mono text-xs",
                                    row.tone === "negative" && "text-red-600 dark:text-red-400"
                                  )}
                                >
                                  {row.amountLabel}
                                </div>
                                {row.note && (
                                  <div className="text-[10px] text-muted-foreground">
                                    {row.note}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                        <Link
                          href={group.href}
                          className="block rounded-md px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {group.manageLabel} →
                        </Link>
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="space-y-1.5 px-3 pt-3 text-[11px] text-muted-foreground">
                {view.summaries
                  .filter((summary) => summary.hasUnassigned)
                  .map((summary) => (
                    <p key={summary.currency} className="flex items-start gap-1.5">
                      <Info className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        {summary.unassignedLabel} comes from transactions with no account in the{" "}
                        {summary.currency} bucket.
                      </span>
                    </p>
                  ))}
                {view.derivedCashCount > 0 && (
                  <p className="flex items-start gap-1.5">
                    <Info className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      Your derived Cash row ({view.derivedCashLabel}) is not listed: it
                      mirrors the same ledger your accounts do, so counting both would
                      double your cash.
                    </span>
                  </p>
                )}
                {view.mixed && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* `tabIndex` because a paragraph is not focusable and
                          Radix opens on hover or focus only. */}
                      <p
                        tabIndex={0}
                        className="flex items-start gap-1.5 rounded-sm text-amber-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:text-amber-400"
                      >
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>
                          Net worth is separated into {view.currencies.join(", ")} buckets.
                          No exchange rates are applied and no combined total exists.
                        </span>
                      </p>
                    </TooltipTrigger>
                    <TooltipContent>
                      Each displayed amount contains one currency only.
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="border-t p-4 space-y-3">
        <div className="flex items-center justify-between px-1">
          <span className="text-xs text-muted-foreground">Display</span>
          <div className="flex items-center gap-1">
            <PrivacyToggle />
            <ThemeToggle />
          </div>
        </div>
        <div data-privacy-content className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground font-semibold text-sm">
            {userName ? userName.substring(0, 2).toUpperCase() : "U"}
          </div>
          <div className="flex-1 text-sm">
            <div className="font-medium">{userName || "User"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
