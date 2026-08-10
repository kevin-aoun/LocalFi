"use client";

/** Expandable asset-category rows. Grouping and filter arithmetic live in asset-table.ts. */

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { Archive, ChevronDown, ChevronRight, Eye, EyeOff, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { barWidth, formatShare, type AllocationRow } from "@/components/assets/currency-totals";
import type { SidebarAssetRow } from "@/components/shared/sidebar-assets";
import { cn } from "@/lib/utils";
import {
  ACCOUNT_MANAGE_HREF,
  assetCategoryColor,
  categoryHoldingKeys,
  defaultExpandedKeys,
  type AssetCategoryRow,
  type AssetTableFilter,
  type AssetTableHolding,
  type AssetTableView,
} from "./asset-table";

/** The 10-segment weight meter, rounded from the row's own share. */
function WeightMeter({ percentage }: { percentage: number | null }) {
  const filled = Math.round(barWidth(percentage) / 10);
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 10 }).map((_, i) => (
        <div
          key={i}
          className={cn("h-4 w-1 rounded-sm", i < filled ? "bg-primary" : "bg-muted")}
        />
      ))}
    </div>
  );
}

/**
 * A category's share. One line per currency: a category spanning USD and EUR has
 * two shares — of two different totals — and averaging them would be inventing an
 * exchange rate.
 */
