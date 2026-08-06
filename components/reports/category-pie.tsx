"use client";

/**
 * The category breakdown as a pie.
 *
 * A pie is the right shape here and the wrong shape almost everywhere else: this
 * is one direction's spending split into parts of a single whole, which is the
 * only thing a pie encodes well. It is deliberately NOT offered for the cash-flow
 * chart, where money in and money out are two quantities that must never be added.
 *
 * Every wedge is drawn — no "Other" bucket. Grouping the tail into one grey slice
 * makes a prettier chart by deleting the long tail of small, forgettable spending,
 * which is usually the thing worth seeing. The legend beside the pie carries the
 * exact figures, so a two-pixel wedge is still readable as a number.
 */
import { AlertTriangle } from "lucide-react";
import { Cell, Pie, PieChart, Tooltip } from "recharts";

import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { formatMoney } from "@/lib/money";
import { formatPercent } from "@/lib/reports";
import type { CategoryPieModel, CategorySlice } from "@/components/reports/category-chart";

const chartConfig = {} satisfies ChartConfig;

function PieTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ payload?: CategorySlice }>;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  const slice = payload[0]?.payload;
  if (!slice) return null;

  return (
    <div className="rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: slice.color }}
        />
        {slice.name}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
        <span>Total</span>
        <span className="text-right font-mono text-foreground">
          {formatMoney(slice.cents, currency)}
        </span>
        <span>Share</span>
        <span className="text-right font-mono text-foreground">{formatPercent(slice.share)}</span>
        <span>Transactions</span>
        <span className="text-right font-mono text-foreground">{slice.count}</span>
      </div>
    </div>
  );
}

export function CategoryPie({ model, currency }: { model: CategoryPieModel; currency: string }) {
  const { slices, totalCents, excluded, partial } = model;

  if (slices.length === 0) {
    return (
      <div className="space-y-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          {excluded.length > 0
            ? "Nothing here can be drawn as a pie: see below."
            : "Nothing in this range for the selected direction."}
        </p>
        {excluded.length > 0 && <ExcludedNote excluded={excluded} currency={currency} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
        <ChartContainer config={chartConfig} className="mx-auto h-72 w-full max-w-[20rem]">
          <PieChart>
            <Tooltip content={<PieTooltip currency={currency} />} />
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="52%"
              outerRadius="88%"
              paddingAngle={1}
              isAnimationActive={false}
              stroke="hsl(var(--background))"
              strokeWidth={2}
            >
              {slices.map((slice) => (
                <Cell key={slice.key} fill={slice.color} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>

        {/* The legend is the readable half: a wedge too small to see is still a
            line here with its exact amount. */}
        <ul className="space-y-1.5 text-sm">
          {slices.map((slice) => (
            <li key={slice.key} className="flex items-center gap-2">
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: slice.color }}
              />
              <span className="min-w-0 flex-1 truncate">
                {slice.name}
                {slice.uncategorized && (
                  <AlertTriangle
                    className="ml-1 inline h-3 w-3 text-amber-600 dark:text-amber-400"
                    aria-label="This category no longer exists, so it counts towards no total anywhere in the app."
                  />
                )}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                {formatPercent(slice.share)}
              </span>
              <span className="w-24 shrink-0 text-right font-mono tabular-nums font-medium">
                {formatMoney(slice.cents, currency)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* State the denominator. A percentage with an unstated whole is not a fact. */}
      <p className="text-xs text-muted-foreground">
        Shares are of the {formatMoney(totalCents, currency)} drawn here, across{" "}
        {slices.length} {slices.length === 1 ? "category" : "categories"}.
      </p>

      {partial && <ExcludedNote excluded={excluded} currency={currency} />}
    </div>
  );
}

function ExcludedNote({
  excluded,
  currency,
}: {
  excluded: CategoryPieModel["excluded"];
  currency: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        <span className="font-medium">
          {excluded.length} {excluded.length === 1 ? "category is" : "categories are"} not shown in
          the pie.
        </span>{" "}
        A wedge has to be a positive part of a whole, so these have no angle. Switch to the bar view
        to see {excluded.length === 1 ? "it" : "them"} with the rest:{" "}
        {excluded
          .map((row) => `${row.name} (${formatMoney(row.cents, currency)})`)
          .join(", ")}
        .
      </div>
    </div>
  );
}
