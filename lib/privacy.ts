export const PRIVACY_STORAGE_KEY = "localfi-privacy-mode";

/** Runs before paint so a saved private session never briefly reveals the page. */
export const PRIVACY_BOOT_SCRIPT = `
try {
  var enabled = localStorage.getItem(${JSON.stringify(PRIVACY_STORAGE_KEY)}) === "true";
  document.documentElement.dataset.privacyMode = enabled ? "true" : "false";
} catch (_) {
  document.documentElement.dataset.privacyMode = "false";
}
`;
