import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vaultStatusForRequest = vi.hoisted(() => vi.fn());
const currentVaultToken = vi.hoisted(() => vi.fn());
const lock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/vault/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vault/access")>();
  return {
    ...actual,
    vaultStatusForRequest,
    currentVaultToken,
  };
});

vi.mock("@/lib/vault/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vault/session")>();
  return {
    ...actual,
    vaultSessionManager: { lock },
  };
});

const { GET: getStatus, POST: touchStatus } = await import("../status/route");
const { POST: lockVault } = await import("../lock/route");

const ORIGIN = "http://127.0.0.1:1313";
const originalPort = process.env.PORT;

function jsonPost(path: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: "{}",
  });
}

beforeEach(() => {
  process.env.PORT = "1313";
  vaultStatusForRequest.mockReset().mockResolvedValue("unlocked");
  currentVaultToken.mockReset().mockResolvedValue("stale-session-token");
  lock.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  if (originalPort === undefined) {
    delete process.env.PORT;
    return;
  }
  process.env.PORT = originalPort;
});

describe("vault status activity boundary", () => {
  it("checks status without touching activity on GET", async () => {
    const response = await getStatus(new Request(`${ORIGIN}/api/vault/status`));

    expect(response.status).toBe(200);
    expect(vaultStatusForRequest).toHaveBeenCalledOnce();
    expect(vaultStatusForRequest).toHaveBeenCalledWith({ touch: false });
  });

  it("touches activity only through a guarded same-origin POST", async () => {
    const response = await touchStatus(jsonPost("/api/vault/status"));

    expect(response.status).toBe(200);
    expect(vaultStatusForRequest).toHaveBeenCalledOnce();
    expect(vaultStatusForRequest).toHaveBeenCalledWith({ touch: true });
  });
});

describe("idempotent vault lock route", () => {
  it("clears the browser session and succeeds when the server is already locked", async () => {
    const response = await lockVault(jsonPost("/api/vault/lock"));

    expect(lock).toHaveBeenCalledWith("stale-session-token");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "locked" });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