function CategoryWeight({
  entries,
  showCurrency,
}: {
  entries: AllocationRow[];
  showCurrency: boolean;
}) {
  return (
    <div className="space-y-1">
      {entries.map((entry) => (
        <div key={entry.currency} className="flex items-center gap-2">
          <WeightMeter percentage={entry.percentage} />
          <span className="text-sm">{formatShare(entry.percentage)}</span>
          {showCurrency && (
            <span className="text-xs text-muted-foreground">of {entry.currency}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The eye. Removes a row from every figure on this screen, so its label says so
 * rather than just "Hide" — the owner should not have to discover that hiding
 * moved his total.
 */
function HideButton({ label, onHide }: { label: string; onHide: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Hide ${label}: excludes it from the totals below`}
          onClick={onHide}
        >
          <Eye className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Hide from the totals and percentages</TooltipContent>
    </Tooltip>
  );
}

/**
 * Per-holding controls.
 *
 * An ACCOUNT line has no `assets` row behind it: Edit and Delete here would act on
 * nothing, or — worse — on an unrelated asset with a colliding id. It gets a link
 * to the page that owns it instead. The discriminated union in ./asset-table.ts
 * makes this a compile-time choice, not a convention.
 */
function HoldingActions<T extends SidebarAssetRow>({
  holding,
  onEdit,
  onArchive,
  onDelete,
  onHide,
}: {
  holding: AssetTableHolding<T>;
  onEdit: (asset: T) => void;
  onArchive: (assetId: number) => void;
  onDelete: (assetId: number) => void;
  onHide: (keys: string[]) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <HideButton label={holding.name} onHide={() => onHide([holding.key])} />
      {holding.source === "asset" ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Archive ${holding.name}`}
            onClick={() => onArchive(holding.asset.id)}
          >
            <Archive className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${holding.name}`}
            onClick={() => onEdit(holding.asset)}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Delete ${holding.name}`}
            onClick={() => onDelete(holding.asset.id)}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </>
      ) : (
        <Button variant="ghost" size="sm" asChild>
          <Link href={ACCOUNT_MANAGE_HREF} aria-label={`Manage ${holding.name} in Accounts`}>
            <Pencil className="h-4 w-4" />
          </Link>
        </Button>
      )}
    </div>
  );
}

function CategoryRows<T extends SidebarAssetRow>({
  category,
  expanded,
  onToggle,
  mixedCurrency,
  onEdit,
  onArchive,
  onDelete,
  onHide,
}: {
  category: AssetCategoryRow<T>;
  expanded: boolean;
  onToggle: () => void;
  mixedCurrency: boolean;
  onEdit: (asset: T) => void;
  onArchive: (assetId: number) => void;
  onDelete: (assetId: number) => void;
  onHide: (keys: string[]) => void;
}) {
  const inline = category.inlineHolding;

  return (
    <Fragment>
      <tr className="border-b last:border-0 hover:bg-muted/50">
        <td className="px-6 py-4">
          <div className="flex items-start gap-2">
            {category.collapsible ? (
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                className="-ml-1 flex items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-accent/50"
              >
                {expanded ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: assetCategoryColor(category.name) }}
                />
                <span>
                  <span className="block font-medium">{category.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {category.count} {category.count === 1 ? "holding" : "holdings"}
                  </span>
                </span>
              </button>
            ) : (
              // Exactly one holding: no disclosure triangle, and the holding's own
              // detail sits on the category row rather than one click below a
              // number it would only repeat.
              <div className="flex items-start gap-2 p-1">
                <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: assetCategoryColor(category.name) }} />
                <div>
                  <div className="font-medium">{category.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {inline === null
                      ? "No holdings"
                      : inline.detail === null
                        ? inline.name
                        : `${inline.name} · ${inline.detail}`}
                    {inline?.note ? ` · ${inline.note}` : ""}
                  </div>
                </div>
              </div>
            )}
          </div>
        </td>

        <td className="px-6 py-4">
          <CategoryWeight
            entries={category.entries}
            showCurrency={mixedCurrency || category.mixed}
          />
        </td>

        {/* The `title` here was conditional, so the tooltip is too: an unmixed
            total gets no trigger at all rather than an empty one. The trigger is
            the inner div, not the `<td>` — Radix would put button semantics and
            event handlers on a table cell otherwise — and it takes `tabIndex` so
            the currency list is reachable without a mouse. */}
        <td className="px-6 py-4 text-right font-medium">
          {category.mixed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  tabIndex={0}
                  className="rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {category.totalLabel}
                  <div className="text-[10px] font-normal text-amber-600 dark:text-amber-400">
                    mixed currencies
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {`Mixed currencies (${category.currencies.join(", ")}): subtotalled separately, no exchange rates applied`}
              </TooltipContent>
            </Tooltip>
          ) : (
            category.totalLabel
          )}
        </td>

        <td className="px-6 py-4">
          {inline === null ? (
            // A collapsible category has no single record to act on, so Edit and
            // Delete belong to the holdings inside it — but the eye still works at
            // the category level: it hides every holding underneath it at once.
            <div className="flex items-center justify-end gap-2">
              {!expanded && (
                <span className="text-xs text-muted-foreground">Expand to edit</span>
              )}
              <HideButton
                label={`all ${category.count} ${category.name} holdings`}
                onHide={() => onHide(categoryHoldingKeys(category))}
              />
            </div>
          ) : (
            <HoldingActions
              holding={inline}
              onEdit={onEdit}
              onArchive={onArchive}
              onDelete={onDelete}
              onHide={onHide}
            />
          )}
        </td>
      </tr>

      {category.collapsible &&
        expanded &&
        category.holdings.map((holding) => (
          <tr
            key={holding.key}
            className="border-b bg-muted/20 last:border-0 hover:bg-muted/40"
          >
            <td className="py-3 pl-16 pr-6">
              <div className="text-sm">{holding.name}</div>
              {(holding.detail || holding.note) && (
                <div className="text-xs text-muted-foreground">
                  {[holding.detail, holding.note].filter(Boolean).join(" · ")}
                </div>
              )}
            </td>
            <td className="px-6 py-3" />
            <td className="px-6 py-3 text-right font-mono text-sm">{holding.amountLabel}</td>
            <td className="px-6 py-3">
              <HoldingActions
                holding={holding}
                onEdit={onEdit}
                onArchive={onArchive}
                onDelete={onDelete}
                onHide={onHide}
              />
            </td>
          </tr>
        ))}
    </Fragment>
  );
}

/**
 * THE WARNING. Rendered by the page between the heading total and the allocation
 * bar — the two things the filter changes — whenever `filter.active`.
 *
 * It is deliberately a banner and not a badge: the owner asked for hiding to
 * change the figures, and a control that changes money on screen must announce
 * itself in words. `filter.notice` names how many holdings are excluded, what
 * they are worth, and the real unfiltered total, so the number beside it cannot
 * be mistaken for his actual position. The wording is built and tested in
 * ./asset-table.ts.
 */
export function AssetFilterNotice<T extends SidebarAssetRow>({
  filter,
  onShow,
  onShowAll,
}: {
  filter: AssetTableFilter<T>;
  onShow: (keys: string[]) => void;
  onShowAll: () => void;
}) {
  if (!filter.active) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 rounded-lg border-2 border-amber-500/70 bg-amber-50 px-4 py-3 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <div className="flex flex-wrap items-start gap-3">
        <EyeOff className="mt-0.5 h-5 w-5 shrink-0" />
        <p className="min-w-[16rem] flex-1 text-sm font-medium">{filter.notice}</p>
        <Button
          variant="outline"
          size="sm"
          className="border-amber-600 bg-transparent text-amber-900 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900"
          onClick={onShowAll}
        >
          <Eye className="mr-2 h-4 w-4" />
          Show all
        </Button>
      </div>

      {/* Every hidden holding, by name and value, each restorable on its own — so
          the owner can see exactly what he removed rather than a bare count. */}
      <div className="mt-3 flex flex-wrap gap-2 pl-8">
        {filter.hidden.map((holding) => (
          <Tooltip key={holding.key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onShow([holding.key])}
                aria-label={`Show ${holding.name} again`}
                className="flex items-center gap-1.5 rounded-full border border-amber-600/50 bg-amber-100/60 px-2.5 py-1 text-xs transition-colors hover:bg-amber-200 dark:bg-amber-900/50 dark:hover:bg-amber-900"
              >
                <EyeOff className="h-3 w-3" />
                <span className="font-medium">{holding.name}</span>
                <span className="font-mono">{holding.amountLabel}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Put this back into the totals</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

export function AssetTable<T extends SidebarAssetRow>({
  view,
  onEdit,
  onArchive,
  onDelete,
  onHide,
  onShowAll,
}: {
  view: AssetTableView<T>;
  onEdit: (asset: T) => void;
  onArchive: (assetId: number) => void;
  onDelete: (assetId: number) => void;
  /** Hide these holding keys. View state only — never written anywhere. */
  onHide: (keys: string[]) => void;
  onShowAll: () => void;
}) {
  // Seeded once from the pure rule in ./asset-table.ts, then owned by the user.
  // Keyed on the category keys so a reload with a new category does not reset a
  // deliberate collapse, but a genuinely different portfolio re-seeds.
  const seed = useMemo(() => defaultExpandedKeys(view), [view]);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());

  const toggle = (key: string, currentlyExpanded: boolean) => {
    setOverrides((current) => {
      const next = new Map(current);
      next.set(key, !currentlyExpanded);
      return next;
    });
  };

  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <th className="px-6 py-4 text-left text-sm font-medium text-muted-foreground">
                CATEGORY
              </th>
              <th className="px-6 py-4 text-left text-sm font-medium text-muted-foreground">
                WEIGHT
              </th>
              <th className="px-6 py-4 text-right text-sm font-medium text-muted-foreground">
                VALUE
              </th>
              <th className="px-6 py-4 text-right text-sm font-medium text-muted-foreground">
                ACTIONS
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Everything hidden. NOT the "no assets yet" empty state: the owner
                has assets, he has filtered them all out, and the difference
                matters — so the row says so and offers the way back. */}
            {view.filter.allHidden ? (
              <tr>
                <td colSpan={4} className="px-6 py-10 text-center">
                  <p className="text-sm font-medium">
                    Every holding is hidden. This table is showing{" "}
                    {view.visibleTotalsLabel} of your{" "}
                    {view.filter.unfilteredTotalsLabel} in assets.
                  </p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={onShowAll}>
                    <Eye className="mr-2 h-4 w-4" />
                    Show all {view.filter.totalCount} holdings
                  </Button>
                </td>
              </tr>
            ) : (
              view.categories.map((category) => {
                const expanded = overrides.get(category.key) ?? seed.has(category.key);
                return (
                  <CategoryRows
                    key={category.key}
                    category={category}
                    expanded={expanded}
                    onToggle={() => toggle(category.key, expanded)}
                    mixedCurrency={view.mixed}
                    onEdit={onEdit}
                    onArchive={onArchive}
                    onDelete={onDelete}
                    onHide={onHide}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
