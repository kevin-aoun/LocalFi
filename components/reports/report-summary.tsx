"use client";

/**
 * The four headline figures of a report: money in, money out, what is left, and
 * the savings rate.
 *
 * Every number arrives as integer cents and is rendered with `formatMoney`; the
 * rates arrive as `number | null` and are rendered with `formatSavingsRate`, which
 * prints an em dash rather than `NaN%` when there was no income to divide by.
 */
import { ArrowDownRight, ArrowUpRight, PiggyBank, Scale } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import {
  formatSavingsRate,
  savingsRate,
  savingsRateExcludingInvestments,
  type FlowTotals,
} from "@/lib/reports";
import { cn } from "@/lib/utils";

type ReportSummaryProps = {
  totals: FlowTotals;
  currency: string;
};

export function ReportSummary({ totals, currency }: ReportSummaryProps) {
  const rate = savingsRate(totals);
  const rateExInvestments = savingsRateExcludingInvestments(totals);
  const surplus = totals.netCents >= 0;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ArrowUpRight className="h-4 w-4 text-green-600" />
            Money in
          </div>
          <div className="mt-2 text-2xl font-bold tabular-nums">
            {formatMoney(totals.incomeCents, currency)}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Income categories only</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ArrowDownRight className="h-4 w-4 text-red-600" />
            Money out
          </div>
          <div className="mt-2 text-2xl font-bold tabular-nums">
            {formatMoney(totals.expenseCents, currency)}
          </div>
          {/* Investment rows subtract from cash in this app, so they ARE money out —
              but calling a brokerage top-up an "expense" without saying so is how a
              savings rate reads wrong. Both parts are shown. */}
          <p className="mt-1 text-xs text-muted-foreground">
            {formatMoney(totals.consumptionCents, currency)} spent
            {totals.investmentCents !== 0 && (
              <> · {formatMoney(totals.investmentCents, currency)} invested</>
            )}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Scale className="h-4 w-4" />
            {surplus ? "Left over" : "Shortfall"}
          </div>
          <div
            className={cn(
              "mt-2 text-2xl font-bold tabular-nums",
              surplus ? "text-green-600" : "text-red-600",
            )}
          >
            {formatMoney(totals.netCents, currency)}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">In minus out, for this range</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <PiggyBank className="h-4 w-4" />
            Savings rate
          </div>
          <div
            className={cn(
              "mt-2 text-2xl font-bold tabular-nums",
              rate === null ? "text-muted-foreground" : rate >= 0 ? "text-green-600" : "text-red-600",
            )}
          >
            {formatSavingsRate(rate)}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {rate === null ? (
              "No income in this range, so there is no rate to state."
            ) : (
              <>
                {formatSavingsRate(rateExInvestments)} counting investments as saved
              </>
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
