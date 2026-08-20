"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { assignOrphanTransactions } from "@/app/actions/accounts";
import { orphanSummary, type AccountRow } from "./account-form-logic";

type OrphanRepairCardProps = {

  orphanCount: number;

  accounts: AccountRow[];
  onRepaired: () => void;
};

export function OrphanRepairCard({ orphanCount, accounts, onRepaired }: OrphanRepairCardProps) {
  const summary = orphanSummary(orphanCount);
  const [targetId, setTargetId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<number | null>(null);

  if (!summary.hasOrphans) return null;

  const handleAssign = async () => {
    setError(null);
    const id = Number(targetId);
    if (!Number.isInteger(id) || id <= 0) {
      setError("Choose the account these transactions belong to.");
      return;
    }

    setLoading(true);
    try {
      const result = await assignOrphanTransactions(id);

      if (result && "error" in result) {
        setError(result.error || "Failed to assign the transactions.");
        return;
      }
      setMoved(result.data.moved);
      onRepaired();
    } catch (err) {
      console.error("Failed to assign orphan transactions:", err);
      setError(err instanceof Error ? err.message : "Failed to assign the transactions.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/30">
      <CardContent className="space-y-3 p-6">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <h3 className="font-semibold">Unassigned transactions</h3>
            <p className="text-sm text-muted-foreground">{summary.message}</p>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {moved !== null && (
          <p className="text-sm font-medium text-green-700 dark:text-green-400">
            Moved {moved} transaction{moved === 1 ? "" : "s"}.
          </p>
        )}

        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Create an account first, then assign them to it.
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="orphan-target">Assign them all to</Label>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger id="orphan-target" className="w-[240px]">
                  <SelectValue placeholder="Choose an account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id.toString()}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleAssign} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Wrench className="mr-2 h-4 w-4" />
              )}
              Assign
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
