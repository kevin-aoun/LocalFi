"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  deleteRecurringTransaction,
  generateDueTransactions,
  getRecurringTransactions,
  getUpcomingRecurring,
  setRecurringArchived,
} from "@/app/actions/recurring";
import {
  RecurringDialog,
  type AccountOption,
  type CategoryOption,
} from "@/components/recurring/recurring-dialog";
import {
  formatDateKey,
  frequencyLabel,
  groupUpcomingByDate,
  monthEndNote,
  scheduleStatus,
  summarizeGenerationReport,
  upcomingThroughKey,
  upcomingTotals,
  type GenerationSummary,
  type UpcomingItemLike,
} from "@/components/recurring/recurring-form-logic";
import type { RecurringTransaction } from "@/lib/db/schema";
import { todayKey, type DateKey } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

const WINDOWS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

type RecurringClientProps = {
  initialTemplates: RecurringTransaction[];
  accounts: AccountOption[];
  categories: CategoryOption[];
  initialToday: DateKey;
};

const TONE_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  due: "default",
  scheduled: "outline",
  paused: "secondary",
  finished: "secondary",
};

export default function RecurringClient({
  initialTemplates,
  accounts,
  categories,
  initialToday,
}: RecurringClientProps) {
  const router = useRouter();

  const [templates, setTemplates] = useState(initialTemplates);
  const [today, setToday] = useState<DateKey>(initialToday);
  const [showArchived, setShowArchived] = useState(false);
  const [windowDays, setWindowDays] = useState<number>(30);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringTransaction | null>(null);

  const [upcoming, setUpcoming] = useState<UpcomingItemLike[] | null>(null);
  const [upcomingLoading, setUpcomingLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);

  const [confirmPostOpen, setConfirmPostOpen] = useState(false);
  const [posting, setPosting] = useState(false);
  const [summary, setSummary] = useState<GenerationSummary | null>(null);

  const [pendingArchive, setPendingArchive] = useState<RecurringTransaction | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RecurringTransaction | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    setToday(todayKey());
  }, []);

  const accountName = useCallback(
    (id: number | null) => (id === null ? null : accounts.find((a) => a.id === id)?.name ?? `#${id}`),
    [accounts],
  );
  const categoryName = useCallback(
    (id: number | null) =>
      id === null ? null : categories.find((c) => c.id === id)?.name ?? `#${id}`,
    [categories],
  );

  const loadUpcoming = useCallback(
    async (through: DateKey) => {
      setUpcomingLoading(true);
      try {
        const rows = await getUpcomingRecurring({ throughKey: through });
        setUpcoming(rows);
      } catch (cause) {
        console.error("Failed to load the upcoming schedule:", cause);
        setError(
          cause instanceof Error ? cause.message : "Failed to load the upcoming schedule.",
        );
      } finally {
        setUpcomingLoading(false);
      }
    },
    [],
  );

  const throughKey = useMemo(() => upcomingThroughKey(today, windowDays), [today, windowDays]);

  useEffect(() => {
    void loadUpcoming(throughKey);
  }, [loadUpcoming, throughKey]);

  const refresh = useCallback(async () => {
    try {
      const rows = await getRecurringTransactions({ includeArchived: true });
      setTemplates(rows);
    } catch (cause) {
      console.error("Failed to reload recurring transactions:", cause);
      setError(cause instanceof Error ? cause.message : "Failed to reload the templates.");
    }
    await loadUpcoming(throughKey);

    router.refresh();
  }, [loadUpcoming, router, throughKey]);

  const visible = useMemo(
    () => (showArchived ? templates : templates.filter((t) => !t.archived)),
    [templates, showArchived],
  );
  const archivedCount = useMemo(() => templates.filter((t) => t.archived).length, [templates]);

  const totals = useMemo(
    () => (upcoming === null ? null : upcomingTotals(upcoming, today)),
    [upcoming, today],
  );
  const days = useMemo(() => (upcoming === null ? [] : groupUpcomingByDate(upcoming)), [upcoming]);

  const dueToday = useMemo(() => days.filter((day) => day.key <= today), [days, today]);


  const errorBanner = error && (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{error}</span>
    </div>
  );

  const handlePost = async () => {
    setPosting(true);
    setError(null);
    try {


      const result = await generateDueTransactions();
      if ("error" in result) {
        setError(result.error);
        setSummary(null);
        return;
      }
      setSummary(summarizeGenerationReport(result.data));
      setConfirmPostOpen(false);
      await refresh();
    } catch (cause) {
      console.error("Failed to post due transactions:", cause);
      setError(cause instanceof Error ? cause.message : "Failed to post due transactions.");
    } finally {
      setPosting(false);
    }
  };

  const handleArchiveToggle = async (template: RecurringTransaction) => {
    setBusyId(template.id);
    setError(null);
    try {
      const result = await setRecurringArchived(template.id, !template.archived);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setPendingArchive(null);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (template: RecurringTransaction) => {
    setBusyId(template.id);
    setError(null);
    try {
      const result = await deleteRecurringTransaction(template.id);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setPendingDelete(null);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Recurring</h1>
          <p className="text-muted-foreground">
            Templates for rent, salary and subscriptions. Post them once and they stop being
            something you retype every month.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setError(null);
              setConfirmPostOpen(true);
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Post due transactions
          </Button>
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            New template
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {}
      {summary && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  {summary.posted === 0 ? (
                    <CalendarClock className="h-4 w-4" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  Last run
                </CardTitle>
                <CardDescription>{summary.headline}</CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSummary(null)}>
                Dismiss
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {}
            <div className="flex gap-6 text-sm">
              <div>
                <div className="text-2xl font-semibold">{summary.posted}</div>
                <div className="text-muted-foreground">posted</div>
              </div>
              <div>
                <div className="text-2xl font-semibold">{summary.skipped}</div>
                <div className="text-muted-foreground">skipped (already on the ledger)</div>
              </div>
              <div>
                <div className="text-2xl font-semibold">{formatDateKey(summary.throughKey)}</div>
                <div className="text-muted-foreground">posted through</div>
              </div>
            </div>

            {summary.errors.length > 0 && (
              <div
                role="alert"
                className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <div className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  Some templates were skipped entirely
                </div>
                <ul className="mt-1 space-y-0.5">
                  {summary.errors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </div>
            )}

            {summary.lines.length > 0 && (
              <ul className="space-y-1 text-sm">
                {summary.lines.map((line) => (
                  <li key={line.id} className="flex flex-wrap gap-x-2">
                    <span className="font-medium">{line.name}</span>
                    <span
                      className={cn(
                        line.tone === "error" && "text-destructive",
                        line.tone !== "error" && "text-muted-foreground",
                      )}
                    >
                      {line.text}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-xs text-muted-foreground">
              Safe to run again: every posted row is stamped with its template and its
              occurrence day under a unique index, so a repeat run reports those days as
              skipped instead of posting them twice.
            </p>
          </CardContent>
        </Card>
      )}

      {}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">Upcoming</CardTitle>
              <CardDescription>
                What active templates will post through {formatDateKey(throughKey)}. Nothing is
                written until you post.
              </CardDescription>
            </div>
            <div className="flex gap-1">
              {WINDOWS.map((option) => (
                <Button
                  key={option.days}
                  variant={windowDays === option.days ? "default" : "outline"}
                  size="sm"
                  onClick={() => setWindowDays(option.days)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {upcomingLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Working out the schedule…
            </div>
          ) : totals === null ? null : (
            <>
              <div className="flex flex-wrap gap-6 text-sm">
                <div>
                  <div className="text-2xl font-semibold">{totals.occurrences}</div>
                  <div className="text-muted-foreground">occurrences</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold">{totals.dueNow}</div>
                  <div className="text-muted-foreground">due now (on or before today)</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold">{formatMoney(totals.totalCents)}</div>
                  <div className="text-muted-foreground">total in this window</div>
                </div>
              </div>

              {totals.errors.length > 0 && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  <div className="flex items-center gap-2 font-medium">
                    <AlertTriangle className="h-4 w-4" />
                    These templates cannot be scheduled
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {totals.errors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {days.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  Nothing is scheduled between today and {formatDateKey(throughKey)}.
                </p>
              ) : (
                <ul className="divide-y">
                  {days.map((day) => {
                    const isDue = day.key <= today;
                    return (
                      <li key={day.key} className="flex flex-wrap items-baseline gap-x-3 py-2">
                        <span className="w-32 font-medium">{formatDateKey(day.key)}</span>
                        {isDue && (
                          <Badge variant="default" className="shrink-0">
                            due
                          </Badge>
                        )}
                        <span className="flex-1 text-sm text-muted-foreground">
                          {day.entries
                            .map((entry) => `${entry.name} ${formatMoney(entry.amountCents)}`)
                            .join(" · ")}
                        </span>
                        <span className="font-medium">{formatMoney(day.totalCents)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <CardTitle className="text-base">Templates</CardTitle>
              <CardDescription>
                {visible.length === 1 ? "1 template" : `${visible.length} templates`}
                {archivedCount > 0 &&
                  !showArchived &&
                  ` · ${archivedCount} paused hidden`}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="show-archived"
                checked={showArchived}
                onCheckedChange={(checked) => setShowArchived(checked === true)}
              />
              <Label htmlFor="show-archived" className="cursor-pointer text-sm font-normal">
                Show paused
              </Label>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {visible.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No recurring transactions yet. Add rent, salary or a subscription and it will post
              itself.
            </div>
          ) : (
            visible.map((template) => {
              const status = scheduleStatus(template, today);
              const account = accountName(template.accountId);
              const transferTo = accountName(template.transferAccountId);
              const category = categoryName(template.categoryId);
              const clamp = monthEndNote(template);
              const busy = busyId === template.id;

              return (
                <div
                  key={template.id}
                  className={cn(
                    "rounded-lg border p-4",
                    template.archived && "bg-muted/40 opacity-80",
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{template.name}</span>
                        <span className="font-semibold">{formatMoney(template.amountCents)}</span>
                        <Badge variant={TONE_BADGE[status.tone] ?? "outline"}>
                          {status.label}
                        </Badge>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                        <span>{frequencyLabel(template.frequency, template.interval)}</span>
                        <span>·</span>
                        {transferTo === null ? (
                          <span>{category ?? "uncategorised"}</span>
                        ) : (
                          <span>transfer</span>
                        )}
                        <span>·</span>
                        <span>
                          {account ?? "no account"}
                          {transferTo !== null && ` → ${transferTo}`}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 text-xs text-muted-foreground">
                        <span>Starts {formatDateKey(template.startDate)}</span>
                        {template.endDate !== null && (
                          <span>Ends {formatDateKey(template.endDate)}</span>
                        )}
                        <span>
                          Last posted{" "}
                          {template.lastGenerated === null
                            ? "never"
                            : formatDateKey(template.lastGenerated)}
                        </span>
                      </div>

                      {status.detail && (
                        <p className="text-xs text-muted-foreground">{status.detail}</p>
                      )}
                      {template.comment && (
                        <p className="text-xs text-muted-foreground">{template.comment}</p>
                      )}
                      {clamp && <p className="text-xs text-muted-foreground">{clamp}</p>}
                    </div>

                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setEditing(template);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </Button>
                      {template.archived ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void handleArchiveToggle(template)}
                        >
                          {busy ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Play className="mr-2 h-4 w-4" />
                          )}
                          Resume
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setError(null);
                            setPendingArchive(template);
                          }}
                        >
                          <Pause className="mr-2 h-4 w-4" />
                          Pause
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${template.name}`}
                        disabled={busy}
                        onClick={() => {
                          setError(null);
                          setPendingDelete(template);
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <RecurringDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        template={editing}
        accounts={accounts}
        categories={categories}
        onSuccess={() => void refresh()}
      />

      {}
      <AlertDialog open={confirmPostOpen} onOpenChange={setConfirmPostOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Post due transactions?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Every occurrence due on or before today becomes a real transaction, dated on
                  the day it was due: not lumped onto today.
                </p>
                {dueToday.length === 0 ? (
                  <p className="text-foreground">
                    Nothing is due right now, so this will post nothing. Running it is still
                    safe.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {dueToday.map((day) => (
                      <li key={day.key} className="text-foreground">
                        <span className="font-medium">{formatDateKey(day.key)}</span>{" "}
                        {day.entries
                          .map((entry) => `${entry.name} ${formatMoney(entry.amountCents)}`)
                          .join(" · ")}
                      </li>
                    ))}
                  </ul>
                )}
                <p>
                  This is safe to re-run: occurrences already on the ledger are reported as
                  skipped, never posted twice.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {errorBanner}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={posting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={posting}
              onClick={(event) => {

                event.preventDefault();
                void handlePost();
              }}
            >
              {posting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Post now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {}
      <AlertDialog
        open={pendingArchive !== null}
        onOpenChange={(open) => {
          if (!open) setPendingArchive(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pause {pendingArchive?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              A paused template posts nothing but keeps its rule, its history and its link to
              the transactions it already generated. Resume it any time: occurrences it missed
              while paused are still due and will be posted on their own dates when you next
              post due transactions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {errorBanner}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (pendingArchive) void handleArchiveToggle(pendingArchive);
              }}
            >
              Pause
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  The transactions this template already posted are{" "}
                  <span className="font-medium text-foreground">kept</span> ; they are real
                  spending that happened. Only their link back to this template is dropped, so
                  they stay on the ledger as ordinary transactions and your balances do not
                  change.
                </p>
                <p>
                  What is lost is the rule itself: no further occurrences will ever be posted,
                  and the schedule cannot be recovered. If you only want it to stop,{" "}
                  <span className="font-medium text-foreground">pause</span> it instead: that
                  keeps the rule and the link.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {errorBanner}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                if (pendingDelete) void handleDelete(pendingDelete);
              }}
            >
              Delete template
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
