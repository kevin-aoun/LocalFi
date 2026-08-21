import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "../route";

let previousToken: string | undefined;
let previousMode: string | undefined;

beforeEach(() => {
  previousToken = process.env.AGENT_API_TOKEN;
  previousMode = process.env.LOCALFI_VAULT_TEST_MODE;
  process.env.AGENT_API_TOKEN = "test-agent-token-with-enough-entropy";
  delete process.env.LOCALFI_VAULT_TEST_MODE;
});

afterEach(() => {
  if (previousToken === undefined) delete process.env.AGENT_API_TOKEN;
  else process.env.AGENT_API_TOKEN = previousToken;
  if (previousMode === undefined) delete process.env.LOCALFI_VAULT_TEST_MODE;
  else process.env.LOCALFI_VAULT_TEST_MODE = previousMode;
});

describe("agent vault boundary", () => {
  it("stays locked even with a valid bearer token", async () => {
    expect((await GET()).status).toBe(423);
    const response = await POST(new Request("http://127.0.0.1:3000/api/agent", {
      method: "POST",
      headers: {
        authorization: "Bearer test-agent-token-with-enough-entropy",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "10 groceries" }),
    }));
    expect(response.status).toBe(423);
    expect(await response.json()).toEqual({ error: "vault_locked" });
  });
});
