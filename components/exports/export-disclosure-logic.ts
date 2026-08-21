export type ExportFormat = "csv" | "json" | "database";

export type ExportDisclosureCopy = {
  title: string;
  description: string;
  confirmLabel: string;
};

const COPY: Record<ExportFormat, ExportDisclosureCopy> = {
  csv: {
    title: "Download plaintext CSV?",
    description:
      "CSV is readable by Excel and similar spreadsheet apps. It is plaintext and remains outside LocalFi vault protection after download.",
    confirmLabel: "Download plaintext CSV",
  },
  json: {
    title: "Download plaintext JSON data export?",
    description:
      "This readable plaintext data export is not a restorable vault backup. It remains outside LocalFi vault protection after download, so store and share it carefully.",
    confirmLabel: "Download plaintext JSON",
  },
  database: {
    title: "Download encrypted vault?",
    description:
      "This portable database generation stays encrypted by your LocalFi vault, but it still contains sensitive financial data. Store it carefully and keep the passphrase and recovery secret separate.",
    confirmLabel: "Download encrypted vault",
  },
};

export function exportDisclosureCopy(format: ExportFormat): ExportDisclosureCopy {
  return COPY[format];
}

export function createExportConfirmationGate() {
  let active: Promise<void> | null = null;

  return (confirmedAction: () => Promise<void>): Promise<void> => {
    if (active) return active;
    active = Promise.resolve()
      .then(confirmedAction)
      .finally(() => {
        active = null;
      });
    return active;
  };
}
