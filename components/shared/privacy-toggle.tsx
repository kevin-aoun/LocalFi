"use client";

import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePrivacyMode } from "./privacy-provider";

export function PrivacyToggle() {
  const { enabled, setEnabled } = usePrivacyMode();
  const label = enabled ? "Turn privacy mode off" : "Turn privacy mode on";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={enabled}
          onClick={() => setEnabled(!enabled)}
        >
          {enabled ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
