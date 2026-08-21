import { describe, expect, it, vi } from "vitest";

import { VAULT_SESSION_COOKIE } from "../constants";
import { proxyVaultSessionIsUnlocked } from "../proxy-session";

const TOKEN = "a".repeat(43);

describe("dashboard proxy vault session check", () => {
  it("fails closed without sending malformed or absent credentials", async () => {
    const fetchStatus = vi.fn();

    await expect(proxyVaultSessionIsUnlocked(null, fetchStatus)).resolves.toBe(false);
    await expect(proxyVaultSessionIsUnlocked("not-a-session", fetchStatus)).resolves.toBe(false);
    await expect(proxyVaultSessionIsUnlocked(TOKEN, fetchStatus, "invalid")).resolves.toBe(false);
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("forwards only the opaque vault cookie to the fixed loopback status route", async () => {
    const fetchStatus = vi.fn(async () => Response.json({ status: "unlocked" }));

    await expect(proxyVaultSessionIsUnlocked(TOKEN, fetchStatus, "1313")).resolves.toBe(true);
    expect(fetchStatus).toHaveBeenCalledWith(
      "http://127.0.0.1:1313/api/vault/status",
      expect.objectContaining({
        method: "GET",
        headers: { cookie: `${VAULT_SESSION_COOKIE}=${TOKEN}` },
        cache: "no-store",
      }),
    );
  });

  it("fails closed for locked, invalid, unsuccessful, and unreachable status responses", async () => {
    await expect(proxyVaultSessionIsUnlocked(
      TOKEN,
      async () => Response.json({ status: "locked" }),
    )).resolves.toBe(false);
    await expect(proxyVaultSessionIsUnlocked(
      TOKEN,
      async () => Response.json({ status: "unexpected" }),
    )).resolves.toBe(false);
    await expect(proxyVaultSessionIsUnlocked(
      TOKEN,
      async () => new Response(null, { status: 503 }),
    )).resolves.toBe(false);
    await expect(proxyVaultSessionIsUnlocked(TOKEN, async () => {
      throw new Error("offline");
    })).resolves.toBe(false);
  });
});
