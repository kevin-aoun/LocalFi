import { describe, expect, it } from "vitest";

import {
  assertSameOriginJsonPost,
  clearVaultCookie,
  rateLimitKey,
  VaultFailureRateLimiter,
  vaultCookie,
} from "../access";

function request(options: { origin?: string; contentType?: string; fetchSite?: string } = {}) {
  const headers = new Headers();
  if (options.origin) headers.set("origin", options.origin);
  if (options.contentType) headers.set("content-type", options.contentType);
  if (options.fetchSite) headers.set("sec-fetch-site", options.fetchSite);
  return new Request("http://127.0.0.1:1313/api/vault/unlock", {
    method: "POST",
    headers,
    body: "{}",
  });
}

describe("same-origin vault mutation boundary", () => {
  it("accepts only same-origin JSON posts", () => {
    expect(() => assertSameOriginJsonPost(request({
      origin: "http://127.0.0.1:1313",
      contentType: "application/json; charset=utf-8",
      fetchSite: "same-origin",
    }))).not.toThrow();

    expect(() => assertSameOriginJsonPost(request({
      contentType: "application/json",
    }))).toThrow(/origin/);
    expect(() => assertSameOriginJsonPost(request({
      origin: "http://evil.example",
      contentType: "application/json",
    }))).toThrow(/origin/);
    expect(() => assertSameOriginJsonPost(request({
      origin: "http://127.0.0.1:1313",
      contentType: "text/plain",
    }))).toThrow(/content/);

    const rebound = new Request("http://evil.example:3000/api/vault/unlock", {
      method: "POST",
      headers: {
        origin: "http://evil.example:3000",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(() => assertSameOriginJsonPost(rebound)).toThrow(/origin/);
    const wrongPort = new Request("http://localhost:3000/api/vault/unlock", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: "{}",
    });
    expect(() => assertSameOriginJsonPost(wrongPort)).toThrow(/origin/);
  });

  it("uses the HTTP Host header when the server URL contains its internal bind address", () => {
    const containerRequest = new Request("http://0.0.0.0:1313/api/vault/setup", {
      method: "POST",
      headers: {
        host: "127.0.0.1:1313",
        origin: "http://127.0.0.1:1313",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(() => assertSameOriginJsonPost(containerRequest)).not.toThrow();

    containerRequest.headers.set("host", "evil.example:1313");
    expect(() => assertSameOriginJsonPost(containerRequest)).toThrow(/origin/);
  });

  it("sets an opaque protected session cookie and expires it explicitly on lock", () => {
    const req = request({ origin: "http://127.0.0.1:1313", contentType: "application/json" });
    const cookie = vaultCookie("opaque-token", req);
    expect(cookie).toContain("localfi_vault_session=opaque-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toMatch(/Max-Age|Expires/i);
    expect(clearVaultCookie(req)).toContain("Max-Age=0");

    const secure = vaultCookie("opaque-token", new Request("https://localfi.test/api/vault/unlock"));
    expect(secure).toContain("Secure");
  });

  it("allows one explicitly configured non-loopback origin", () => {
    const previous = process.env.LOCALFI_APP_ORIGIN;
    process.env.LOCALFI_APP_ORIGIN = "https://finance.example.test";
    try {
      const configured = new Request("https://finance.example.test/api/vault/unlock", {
        method: "POST",
        headers: {
          origin: "https://finance.example.test",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(() => assertSameOriginJsonPost(configured)).not.toThrow();
      expect(vaultCookie("opaque-token", configured)).toContain("Secure");
    } finally {
      if (previous === undefined) delete process.env.LOCALFI_APP_ORIGIN;
      else process.env.LOCALFI_APP_ORIGIN = previous;
    }
  });
});

describe("generic unlock failure rate limiting", () => {
  it("does not trust caller-controlled forwarding headers", () => {
    const first = request({ origin: "http://127.0.0.1:1313", contentType: "application/json" });
    first.headers.set("x-forwarded-for", "198.51.100.1");
    const second = request({ origin: "http://127.0.0.1:1313", contentType: "application/json" });
    second.headers.set("x-forwarded-for", "203.0.113.9");
    expect(rateLimitKey(first, "unlock")).toBe(rateLimitKey(second, "unlock"));
  });

  it("blocks the sixth recent failure and resets after success or the window", () => {
    let now = 1_000;
    const limiter = new VaultFailureRateLimiter(5, 60_000, () => now);
    for (let index = 0; index < 5; index += 1) limiter.fail("unlock:loopback");
    expect(limiter.blocked("unlock:loopback")).toBe(true);
    limiter.succeed("unlock:loopback");
    expect(limiter.blocked("unlock:loopback")).toBe(false);
    limiter.fail("unlock:loopback");
    now += 60_001;
    expect(limiter.blocked("unlock:loopback")).toBe(false);
  });
});
