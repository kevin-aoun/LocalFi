"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";

import {
  getLedgerEventPayload,
  getLedgerExplorerPage,
  verifyLedgerIntegrity,
  type LedgerVerificationView,
} from "@/app/actions/ledger";
import { usePrivacyMode } from "@/components/shared/privacy-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { DateKey } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { PRIVACY_MASK_TOKEN } from "@/lib/privacy";
import {
  shouldRequestLedgerEventPayload,
  type LedgerEventPayload,
  type LedgerExplorerEvent,
  type LedgerExplorerFilters,
  type LedgerExplorerPage,
  type LedgerExplorerQuery,
} from "@/lib/ledger/explorer-contract";

type LedgerExplorerProps = {
  initialPage: LedgerExplorerPage | null;
  initialVerification: LedgerVerificationView | null;
  initialError?: string | null;
  initialVerificationError?: string | null;
};

const TARGET_LABELS = {
  real_account: "Account",
  category: "Category",
  instrument: "Instrument",
  system: "System",
} as const;

const subscribeToBrowser = () => () => {};

type EventPayloadState =
  | { status: "loading" }
  | { status: "loaded"; data: LedgerEventPayload }
  | { status: "error"; error: string };

type LedgerToggleMountWatcher = {
  observe: (container: HTMLElement, onMutation: () => void) => () => void;
  schedule: (callback: () => void, delay: number) => number;
  cancel: (handle: number) => void;
};

const defaultLedgerToggleMountWatcher: LedgerToggleMountWatcher = {
  observe: (container, onMutation) => {
    if (typeof MutationObserver === "undefined") return () => {};
    const observer = new MutationObserver(onMutation);
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  },
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  cancel: (handle) => window.clearTimeout(handle),
};

export function watchLedgerToggleMount(
  container: HTMLElement,
  eventId: string,
  onFocus: (target: HTMLButtonElement) => void,
  onTimeout: () => void,
  watcher: LedgerToggleMountWatcher = defaultLedgerToggleMountWatcher,
): () => void {
  let finished = false;
  let stopObserving = () => {};
  let timeoutHandle: number | null = null;

  const cleanup = () => {
    stopObserving();
    if (timeoutHandle !== null) watcher.cancel(timeoutHandle);
    timeoutHandle = null;
  };

  const finish = (callback: () => void) => {
    if (finished) return;
    finished = true;
    cleanup();
    callback();
  };

  const check = () => {
    const target = container.querySelector<HTMLButtonElement>(
      `#ledger-event-toggle-${eventId}`,
    );
    if (target?.tagName === "BUTTON") finish(() => onFocus(target));
  };

  stopObserving = watcher.observe(container, check);
  timeoutHandle = watcher.schedule(() => finish(onTimeout), 2000);
  check();
  return () => {
    finished = true;
    cleanup();
  };
}

function signedMoney(amountMinor: number, currency: string): string {
  const value = formatMoney(amountMinor, currency);
  return amountMinor > 0 ? `+${value}` : value;
}

function signedQuantity(quantity: string): string {
  return quantity.startsWith("-") ? quantity : `+${quantity}`;
}

function privateValue(value: string, privacyEnabled: boolean): string {
  return privacyEnabled ? PRIVACY_MASK_TOKEN : value;
}

function recordedDate(iso: string): string {
  return iso.replace("T", " ").replace(/\.000Z$/, " UTC");
}

