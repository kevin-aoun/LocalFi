"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
  LockKeyhole,
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
import { VaultSessionCoordinator } from "@/components/vault/vault-session-coordinator";

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
  const router = useRouter();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [netWorth, setNetWorth] = useState<NetWorthView | null>(null);
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [assets, setAssets] = useState<SidebarAssetRow[]>([]);
  const [userName, setUserName] = useState("Demo");
  const [showLedger, setShowLedger] = useState(false);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [locking, setLocking] = useState(false);

  const load = useCallback(async () => {

    try {
      const [netWorthData, accountsData, assetsData, settingsData] = await Promise.all([
        getNetWorth(),

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
    const refreshFinancialData = () => {
      void load();
    };
    window.addEventListener("localfi:financial-updated", refreshFinancialData);
    return () => window.removeEventListener("localfi:financial-updated", refreshFinancialData);
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

  const view = netWorth ? buildSidebarView({ netWorth, accounts, assets }) : null;

  const lockVault = async () => {
    setLocking(true);
    try {
      const response = await fetch("/api/vault/lock", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("Could not contact the vault lock endpoint.");
      router.push("/vault");
      router.refresh();
    } catch (error) {
      console.error("Failed to lock the vault:", error);
      setLoadError(error instanceof Error ? error.message : "Could not lock the vault.");
      setLocking(false);
    }
  };

  return (
    <div className="flex h-screen w-72 flex-col border-r bg-card">
      <VaultSessionCoordinator />
      {}
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <BadgeDollarSign className="h-6 w-6 text-primary" aria-hidden="true" />
        <span className="text-lg font-semibold">LocalFi</span>
      </div>

      {}
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

      {}
      <div data-privacy-content className="flex-1 overflow-y-auto">
        <div className="space-y-1 px-3 py-4">
          <div className="mb-2 flex items-center justify-between px-3">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
              Net worth
            </h3>
            {}
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
                      {}
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

      {}
      <div className="border-t p-4 space-y-3">
        <div className="flex items-center justify-between px-1">
          <span className="text-xs text-muted-foreground">Display</span>
          <div className="flex items-center gap-1">
            <PrivacyToggle />
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Lock LocalFi"
              title="Lock LocalFi"
              disabled={locking}
              onClick={() => void lockVault()}
            >
              <LockKeyhole className="h-4 w-4" aria-hidden="true" />
            </Button>
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
