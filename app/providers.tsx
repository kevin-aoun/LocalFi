"use client";

import { ThemeProvider } from "next-themes";
import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resolveAccent } from "@/components/ui/color-picker-logic";
import { PrivacyProvider } from "@/components/shared/privacy-provider";
import { getSettings } from "./actions/settings";

function AccentColorProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let accent: string | null | undefined;
      try {
        accent = (await getSettings()).accentColor;
      } catch (cause) {

        console.error("Could not load the saved accent colour:", cause);
        return;
      }
      if (cancelled) return;

      const application = resolveAccent(accent);

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
