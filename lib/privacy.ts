export const PRIVACY_STORAGE_KEY = "localfi-privacy-mode";
export const PRIVACY_MASK_TOKEN = "••••";

export const PRIVACY_MASKED_ATTRIBUTES = [
  "aria-label",
  "aria-valuetext",
  "title",
] as const;

export function maskPrivacyDigits(value: string): string {
  return /\d/.test(value) ? PRIVACY_MASK_TOKEN : value;
}

export function maskPrivacyAttribute(value: string): string {
  return maskPrivacyDigits(value);
}

export const PRIVACY_BOOT_SCRIPT = `
try {
  var enabled = localStorage.getItem(${JSON.stringify(PRIVACY_STORAGE_KEY)}) === "true";
  document.documentElement.dataset.privacyMode = enabled ? "true" : "false";
  delete document.documentElement.dataset.privacyReady;
} catch (_) {
  document.documentElement.dataset.privacyMode = "false";
}
`;
