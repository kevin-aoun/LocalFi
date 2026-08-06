"use client";

import * as React from "react";
import { PRIVACY_STORAGE_KEY } from "@/lib/privacy";

type PrivacyContextValue = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
};

const PrivacyContext = React.createContext<PrivacyContextValue | null>(null);

function applyPrivacyMode(enabled: boolean) {
  document.documentElement.dataset.privacyMode = enabled ? "true" : "false";
  try {
    window.localStorage.setItem(PRIVACY_STORAGE_KEY, enabled ? "true" : "false");
  } catch (error) {
    // Storage can be unavailable in hardened/private browser contexts. The
    // in-memory toggle still works for this page, so report rather than fail it.
    console.warn("Could not persist privacy mode:", error);
  }
}

export function PrivacyProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setState] = React.useState(false);

  React.useEffect(() => {
    // The inline boot script applies this before first paint, preventing a flash
    // of private data. Adopt that value once React mounts.
    setState(document.documentElement.dataset.privacyMode === "true");
  }, []);

  const setEnabled = React.useCallback((next: boolean) => {
    setState(next);
    applyPrivacyMode(next);
  }, []);

  const value = React.useMemo(() => ({ enabled, setEnabled }), [enabled, setEnabled]);
  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}

export function usePrivacyMode(): PrivacyContextValue {
  const context = React.useContext(PrivacyContext);
  if (!context) throw new Error("usePrivacyMode must be used within PrivacyProvider");
  return context;
}