function HashField({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string | null;
  onCopy: (value: string, label: string) => void;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <code data-privacy-exempt className="break-all rounded bg-muted px-2 py-1 text-[11px]">
        {value ?? "Genesis — no predecessor"}
      </code>
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 justify-self-start px-2"
          onClick={() => onCopy(value, label)}
          aria-label={`Copy ${label}`}
        >
          <Clipboard className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

function EventCard({
  event,
  expanded,
  privacyEnabled,
  payloadState,
  navigationPending,
  copiedLabel,
  onToggle,
  onNavigateToAmended,
  onRetryPayload,
  onCopy,
}: {
  event: LedgerExplorerEvent;
  expanded: boolean;
  privacyEnabled: boolean;
  payloadState: EventPayloadState | undefined;
  navigationPending: boolean;
  copiedLabel: string | null;
  onToggle: () => void;
  onNavigateToAmended: () => void;
  onRetryPayload: () => void;
  onCopy: (value: string, label: string) => void;
}) {
  return (
    <article
      id={`ledger-event-${event.eventId}`}
      aria-labelledby={`ledger-event-title-${event.eventId}`}
      className="relative ml-10 rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md"
    >
      <button
        id={`ledger-event-toggle-${event.eventId}`}
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`ledger-event-details-${event.eventId}`}
        className="flex w-full items-start gap-3 rounded-t-xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span className="mt-0.5 rounded-md border bg-muted p-1.5 text-muted-foreground">
          {expanded ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1 space-y-2">
          <span className="flex flex-wrap items-center gap-2">
            <Badge data-privacy-exempt variant="secondary">Sequence {event.sequence}</Badge>
            <Badge variant="outline" data-privacy-exempt>{event.eventFact}</Badge>
            {event.amendsSequence !== null && (
              <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-300" data-privacy-exempt>
                Correction of sequence {event.amendsSequence}
              </Badge>
            )}
          </span>
          <span
            id={`ledger-event-title-${event.eventId}`}
            data-privacy-exempt
            className="block text-base font-semibold leading-snug"
          >
            {event.description || "Journal event"}
          </span>
          <span className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span data-privacy-exempt>Effective {event.effectiveDate}</span>
            <span data-privacy-exempt>Recorded {recordedDate(event.recordedAt)}</span>
            <span>{event.movements.length} movements</span>
          </span>
        </span>
      </button>

      {expanded && (
        <div id={`ledger-event-details-${event.eventId}`} className="space-y-5 border-t p-4">
          {event.amendsEventId && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium text-amber-800 dark:text-amber-200">Append-only correction</p>
              <p className="mt-1 text-muted-foreground">
                This event points back to{" "}
                <button
                  type="button"
                  data-privacy-exempt
                  className="font-medium text-foreground underline underline-offset-4"
                  onClick={onNavigateToAmended}
                  disabled={navigationPending}
                  aria-label={`Open amended event sequence ${event.amendsSequence ?? "unknown"}`}
                >
                  {navigationPending && (
                    <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  )}
                  sequence {event.amendsSequence ?? "unknown"} · {event.amendsEventId}
                </button>
                . The earlier event remains unchanged.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Event UUID
              </span>
              <code data-privacy-exempt className="break-all rounded bg-muted px-2 py-1 text-[11px]">
                {event.eventId}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 justify-self-start px-2"
                onClick={() => onCopy(event.eventId, "event UUID")}
                aria-label="Copy event UUID"
              >
                <Clipboard className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
            <HashField label="Hash" value={event.hash} onCopy={onCopy} />
            <HashField label="Predecessor" value={event.previousHash} onCopy={onCopy} />
            {copiedLabel && (
              <p role="status" className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" aria-hidden="true" /> Copied {copiedLabel}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Ordered movements</h3>
              <div className="flex flex-wrap gap-2">
                {event.balances.map((balance) => (
                  <Badge key={balance.currency} variant="outline" aria-label="Per-currency balance">
                    <span data-privacy-exempt>{balance.currency}</span>{" "}
                    <span data-ledger-private-value>
                      {privateValue(formatMoney(balance.amountMinor, balance.currency), privacyEnabled)}
                    </span>
                  </Badge>
                ))}
              </div>
            </div>
            <ol className="divide-y overflow-hidden rounded-lg border">
              {event.movements.map((movement) => (
                <li
                  key={`${event.eventId}:${movement.position}`}
                  className="grid gap-3 bg-background/40 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
                >
                  <span data-privacy-exempt className="flex h-7 w-7 items-center justify-center rounded-full bg-muted font-mono text-xs">
                    {movement.position + 1}
                  </span>
                  <span className="min-w-0">
                    <span data-privacy-exempt className="block truncate text-sm font-medium">
                      {movement.targetLabel}
                    </span>
                    <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                      <span data-privacy-exempt>{TARGET_LABELS[movement.targetType]}</span>
                      <span data-privacy-exempt>{movement.currency}</span>
                      <span data-privacy-exempt className="font-mono">{movement.ledgerAccountId}</span>
                    </span>
                  </span>
                  <span className="text-left font-mono text-sm sm:text-right">
                    <span data-ledger-private-value className={cn(
                      "block font-semibold",
                      movement.amountMinor < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400",
                    )}>
                      {privateValue(signedMoney(movement.amountMinor, movement.currency), privacyEnabled)}
                    </span>
                    {movement.quantityDelta !== null && (
                      <span data-ledger-private-value className="block text-xs text-muted-foreground">
                        Quantity {privateValue(signedQuantity(movement.quantityDelta), privacyEnabled)}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <div className="rounded-lg border bg-muted/30 p-3">
            {privacyEnabled ? (
              <div data-privacy-exempt className="flex items-start gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Canonical payload and metadata are hidden while privacy mode is on.</span>
              </div>
            ) : (
              <>
                {payloadState === undefined && (
                  <Button type="button" variant="outline" size="sm" onClick={onRetryPayload}>
                    Load canonical details
                  </Button>
                )}
                {payloadState?.status === "loading" && (
                  <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading canonical details…
                  </p>
                )}
                {payloadState?.status === "error" && (
                  <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-destructive">
                    <span>{payloadState.error}</span>
                    <Button type="button" variant="outline" size="sm" onClick={onRetryPayload}>
                      Retry details
                    </Button>
                  </div>
                )}
                {payloadState?.status === "loaded" && (
                  <div className="space-y-3">
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">Canonical metadata</summary>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-3 text-[11px]">
                        {payloadState.data.metadataJson}
                      </pre>
                      {!payloadState.data.metadataValid && (
                        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                          Stored metadata could not be parsed as an object.
                        </p>
                      )}
                      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => onCopy(payloadState.data.metadataJson, "metadata")}>
                        <Clipboard className="mr-2 h-3.5 w-3.5" aria-hidden="true" /> Copy metadata
                      </Button>
                    </details>
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">Canonical payload</summary>
                      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-3 text-[11px]">
                        {payloadState.data.canonicalPayload}
                      </pre>
                      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => onCopy(payloadState.data.canonicalPayload, "canonical payload")}>
                        <Clipboard className="mr-2 h-3.5 w-3.5" aria-hidden="true" /> Copy payload
                      </Button>
                    </details>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

export function LedgerExplorer({
  initialPage,
  initialVerification,
  initialError = null,
  initialVerificationError = null,
}: LedgerExplorerProps) {
  const { enabled: privacyEnabled } = usePrivacyMode();
  const browserReady = useSyncExternalStore(subscribeToBrowser, () => true, () => false);
  const privacyActive = privacyEnabled || !browserReady;
  const [events, setEvents] = useState(initialPage?.events ?? []);
  const [stats, setStats] = useState(initialPage?.stats ?? null);
  const [nextBeforeSequence, setNextBeforeSequence] = useState(
    initialPage?.nextBeforeSequence ?? null,
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [payloads, setPayloads] = useState<Record<string, EventPayloadState>>({});
  const [navigatingToEventId, setNavigatingToEventId] = useState<string | null>(null);
  const [focusTargetEventId, setFocusTargetEventId] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState<DateKey | undefined>();
  const [toDate, setToDate] = useState<DateKey | undefined>();
  const [currency, setCurrency] = useState("all");
  const [targetType, setTargetType] = useState("all");
  const [search, setSearch] = useState("");
  const [activeFilters, setActiveFilters] = useState<LedgerExplorerFilters>({});
  const [loadingPage, setLoadingPage] = useState(false);
  const [pageError, setPageError] = useState<string | null>(initialError);
  const [retryRequest, setRetryRequest] = useState<{
    query: LedgerExplorerQuery;
    replace: boolean;
    targetEventId?: string;
  } | null>(
    initialPage ? null : { query: {}, replace: true },
  );
  const [verification, setVerification] = useState(initialVerification);
  const [verificationError, setVerificationError] = useState<string | null>(
    initialVerificationError,
  );
  const [verifying, setVerifying] = useState(false);
  const [copied, setCopied] = useState<{ eventId: string; label: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRequestId = useRef(0);
  const payloadRequestGeneration = useRef(0);
  const verificationRequestId = useRef(0);
  const privacyActiveRef = useRef(privacyActive);
  privacyActiveRef.current = privacyActive;

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => expanded.has(events[index]?.eventId) ? 760 : 190,
    getItemKey: (index) => events[index]?.eventId ?? index,
    overscan: 5,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [expanded, privacyActive, virtualizer]);

  useEffect(() => {
    if (!privacyActive) return;
    payloadRequestGeneration.current += 1;
    setPayloads({});
  }, [privacyActive]);

  useEffect(() => {
    if (!focusTargetEventId) return;
    const index = events.findIndex((event) => event.eventId === focusTargetEventId);
    if (index < 0) return;

    virtualizer.scrollToIndex(index, { align: "center" });
    const container = scrollRef.current;
    if (!container) return;
    return watchLedgerToggleMount(
      container,
      focusTargetEventId,
      (target) => {
        target.focus({ preventScroll: true });
        setFocusTargetEventId(null);
      },
      () => {
        setFocusTargetEventId(null);
        setPageError("The amended event loaded, but its toggle did not mount. Retry to focus it again.");
        setRetryRequest({
          query: { filters: { search: focusTargetEventId } },
          replace: true,
          targetEventId: focusTargetEventId,
        });
      },
    );
  }, [events, focusTargetEventId, virtualizer]);

  useEffect(() => () => {
    pageRequestId.current += 1;
    payloadRequestGeneration.current += 1;
    verificationRequestId.current += 1;
  }, []);

  const loadPayload = useCallback(async (eventId: string) => {
    if (!shouldRequestLedgerEventPayload(true, privacyActiveRef.current)) return;
    const requestGeneration = payloadRequestGeneration.current;
    setPayloads((current) => ({ ...current, [eventId]: { status: "loading" } }));
    try {
      const result = await getLedgerEventPayload(eventId);
      if (
        requestGeneration !== payloadRequestGeneration.current ||
        privacyActiveRef.current
      ) return;
      if ("error" in result) {
        setPayloads((current) => ({
          ...current,
          [eventId]: { status: "error", error: result.error },
        }));
        return;
      }
      setPayloads((current) => ({
        ...current,
        [eventId]: { status: "loaded", data: result.data },
      }));
    } catch (error) {
      if (
        requestGeneration !== payloadRequestGeneration.current ||
        privacyActiveRef.current
      ) return;
      setPayloads((current) => ({
        ...current,
        [eventId]: {
          status: "error",
          error: error instanceof Error ? error.message : "Could not load canonical details.",
        },
      }));
    }
  }, []);

  const loadPage = useCallback(async (
    query: LedgerExplorerQuery,
    replace: boolean,
    targetEventId?: string,
  ) => {
    const requestId = ++pageRequestId.current;
    setFocusTargetEventId(null);
    setLoadingPage(true);
    if (targetEventId) setNavigatingToEventId(targetEventId);
    setPageError(null);
    try {
      const result = await getLedgerExplorerPage(query);
      if (requestId !== pageRequestId.current) return;
      if ("error" in result) {
        setPageError(result.error);
        setRetryRequest({ query, replace, targetEventId });
        return;
      }
      if (targetEventId && !result.data.events.some((event) => event.eventId === targetEventId)) {
        setPageError("The amended event could not be found. The current events remain available.");
        setRetryRequest({ query, replace, targetEventId });
        return;
      }
      setStats(result.data.stats);
      setNextBeforeSequence(result.data.nextBeforeSequence);
      setEvents((current) => {
        if (replace) return result.data.events;
        const seen = new Set(current.map((event) => event.eventId));
        return [...current, ...result.data.events.filter((event) => !seen.has(event.eventId))];
      });
      if (replace) {
        setActiveFilters(query.filters ?? {});
        payloadRequestGeneration.current += 1;
        setPayloads({});
        setExpanded(targetEventId ? new Set([targetEventId]) : new Set());
      }
      setRetryRequest(null);
      if (targetEventId) {
        setFromDate(undefined);
        setToDate(undefined);
        setCurrency("all");
        setTargetType("all");
        setSearch(targetEventId);
        setFocusTargetEventId(targetEventId);
        if (shouldRequestLedgerEventPayload(true, privacyActiveRef.current)) {
          void loadPayload(targetEventId);
        }
      } else if (replace) {
        scrollRef.current?.scrollTo({ top: 0 });
      }
    } catch (error) {
      if (requestId !== pageRequestId.current) return;
      setPageError(error instanceof Error ? error.message : "Could not load journal events.");
      setRetryRequest({ query, replace, targetEventId });
    } finally {
      if (requestId === pageRequestId.current) {
        setLoadingPage(false);
        if (targetEventId) setNavigatingToEventId(null);
      }
    }
  }, [loadPayload]);

  const applyFilters = () => {
    const filters: LedgerExplorerFilters = {
      fromDate: fromDate ?? null,
      toDate: toDate ?? null,
      currency: currency === "all" ? null : currency,
      targetType: targetType === "all" ? null : targetType,
      search: search.trim() || null,
    };
    void loadPage({ filters }, true);
  };

  const clearFilters = () => {
    setFromDate(undefined);
    setToDate(undefined);
    setCurrency("all");
    setTargetType("all");
    setSearch("");
    void loadPage({ filters: {} }, true);
  };

  const verifyNow = async () => {
    const requestId = ++verificationRequestId.current;
    setVerifying(true);
    setVerificationError(null);
    try {
      const result = await verifyLedgerIntegrity();
      if (requestId !== verificationRequestId.current) return;
      if ("error" in result) setVerificationError(result.error);
      else setVerification(result.data);
    } catch (error) {
      if (requestId !== verificationRequestId.current) return;
      setVerificationError(error instanceof Error ? error.message : "Ledger verification failed.");
    } finally {
      if (requestId === verificationRequestId.current) setVerifying(false);
    }
  };

  const copy = async (value: string, label: string, eventId = "global") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied({ eventId, label });
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setPageError("The browser refused clipboard access. Select the value and copy it manually.");
    }
  };

  const toggle = (eventId: string) => {
    const willExpand = !expanded.has(eventId);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
    if (
      shouldRequestLedgerEventPayload(willExpand, privacyActive) &&
      payloads[eventId] === undefined
    ) {
      void loadPayload(eventId);
    }
  };

  const navigateToAmended = (event: LedgerExplorerEvent) => {
    if (!event.amendsEventId) return;
    void loadPage(
      { filters: { search: event.amendsEventId } },
      true,
      event.amendsEventId,
    );
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>Filter raw events</CardTitle>
            <CardDescription>
              Results stay in durable sequence order; filters never rewrite or collapse the journal.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <div className="space-y-2">
              <Label htmlFor="ledger-from">Effective from</Label>
              <div data-privacy-exempt>
                <DatePicker id="ledger-from" value={fromDate} onChange={setFromDate} className="w-full" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ledger-to">Effective through</Label>
              <div data-privacy-exempt>
                <DatePicker id="ledger-to" value={toDate} onChange={setToDate} className="w-full" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ledger-currency">Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="ledger-currency"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All currencies</SelectItem>
                  {(stats?.currencies ?? []).map((code) => (
                    <SelectItem key={code} value={code}>{code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ledger-target">Target type</Label>
              <Select value={targetType} onValueChange={setTargetType}>
                <SelectTrigger id="ledger-target"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All targets</SelectItem>
                  <SelectItem value="real_account">Accounts</SelectItem>
                  <SelectItem value="category">Categories</SelectItem>
                  <SelectItem value="instrument">Instruments</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2 xl:col-span-1">
              <Label htmlFor="ledger-search">Text or identifier</Label>
              <div className="flex gap-2">
                <Input
                  id="ledger-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applyFilters();
                  }}
                  placeholder="Description, hash, UUID, sequence…"
                />
                <Button type="button" size="icon" onClick={applyFilters} disabled={loadingPage} aria-label="Apply Ledger filters">
                  <Search className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
            <div className="flex gap-2 sm:col-span-2 xl:col-span-5">
              <Button type="button" onClick={applyFilters} disabled={loadingPage}>
                {loadingPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                Apply filters
              </Button>
              <Button type="button" variant="outline" onClick={clearFilters} disabled={loadingPage}>
                Clear
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {verification?.ok ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden="true" />
              )}
              Integrity
            </CardTitle>
            <CardDescription>
              Existing read-only ledger verifier
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div data-privacy-exempt className="grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-3">
              <span className="text-muted-foreground">Events</span><span className="text-right font-medium">{stats?.eventCount ?? 0}</span>
              <span className="text-muted-foreground">Movements</span><span className="text-right font-medium">{stats?.movementCount ?? 0}</span>
              <span className="text-muted-foreground">Status</span>
              <span className={cn("text-right font-medium", verification?.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300")}>
                {verification ? (verification.ok ? "Verified" : "Issues found") : "Not verified"}
              </span>
            </div>
            <div className="space-y-1 text-xs">
              <p className="text-muted-foreground">Chain head</p>
              {stats?.chainHead ? (
                <>
                  <p data-privacy-exempt>Sequence {stats.chainHead.sequence}</p>
                  <code data-privacy-exempt className="block break-all rounded bg-muted p-2">{stats.chainHead.hash}</code>
                </>
              ) : <p data-privacy-exempt>Empty journal</p>}
              <p className="pt-1 text-muted-foreground">Last verified this session</p>
              <p data-privacy-exempt>{verification ? recordedDate(verification.verifiedAt) : "Not yet"}</p>
            </div>
            {verification && !verification.ok && (
              <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                {verification.failures.slice(0, 8).map((failure, index) => (
                  <li data-privacy-exempt key={`${failure.invariant}:${failure.sequence ?? failure.eventId ?? index}`}>
                    {failure.invariant}
                    {failure.sequence !== undefined ? ` · sequence ${failure.sequence}` : ""}
                    {failure.eventId ? ` · ${failure.eventId}` : ""}
                  </li>
                ))}
              </ul>
            )}
            {verificationError && <p role="alert" className="text-xs text-destructive">{verificationError}</p>}
            <Button type="button" variant="outline" className="w-full" onClick={verifyNow} disabled={verifying}>
              {verifying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
              Verify now
            </Button>
          </CardContent>
        </Card>
      </div>

      {pageError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <span>{pageError}</span>
          {retryRequest && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loadingPage}
              onClick={() => void loadPage(
                retryRequest.query,
                retryRequest.replace,
                retryRequest.targetEventId,
              )}
            >
              Retry
            </Button>
          )}
        </div>
      )}

      {events.length === 0 && !loadingPage ? (
        <Card>
          <CardContent className="py-14 text-center">
            <p className="font-medium">No journal events match these filters.</p>
            <p className="mt-1 text-sm text-muted-foreground">Clear the filters or confirm a financial event to see it here.</p>
          </CardContent>
        </Card>
      ) : (
        <div
          ref={scrollRef}
          aria-label="Ledger event chain, newest first"
          className="h-[72vh] min-h-[32rem] overflow-auto rounded-xl border bg-muted/20 px-2 py-4 sm:px-4"
        >
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const event = events[virtualItem.index];
              if (!event) return null;
              const isLastLoaded = virtualItem.index === events.length - 1;
              return (
                <div
                  key={event.eventId}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full pb-8"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <div className="absolute bottom-0 left-[1.22rem] top-6 w-px bg-border" aria-hidden="true" />
                  <div className="absolute left-2 top-5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-primary bg-background shadow-sm" aria-hidden="true">
                    <span className="h-2 w-2 rounded-full bg-primary" />
                  </div>
                  {(!isLastLoaded || nextBeforeSequence !== null) && (
                    <ArrowDown className="absolute -bottom-0.5 left-[0.82rem] h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  )}
                  <EventCard
                    event={event}
                    expanded={expanded.has(event.eventId)}
                    privacyEnabled={privacyActive}
                    payloadState={payloads[event.eventId]}
                    navigationPending={navigatingToEventId === event.amendsEventId}
                    copiedLabel={copied?.eventId === event.eventId ? copied.label : null}
                    onToggle={() => toggle(event.eventId)}
                    onNavigateToAmended={() => navigateToAmended(event)}
                    onRetryPayload={() => void loadPayload(event.eventId)}
                    onCopy={(value, label) => void copy(value, label, event.eventId)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3">
        <p data-privacy-exempt className="text-sm text-muted-foreground">
          {events.length} events loaded{nextBeforeSequence === null ? " · end of matching chain" : ""}
        </p>
        {nextBeforeSequence !== null && (
          <Button
            type="button"
            variant="outline"
            disabled={loadingPage}
            onClick={() => void loadPage({
              beforeSequence: nextBeforeSequence,
              filters: activeFilters,
            }, false)}
          >
            {loadingPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Load older
          </Button>
        )}
      </div>
    </div>
  );
}
