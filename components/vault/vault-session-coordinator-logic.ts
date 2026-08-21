export type VaultStatusPayload = {
  status?: unknown;
};

export function statusRequest(activityPending: boolean): {
  method: "GET" | "POST";
  body?: string;
  headers?: { "content-type": string };
} {
  return activityPending
    ? {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }
    : { method: "GET" };
}

export function vaultStatusIsUnlocked(payload: VaultStatusPayload): boolean {
  return payload.status === "unlocked";
}
