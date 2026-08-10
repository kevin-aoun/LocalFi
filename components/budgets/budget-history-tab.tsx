import { AlertCircle, CalendarRange, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { budgetPeriods, type BudgetPeriod } from "@/lib/budgets";
import type { DateKey } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { historyVerdict, periodLabel, type BudgetRowView, type HistoryPeriodGroup } from "./budget-view-logic";

const HISTORY_LENGTHS = [3, 6, 12, 24];

export function BudgetHistoryTab({
  historyPeriod,
  setHistoryPeriod,
  historyLength,
  setHistoryLength,
  historyCategory,
  setHistoryCategory,
  categories,
  historyLoading,
  historyError,
  historyGroups,
  todayKey,
}: {
  historyPeriod: BudgetPeriod;
  setHistoryPeriod: (value: BudgetPeriod) => void;
  historyLength: number;
  setHistoryLength: (value: number) => void;
  historyCategory: string;
  setHistoryCategory: (value: string) => void;
  categories: readonly { id: number; name: string }[];
  historyLoading: boolean;
  historyError: string | null;
  historyGroups: HistoryPeriodGroup[];
  todayKey: DateKey;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={historyPeriod} onValueChange={(value) => setHistoryPeriod(value as BudgetPeriod)}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>{budgetPeriods.map((period) => <SelectItem key={period} value={period}>{periodLabel(period)}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={String(historyLength)} onValueChange={(value) => setHistoryLength(Number(value))}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>{HISTORY_LENGTHS.map((count) => <SelectItem key={count} value={String(count)}>Last {count} periods</SelectItem>)}</SelectContent>
        </Select>
        <Select value={historyCategory} onValueChange={setHistoryCategory}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((category) => <SelectItem key={category.id} value={String(category.id)}>{category.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {historyLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {historyError && <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{historyError}</span></div>}

      {historyGroups.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center justify-center py-16"><CalendarRange className="h-12 w-12 text-muted-foreground mb-4" /><h3 className="text-lg font-semibold mb-2">No history for this selection</h3><p className="text-sm text-muted-foreground text-center max-w-sm">A period only appears once a budget was in force for it. Widen the range or add a budget with an earlier start date.</p></CardContent></Card>
      ) : historyGroups.map((group) => (
        <Card key={`${group.period}-${group.periodKey}`}>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">{group.label}<span className="ml-2 text-xs font-normal text-muted-foreground">{group.startKey} → {group.endKey}</span></CardTitle>
            <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{formatMoney(group.totalSpentCents)} of {formatMoney(group.totalLimitCents)}</span>{group.overCount > 0 ? <Badge variant="destructive">{group.overCount} over budget</Badge> : <Badge variant="secondary">All within budget</Badge>}</div>
          </CardHeader>
          <CardContent><Table><TableHeader><TableRow><TableHead>Category</TableHead><TableHead className="text-right">Limit</TableHead><TableHead className="text-right">Carried in</TableHead><TableHead className="text-right">Spent</TableHead><TableHead className="text-right">Remaining</TableHead><TableHead className="text-right">Result</TableHead></TableRow></TableHeader><TableBody>
            {group.rows.map((row: BudgetRowView) => { const verdict = historyVerdict(row, todayKey); return <TableRow key={`${row.budgetId}-${row.periodKey}`}><TableCell className="font-medium">{row.categoryName}</TableCell><TableCell className="text-right">{formatMoney(row.limitCents)}</TableCell><TableCell className="text-right text-muted-foreground">{row.rollover ? formatMoney(row.carriedInCents) : "—"}</TableCell><TableCell className="text-right">{formatMoney(row.spentCents)}</TableCell><TableCell className={cn("text-right", row.remainingCents < 0 && "text-destructive")}>{formatMoney(row.remainingCents)}</TableCell><TableCell className="text-right"><span className={cn("text-xs font-medium", verdict.status === "over" && "text-destructive", verdict.status === "under" && "text-emerald-600", verdict.status === "ignored" && "text-muted-foreground")}>{verdict.label}</span>{verdict.inProgress && <span className="ml-2 text-xs text-muted-foreground">(in progress)</span>}</TableCell></TableRow>; })}
          </TableBody></Table></CardContent>
        </Card>
      ))}
    </div>
  );
}
