export const PRIVACY_STORAGE_KEY = "localfi-privacy-mode";

/** Preserve punctuation/currency while making every decimal digit unreadable. */
export function maskPrivacyDigits(value: string): string {
  return value.replace(/\d/g, "•");
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
