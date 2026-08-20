"use client";

import { useState } from "react";
import { Check } from "lucide-react";

import { confirmTransaction } from "@/app/actions/transactions";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fromDateKey, toDateKey, todayKey, type DateKey } from "@/lib/dates";

type ConfirmPendingTransactionProps = {
  transactionId: number;
  onConfirmed: () => Promise<void> | void;
  onError: (message: string) => void;
};

export function ConfirmPendingTransaction({
  transactionId,
  onConfirmed,
  onError,
}: ConfirmPendingTransactionProps) {
  const [open, setOpen] = useState(false);
  const today = todayKey();
  const [selectedDate, setSelectedDate] = useState<DateKey>(today);

  const confirmFor = async (dateKey: DateKey) => {
    setSelectedDate(dateKey);
    const result = await confirmTransaction(transactionId, dateKey);
    if (result && "error" in result && result.error) {
      onError(result.error);
      return;
    }
    setOpen(false);
    await onConfirmed();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Confirm transaction">
              <Check className="h-4 w-4 text-green-600" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Confirm transaction</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-auto p-3" align="end">
        <div className="flex flex-col gap-2">
          <Button type="button" variant="outline" onClick={() => void confirmFor(today)}>
            Confirm for today
          </Button>
          <Calendar
            mode="single"
            selected={fromDateKey(selectedDate)}
            onSelect={(date) => {
              if (date) void confirmFor(toDateKey(date));
            }}
            initialFocus
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
