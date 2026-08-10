export const PRIVACY_STORAGE_KEY = "localfi-privacy-mode";
export const PRIVACY_MASK_TOKEN = "••••";

export const PRIVACY_MASKED_ATTRIBUTES = [
  "aria-label",
  "aria-valuetext",
  "title",
] as const;

/** Replace any digit-bearing value with one fixed-size privacy token. */
export function maskPrivacyDigits(value: string): string {
  return /\d/.test(value) ? PRIVACY_MASK_TOKEN : value;
}

/** Accessible labels use the same fixed token and can be restored exactly. */
export function maskPrivacyAttribute(value: string): string {
  return maskPrivacyDigits(value);
}

/** Runs before paint so a saved private session never briefly reveals the page. */
export const PRIVACY_BOOT_SCRIPT = `
try {
  var enabled = localStorage.getItem(${JSON.stringify(PRIVACY_STORAGE_KEY)}) === "true";
  document.documentElement.dataset.privacyMode = enabled ? "true" : "false";
  delete document.documentElement.dataset.privacyReady;
} catch (_) {
  document.documentElement.dataset.privacyMode = "false";
}
`;
