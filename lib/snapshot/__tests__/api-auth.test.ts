import { afterEach, describe, expect, it } from "vitest";

import {
  authorizeSnapshotRequest,
  snapshotAuthConfigured,
  snapshotAuthDisabledResponse,
} from "../api-auth";

const originalToken = process.env.SNAPSHOT_API_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.SNAPSHOT_API_TOKEN;
  else process.env.SNAPSHOT_API_TOKEN = originalToken;
});

describe("snapshot bearer authentication", () => {
  it("fails closed when no token is configured", async () => {
    delete process.env.SNAPSHOT_API_TOKEN;

    expect(snapshotAuthConfigured()).toBe(false);
    const response = snapshotAuthDisabledResponse();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "snapshot_api_disabled" });
  });

  it("rejects an invalid bearer token without detail", async () => {
    process.env.SNAPSHOT_API_TOKEN = "configured-snapshot-token-with-enough-entropy";

    const result = authorizeSnapshotRequest(new Request("http://127.0.0.1/api/snapshot", {
      headers: { authorization: "Bearer wrong" },
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({ error: "unauthorized" });
  });

  it("accepts the configured bearer token", () => {
    process.env.SNAPSHOT_API_TOKEN = "configured-snapshot-token-with-enough-entropy";

    expect(snapshotAuthConfigured()).toBe(true);
    expect(authorizeSnapshotRequest(new Request("http://127.0.0.1/api/snapshot", {
      headers: {
        authorization: "Bearer configured-snapshot-token-with-enough-entropy",
      },
    }))).toEqual({ ok: true });
  });
});
