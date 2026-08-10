"use server";

import {
  readLedgerEventPayload,
  readLedgerExplorerPage,
} from "@/lib/ledger/explorer";
import type {
  LedgerEventPayload,
  LedgerExplorerPage,
  LedgerExplorerQuery,
} from "@/lib/ledger/explorer-contract";
import { verifyLedger } from "@/lib/ledger/verify";
import type { LedgerVerificationResult } from "@/lib/ledger/types";

export type LedgerActionResult<T> = { success: true; data: T } | { error: string };

export async function getLedgerExplorerPage(
  input: LedgerExplorerQuery = {},
): Promise<LedgerActionResult<LedgerExplorerPage>> {
  try {
    return { success: true, data: await readLedgerExplorerPage(input) };
  } catch (error) {
    console.error("Failed to read the Ledger explorer page:", error);
    return {
      error: error instanceof Error ? error.message : "Could not load journal events.",
    };
  }
}

export async function getLedgerEventPayload(
  eventId: string,
): Promise<LedgerActionResult<LedgerEventPayload>> {
  try {
    return { success: true, data: await readLedgerEventPayload(eventId) };
  } catch (error) {
    console.error("Failed to read a Ledger event payload:", error);
    return {
      error: error instanceof Error ? error.message : "Could not load the event payload.",
    };
  }
}

export type LedgerVerificationView = LedgerVerificationResult & { verifiedAt: string };

export async function verifyLedgerIntegrity(): Promise<LedgerActionResult<LedgerVerificationView>> {
  try {
    const result = await verifyLedger();
    return {
      success: true,
      data: { ...result, verifiedAt: new Date().toISOString() },
    };
  } catch (error) {
    console.error("Failed to verify the Ledger:", error);
    return { error: "Ledger verification could not be completed." };
  }
}
