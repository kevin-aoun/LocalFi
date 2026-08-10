"use client";

import * as React from "react";
import {
  maskPrivacyDigits,
  maskPrivacyAttribute,
  PRIVACY_MASKED_ATTRIBUTES,
  PRIVACY_STORAGE_KEY,
} from "@/lib/privacy";

type PrivacyContextValue = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
};

const PrivacyContext = React.createContext<PrivacyContextValue | null>(null);

const originalText = new Map<Text, string>();
const originalAttributes = new Map<Element, Map<string, string>>();
let privacyObserver: MutationObserver | null = null;
const PRIVACY_EXEMPT_SELECTOR =
  "script, style, noscript, [data-privacy-exempt], [data-private-chart]";

export function isPrivacyExempt(parent: {
  closest: (selectors: string) => unknown;
}): boolean {
  return Boolean(parent.closest(PRIVACY_EXEMPT_SELECTOR));
}

function isMaskable(node: Text): boolean {
  const parent = node.parentElement;
  return Boolean(
    parent &&
      !isPrivacyExempt(parent),
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

function maskAccessibleAttributes(element: Element) {
  if (isPrivacyExempt(element)) return;

  for (const attribute of PRIVACY_MASKED_ATTRIBUTES) {
    const current = element.getAttribute(attribute);
    if (current === null) continue;

    const originals = originalAttributes.get(element);
    const original = originals?.get(attribute);
    // Ignore the provider's own masked write. React updates that replace the
    // label still arrive as a different value and are captured below.
    if (original !== undefined && current === maskPrivacyAttribute(original)) continue;

    if (/\d/.test(current)) {
      const saved = originals ?? new Map<string, string>();
      saved.set(attribute, current);
      originalAttributes.set(element, saved);
      element.setAttribute(attribute, maskPrivacyAttribute(current));
    } else if (originals?.delete(attribute) && originals.size === 0) {
      originalAttributes.delete(element);
    }
  }
}

function maskTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    maskTextNode(root as Text);
    return;
  }
  if (!(root instanceof Element) || root.matches("script, style, noscript")) return;
  const elements = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let element: Node | null = root;
  while (element) {
    maskAccessibleAttributes(element as Element);
    element = elements.nextNode();
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    maskTextNode(node as Text);
    maskAccessibleAttributes((node as Text).parentElement as Element);
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
      if (record.type === "attributes") maskAccessibleAttributes(record.target as Element);
      for (const added of record.addedNodes) maskTree(added);
    }
  });
  privacyObserver.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...PRIVACY_MASKED_ATTRIBUTES],
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
  for (const [element, attributes] of originalAttributes) {
    if (!element.isConnected) continue;
    for (const [attribute, original] of attributes) {
      if (element.getAttribute(attribute) === maskPrivacyAttribute(original)) {
        element.setAttribute(attribute, original);
      }
    }
  }
  originalAttributes.clear();
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
