"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  describeColor,
  findPreset,
  hexInputError,
  isValidHex,
  nextSwatchIndex,
  normalizeHex,
  type ColorPreset,
} from "@/components/ui/color-picker-logic";

export type { ColorPreset };

export interface ColorPickerProps
  extends Omit<React.ComponentPropsWithoutRef<typeof Button>, "value" | "onChange" | "children"> {
  /**
   * The current colour. Either a hex in any accepted spelling, or the `value`
   * of a sentinel preset such as `"default"`. Controlled: this component never
   * holds the selection itself.
   */
  value: string;
  /**
   * Called with a value that is ALREADY VALID: a canonical `#rrggbb` for typed
   * or preset hexes, or a preset's exact sentinel string. Half-typed input
   * never reaches this callback, so it is safe to persist whatever it hands you.
   */
  onValueChange: (value: string) => void;
  /** One-click swatches. Order is the arrow-key order. */
  presets?: readonly ColorPreset[];
  /** Swatches per row. Drives both the CSS grid and Up/Down arrow movement. */
  columns?: number;
  /** Show the free-form hex field. Defaults to true. */
  allowCustom?: boolean;
  /** Label for the hex field. */
  customLabel?: string;
  disabled?: boolean;
}

/**
 * A colour picker built from the shadcn primitives this project already
 * vendors: a `Button` trigger, a `Popover` holding a keyboard-navigable swatch
 * grid, and an `Input` for any hex the presets do not cover.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not commit a colour while you type.
 * A hex is only applied on Enter or on the Apply button, because otherwise
 * typing `#a855f7` would apply `#a85` (= `#aa8855`, a perfectly valid but
 * completely wrong brown) on the way through. See `hexInputError` and
 * `normalizeHex` in ./color-picker-logic.ts for the validation rules; all of it
 * is pure so it can be unit tested without a DOM.
 *
 * ACCESSIBILITY: the swatch grid is a `radiogroup` with roving tabindex. The
 * selection is exposed via `aria-checked` and drawn with a check mark, never by
 * ring colour alone — a colour picker whose only "you are here" cue is a
 * coloured outline is useless to exactly the people most likely to be changing
 * the colours. Arrow keys MOVE FOCUS ONLY; Enter or Space commits. That is a
 * deliberate departure from select-follows-focus radio semantics, because here
 * every selection repaints the whole app and hits the database.
 */
