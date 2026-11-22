// Net-worth pieces shared by Home's net-worth section and the Accounts page.

import { useState } from "react";

import { recordNetWorthToday, type NetWorthView } from "@/app/actions/accounts";
import { formatCurrencyTotals } from "@/components/assets/currency-totals";
import { fromDateKey, isDateKey } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

export function formatDateKey(key: string): string {
  return isDateKey(key) ? fromDateKey(key).toLocaleDateString() : key;
}

export type BucketMoneyField =
  | "totalAssetsCents"
  | "totalLiabilitiesCents"
  | "netWorthCents"
  | "standaloneAssetsCents";

export function bucketLabel(netWorth: NetWorthView, field: BucketMoneyField): string {
  return formatCurrencyTotals(
    netWorth.currencyTotals.map((total) => ({
      currency: total.currency,
      totalCents: total[field],
      count: 1,
    })),
  );
}

export function BucketValues({
  netWorth,
  field,
  className,
}: {
  netWorth: NetWorthView;
  field: BucketMoneyField;
  className?: string;
}) {
  return (
    <div className={cn("space-y-0.5", className)}>
      {netWorth.currencyTotals.map((total) => (
        <div
          key={total.currency}
          className={cn(field === "netWorthCents" && total[field] < 0 && "text-red-600 dark:text-red-400")}
        >
          {formatMoney(total[field], total.currency)}
        </div>
      ))}
    </div>
  );
}

/** "Record today": refresh live prices, snapshot net worth, and report the outcome. */
export function useRecordNetWorthToday(
  onRecorded: () => void | Promise<void>,
  setError: (message: string | null) => void,
) {
  const [snapshotting, setSnapshotting] = useState(false);
  const [snapshotNote, setSnapshotNote] = useState<string | null>(null);

  const handleSnapshot = async () => {
    setError(null);
    setSnapshotNote(null);
    setSnapshotting(true);
    try {
      const result = await recordNetWorthToday();
      if (result && "error" in result) {
        setError(result.error || "Failed to record net worth.");
        return;
      }
      setSnapshotNote(
        `Recorded ${formatMoney(result.data.netWorthCents, result.data.currency)} for ` +
          `${formatDateKey(result.data.date)}. ${result.data.priceSummary}`,
      );
      await onRecorded();
    } catch (error) {
      console.error("Failed to snapshot net worth:", error);
      setError(error instanceof Error ? error.message : "Failed to record net worth.");
    } finally {
      setSnapshotting(false);
    }
  };

  return { snapshotting, snapshotNote, handleSnapshot };
}
