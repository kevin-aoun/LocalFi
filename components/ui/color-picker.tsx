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

  value: string;

  onValueChange: (value: string) => void;

  presets?: readonly ColorPreset[];

  columns?: number;

  allowCustom?: boolean;

  customLabel?: string;
  disabled?: boolean;
}

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




  React.useEffect(() => {
    setDraft(normalizeHex(value) ?? "");
  }, [value, open]);

  const draftError = hexInputError(draft);
  const draftHex = normalizeHex(draft);
  const canApplyDraft = draftHex !== null && draftHex !== normalizeHex(value);

  const commitPreset = (preset: ColorPreset) => {


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


function isHexPreset(preset: ColorPreset): boolean {
  return isValidHex(preset.value);
}


function swatchStyle(value: string): React.CSSProperties | undefined {
  const hex = normalizeHex(value);
  return hex === null ? undefined : { backgroundColor: hex };
}


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
