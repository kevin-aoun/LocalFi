"use client";

import { ThemeProvider } from "next-themes";
import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resolveAccent } from "@/components/ui/color-picker-logic";
import { PrivacyProvider } from "@/components/shared/privacy-provider";
import { getSettings } from "./actions/settings";

/**
 * Applies the saved accent colour on load.
 *
 * ## Why the arithmetic is not here
 *
 * This file used to carry its own `hexToHSL` and its own rule for choosing the
 * foreground, duplicating the copies on the settings page. The two drifted, which
 * is the failure this app keeps paying for: picking a colour in Settings gave one
 * result, reloading the page gave another, and only one of them could be right.
 *
 * Both now call `resolveAccent`, so there is exactly one definition of what a
 * colour means. Its `pickForeground` measures real WCAG contrast rather than
 * guessing from HSL lightness — the old `lightness <= 60` rule put white text on
 * amber at 2.06:1, well under the 4.5:1 AA floor.
 */
function AccentColorProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let accent: string | null | undefined;
      try {
        accent = (await getSettings()).accentColor;
      } catch (cause) {
        // Not surfaced in the UI: this runs before anything is painted and a
        // missing accent is cosmetic, so the app must still render. Swallowing
        // it SILENTLY is what the convention forbids, hence the console record.
        console.error("Could not load the saved accent colour:", cause);
        return;
      }
      if (cancelled) return;

      const application = resolveAccent(accent);
      // `null` = a value the picker cannot render (a hand-edited setting, say).
      // Leave the stylesheet's own colours in place rather than applying junk.
      if (application === null) {
        console.warn("Saved accent colour is not a colour, ignoring:", accent);
        return;
      }

      const root = document.documentElement;
      if (application.kind === "reset") {
        for (const property of application.remove) root.style.removeProperty(property);
      } else {
        for (const [property, value] of Object.entries(application.set)) {
          root.style.setProperty(property, value);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <PrivacyProvider>
        <TooltipProvider delayDuration={200}>
          <AccentColorProvider>{children}</AccentColorProvider>
        </TooltipProvider>
      </PrivacyProvider>
    </ThemeProvider>
  );
}
