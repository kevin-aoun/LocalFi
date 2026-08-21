"use client";

import { useRef, useState, type ReactElement } from "react";
import { Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

import {
  createExportConfirmationGate,
  exportDisclosureCopy,
  type ExportFormat,
} from "./export-disclosure-logic";

type ExportDisclosureProps = {
  format: ExportFormat;
  children: ReactElement;
  onConfirm: () => Promise<void>;
};

export function ExportDisclosure({ format, children, onConfirm }: ExportDisclosureProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const gate = useRef(createExportConfirmationGate()).current;
  const copy = exportDisclosureCopy(format);

  const confirm = () => {
    setConfirming(true);
    void gate(onConfirm)
      .then(() => setOpen(false))
      .catch(() => undefined)
      .finally(() => setConfirming(false));
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !confirming && setOpen(next)}>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={confirming}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={confirming}
            onClick={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            {confirming && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {copy.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
