import type { VaultStatus } from "@/lib/vault/session";

export type VaultPanelMode = "setup" | "unlock" | "recovery";

export function initialVaultPanelMode(status: VaultStatus): VaultPanelMode {
  return status === "uninitialized" ? "setup" : "unlock";
}

export function canContinueAfterRecovery(savedConfirmation: boolean): boolean {
  return savedConfirmation;
}

export function setupCredentialFromFragment(fragment: string): string {
  const value = new URLSearchParams(fragment.replace(/^#/, "")).get("setup") ?? "";
  return value.length >= 24 && value.length <= 512 ? value : "";
}
