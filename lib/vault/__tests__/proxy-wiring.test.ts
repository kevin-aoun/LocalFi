import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config, proxy } from "../../../proxy";
import { VAULT_SESSION_COOKIE } from "../constants";

const TOKEN = "b".repeat(43);
let originalFixtureMode: string | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalFixtureMode === undefined) delete process.env.LOCALFI_VAULT_TEST_MODE;
  else process.env.LOCALFI_VAULT_TEST_MODE = originalFixtureMode;
});

describe("dashboard vault proxy", () => {
  it("redirects a stale session to the vault before dashboard rendering", async () => {
    originalFixtureMode = process.env.LOCALFI_VAULT_TEST_MODE;
    delete process.env.LOCALFI_VAULT_TEST_MODE;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "locked" })));
    const response = await proxy(new NextRequest("http://localhost:1313/accounts", {
      headers: { cookie: `${VAULT_SESSION_COOKIE}=${TOKEN}` },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:1313/vault");
    expect(response.headers.get("set-cookie")).toContain(`${VAULT_SESSION_COOKIE}=`);
    expect(response.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970");
  });

  it("allows an active opaque session through without weakening route authorization", async () => {
    originalFixtureMode = process.env.LOCALFI_VAULT_TEST_MODE;
    delete process.env.LOCALFI_VAULT_TEST_MODE;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "unlocked" })));
    const response = await proxy(new NextRequest("http://localhost:1313/reports", {
      headers: { cookie: `${VAULT_SESSION_COOKIE}=${TOKEN}` },
    }));

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("leaves the explicit disposable fixture bypass to the guarded database seam", async () => {
    originalFixtureMode = process.env.LOCALFI_VAULT_TEST_MODE;
    process.env.LOCALFI_VAULT_TEST_MODE = "plaintext";
    const fetchStatus = vi.fn();
    vi.stubGlobal("fetch", fetchStatus);

    const response = await proxy(new NextRequest("http://localhost:1313/"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("matches only dashboard page families", () => {
    expect(config.matcher).toEqual([
      "/",
      "/accounts/:path*",
      "/transactions/:path*",
      "/recurring/:path*",
      "/budgets/:path*",
      "/reports/:path*",
      "/travel/:path*",
      "/ledger/:path*",
      "/settings/:path*",
    ]);
  });
});
