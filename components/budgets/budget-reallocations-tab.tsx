import { ArrowLeftRight, AlertCircle, Loader2, Trash2 } from "lucide-react";

import type { BudgetReallocationView } from "@/app/actions/budgets";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/money";

export function BudgetReallocationsTab({
  reallocations,
  canReallocate,
  onOpen,
  error,
  deletingId,
  onDelete,
}: {
  reallocations: BudgetReallocationView[];
  canReallocate: boolean;
  onOpen: () => void;
  error: string | null;
  deletingId: number | null;
  onDelete: (id: number) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">One-off monthly reallocations</h2><p className="text-sm text-muted-foreground">Each entry changes only the named month. It never edits either permanent budget.</p></div><Button onClick={onOpen} disabled={!canReallocate}><ArrowLeftRight className="mr-2 h-4 w-4" />Reallocate budget</Button></div>
      {error && <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}
      {reallocations.length === 0 ? <Card><CardContent className="flex flex-col items-center justify-center py-14 text-center"><ArrowLeftRight className="mb-3 h-10 w-10 text-muted-foreground" /><h3 className="font-semibold">No reallocations yet</h3><p className="mt-1 max-w-md text-sm text-muted-foreground">Move a fixed amount or a percentage from one monthly category budget to another.</p></CardContent></Card> : <Card><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>Month</TableHead><TableHead>From</TableHead><TableHead>To</TableHead><TableHead className="text-right">Moved</TableHead><TableHead className="w-12"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader><TableBody>
        {reallocations.map((allocation) => <TableRow key={allocation.id}><TableCell className="font-medium">{allocation.month}</TableCell><TableCell>{allocation.fromCategoryName}</TableCell><TableCell>{allocation.toCategoryName}</TableCell><TableCell className="text-right"><div className="font-medium">{formatMoney(allocation.amountCents)}</div><div className="text-xs text-muted-foreground">{allocation.inputMode === "percentage" ? `${allocation.inputValue}% when created` : "fixed amount"}</div></TableCell><TableCell><Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={deletingId === allocation.id} onClick={() => onDelete(allocation.id)} aria-label={`Delete ${allocation.month} reallocation`}>{deletingId === allocation.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 text-destructive" />}</Button></TableCell></TableRow>)}
      </TableBody></Table></CardContent></Card>}
    </div>
  );
}