const ColorPicker = React.forwardRef<HTMLButtonElement, ColorPickerProps>(function ColorPicker(
  {
    value,
    onValueChange,
    presets = [],
    columns = 4,
    allowCustom = true,
    customLabel = "Custom color",
    disabled,
    className,
    id,
    "aria-label": ariaLabel,
    ...buttonProps
  },
  ref,
) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(() => normalizeHex(value) ?? "");

  const reactId = React.useId();
  const hexInputId = `${reactId}-hex`;
  const hexMessageId = `${reactId}-hex-message`;

  const selectedPreset = findPreset(value, presets);
  const selectedIndex = selectedPreset ? presets.indexOf(selectedPreset) : -1;
  const [focusIndex, setFocusIndex] = React.useState(() => (selectedIndex >= 0 ? selectedIndex : 0));
  const swatchRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  // Re-sync the draft whenever the popover opens or the controlled value moves
  // underneath us, so a rejected entry never lingers into the next session of
  // the popover.
  React.useEffect(() => {
    setDraft(normalizeHex(value) ?? "");
  }, [value, open]);

  const draftError = hexInputError(draft);
  const draftHex = normalizeHex(draft);
  const canApplyDraft = draftHex !== null && draftHex !== normalizeHex(value);

  const commitPreset = (preset: ColorPreset) => {
    // Hex presets are normalized so the stored value has one spelling; sentinel
    // presets ("default") are passed through untouched.
    onValueChange(normalizeHex(preset.value) ?? preset.value);
    setOpen(false);
  };

  const commitDraft = () => {
    if (draftHex === null) return;
    onValueChange(draftHex);
    setOpen(false);
  };

  const handleGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = nextSwatchIndex(event.key, focusIndex, presets.length, columns);
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    swatchRefs.current[next]?.focus();
  };

  const triggerLabel = describeColor(value, presets);

  return (
    // A local provider so the swatch tooltips work even where the app has not
    // mounted one. Nesting inside an app-level TooltipProvider is supported by
    // Radix; the inner one simply wins for these tooltips.
    <TooltipProvider delayDuration={300}>
      <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
        <PopoverTrigger asChild>
          <Button
            {...buttonProps}
            ref={ref}
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            aria-label={ariaLabel === undefined ? undefined : `${ariaLabel}: ${triggerLabel}`}
            className={cn("justify-start gap-2 font-normal", className)}
          >
            <ColorSwatch value={value} preset={selectedPreset} className="h-5 w-5" />
            <span className="truncate">{triggerLabel}</span>
          </Button>
        </PopoverTrigger>

        <PopoverContent
          className="w-72 space-y-4"
          align="start"
          onOpenAutoFocus={(event) => {
            // Land on the current colour rather than on the first thing in the
            // DOM, so a keyboard user knows where they are.
            const target = swatchRefs.current[selectedIndex >= 0 ? selectedIndex : 0];
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          {presets.length > 0 && (
            <div
              role="radiogroup"
              aria-label="Preset colors"
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))` }}
              onKeyDown={handleGridKeyDown}
            >
              {presets.map((preset, index) => {
                const checked = preset === selectedPreset;
                return (
                  <Tooltip key={preset.value}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        aria-label={preset.name}
                        // Roving tabindex: exactly one swatch is in the tab
                        // order, arrow keys move between them.
                        tabIndex={index === focusIndex ? 0 : -1}
                        ref={(node) => {
                          swatchRefs.current[index] = node;
                        }}
                        onFocus={() => setFocusIndex(index)}
                        onClick={() => commitPreset(preset)}
                        className={cn(
                          "relative flex h-9 w-9 items-center justify-center rounded-full border-2 transition-transform",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
                          "hover:scale-110",
                          checked ? "border-foreground" : "border-transparent",
                          // Sentinel presets ("Default") have no hex to paint
                          // with, so they bring their own Tailwind classes.
                          isHexPreset(preset) ? undefined : (preset.swatchClassName ?? "bg-muted"),
                        )}
                        style={swatchStyle(preset.value)}
                      >
                        <span
                          className={cn(
                            "pointer-events-none rounded-full bg-black/30 p-0.5",
                            checked ? "opacity-100" : "opacity-0",
                          )}
                        >
                          <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} aria-hidden="true" />
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{preset.name}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          )}

          {allowCustom && (
            <div className="space-y-2">
              <Label htmlFor={hexInputId}>{customLabel}</Label>
              <div className="flex items-center gap-2">
                <ColorSwatch
                  value={draftHex ?? value}
                  preset={draftHex === null ? selectedPreset : undefined}
                  className="h-8 w-8 shrink-0"
                />
                <Input
                  id={hexInputId}
                  value={draft}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="#0ea5e9"
                  aria-invalid={draftError !== null}
                  aria-describedby={hexMessageId}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    // Do not let Enter bubble out to a surrounding form.
                    event.preventDefault();
                    commitDraft();
                  }}
                  className={cn(draftError !== null && "border-destructive focus-visible:ring-destructive")}
                />
                <Button type="button" size="sm" onClick={commitDraft} disabled={!canApplyDraft}>
                  Apply
                </Button>
              </div>
              <p
                id={hexMessageId}
                className={cn("text-xs", draftError !== null ? "text-destructive" : "text-muted-foreground")}
              >
                {draftError ?? "Type #rgb or #rrggbb, then press Enter or Apply."}
              </p>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
});
ColorPicker.displayName = "ColorPicker";

/** True when the preset's value is a real colour rather than a sentinel. */
function isHexPreset(preset: ColorPreset): boolean {
  return isValidHex(preset.value);
}

/** Inline background for hex values; `undefined` lets a CSS class paint it. */
function swatchStyle(value: string): React.CSSProperties | undefined {
  const hex = normalizeHex(value);
  return hex === null ? undefined : { backgroundColor: hex };
}

/**
 * The round colour chip used on the trigger and next to the hex field.
 * Purely decorative: the value it represents is always available as text
 * beside it, so it is hidden from assistive technology.
 */
function ColorSwatch({
  value,
  preset,
  className,
}: {
  value: string;
  preset?: ColorPreset;
  className?: string;
}) {
  const hex = normalizeHex(value);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 rounded-full border border-border",
        hex === null ? (preset?.swatchClassName ?? "bg-muted") : undefined,
        className,
      )}
      style={hex === null ? undefined : { backgroundColor: hex }}
    />
  );
}

export { ColorPicker };
