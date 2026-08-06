"use client";

import * as React from "react";
import { maskPrivacyDigits, PRIVACY_STORAGE_KEY } from "@/lib/privacy";

type PrivacyContextValue = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
};

const PrivacyContext = React.createContext<PrivacyContextValue | null>(null);

const originalText = new Map<Text, string>();
let privacyObserver: MutationObserver | null = null;

function isMaskable(node: Text): boolean {
  const parent = node.parentElement;
  return Boolean(
    parent &&
      !parent.closest(
        "script, style, noscript, [data-privacy-exempt], [data-private-chart]",
      ),
  );
}

function maskTextNode(node: Text) {
  if (!isMaskable(node)) return;
  const current = node.data;
  if (/\d/.test(current)) {
    originalText.set(node, current);
    node.data = maskPrivacyDigits(current);
    return;
  }

  const original = originalText.get(node);
  if (original !== undefined && current !== maskPrivacyDigits(original)) {
    // React replaced a formerly numeric text node with an ordinary label.
    originalText.delete(node);
  }
}

function maskTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    maskTextNode(root as Text);
    return;
  }
  if (!(root instanceof Element) || root.matches("script, style, noscript")) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    maskTextNode(node as Text);
    node = walker.nextNode();
  }
}

function startPrivacyMask() {
  if (!document.body) return;
  maskTree(document.body);
  privacyObserver?.disconnect();
  privacyObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") maskTextNode(record.target as Text);
      for (const added of record.addedNodes) maskTree(added);
    }
  });
  privacyObserver.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  document.documentElement.dataset.privacyReady = "true";
}

function stopPrivacyMask() {
  privacyObserver?.disconnect();
  privacyObserver = null;
  for (const [node, original] of originalText) {
    if (node.isConnected && node.data === maskPrivacyDigits(original)) node.data = original;
  }
  originalText.clear();
  delete document.documentElement.dataset.privacyReady;
}

function applyPrivacyMode(enabled: boolean) {
  document.documentElement.dataset.privacyMode = enabled ? "true" : "false";
  if (enabled) startPrivacyMask();
  else stopPrivacyMask();
  try {
    window.localStorage.setItem(PRIVACY_STORAGE_KEY, enabled ? "true" : "false");
  } catch (error) {
    // Storage can be unavailable in hardened/private browser contexts. The
    // in-memory toggle still works for this page, so report rather than fail it.
    console.warn("Could not persist privacy mode:", error);
  }
}

export function PrivacyProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setState] = React.useState(false);

  React.useLayoutEffect(() => {
    // The inline boot script applies this before first paint, preventing a flash
    // of private data. Adopt that value once React mounts.
    const active = document.documentElement.dataset.privacyMode === "true";
    setState(active);
    if (active) startPrivacyMask();
    return () => privacyObserver?.disconnect();
  }, []);

  const setEnabled = React.useCallback((next: boolean) => {
    setState(next);
    applyPrivacyMode(next);
  }, []);

  const value = React.useMemo(() => ({ enabled, setEnabled }), [enabled, setEnabled]);
  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}

export function usePrivacyMode(): PrivacyContextValue {
  const context = React.useContext(PrivacyContext);
  if (!context) throw new Error("usePrivacyMode must be used within PrivacyProvider");
  return context;
}
