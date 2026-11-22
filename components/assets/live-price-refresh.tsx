"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { refreshLivePricedAssets } from "@/app/actions/crypto";
import { Button } from "@/components/ui/button";

export function LivePriceRefresh({ onRefresh }: { onRefresh: () => void | Promise<void> }) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await refreshLivePricedAssets();
      const unavailable = result.failed.length + result.unpriceable.length;
      setMessage(unavailable > 0
        ? `${unavailable} quote${unavailable === 1 ? "" : "s"} unavailable; last stored values kept.`
        : result.refreshed > 0 ? "Prices updated" : "");
      if (result.refreshed > 0) {
        await onRefresh();
        window.dispatchEvent(new Event("localfi:financial-updated"));
      }
    } catch {
      setMessage("Prices unavailable; last stored values kept. Try again shortly.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [onRefresh]);

  useEffect(() => {
    const refreshVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    refreshVisible();
    const interval = window.setInterval(refreshVisible, 60_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [refresh]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
        <RefreshCw className={`mr-2 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
        {busy ? "Refreshing prices…" : "Refresh prices"}
      </Button>
      <span role="status" className="text-xs text-muted-foreground">{message}</span>
    </div>
  );
}
