"use client";

import { useEffect, useState } from "react";

import {
  statusRequest,
  vaultStatusIsUnlocked,
  type VaultStatusPayload,
} from "./vault-session-coordinator-logic";

const STATUS_INTERVAL_MS = 15_000;

export function VaultSessionCoordinator() {
  const [status, setStatus] = useState<"checking" | "unlocked" | "locked">("checking");

  useEffect(() => {
    let activityPending = false;
    let checking = false;
    let stopped = false;

    const markActivity = () => {
      activityPending = true;
    };

    const showLockScreen = () => {
      if (stopped) return;
      setStatus("locked");
      window.location.replace("/vault");
    };

    const checkStatus = async () => {
      if (checking || stopped) return;
      checking = true;
      const touching = activityPending;
      activityPending = false;
      try {
        const response = await fetch("/api/vault/status", {
          ...statusRequest(touching),
          credentials: "same-origin",
          cache: "no-store",
        });
        const payload = await response.json() as VaultStatusPayload;
        if (!response.ok || !vaultStatusIsUnlocked(payload)) showLockScreen();
        else if (!stopped) setStatus("unlocked");
      } catch {
        // A transient local-server failure is retried on the next interval.
      } finally {
        checking = false;
      }
    };

    const activityOptions = { capture: true, passive: true } as const;
    document.addEventListener("pointerdown", markActivity, activityOptions);
    document.addEventListener("keydown", markActivity, activityOptions);
    document.addEventListener("scroll", markActivity, activityOptions);
    document.addEventListener("touchstart", markActivity, activityOptions);
    window.addEventListener("focus", markActivity);

    void checkStatus();
    const interval = window.setInterval(() => void checkStatus(), STATUS_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("pointerdown", markActivity, true);
      document.removeEventListener("keydown", markActivity, true);
      document.removeEventListener("scroll", markActivity, true);
      document.removeEventListener("touchstart", markActivity, true);
      window.removeEventListener("focus", markActivity);
    };
  }, []);

  if (status === "unlocked") return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background"
      role="status"
      aria-live="assertive"
    >
      <p className="text-sm text-muted-foreground">
        {status === "locked" ? "LocalFi is locked. Returning to the vault…" : "Checking vault…"}
      </p>
    </div>
  );
}
