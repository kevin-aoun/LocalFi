/**
 * The sidecar client's four outcomes.
 *
 * Every test stubs `fetch`: nothing here starts the real sidecar or opens a
 * socket, because a test suite that depends on a 26M model being loaded is a test
 * suite that fails on CI and on a laptop that forgot to `npm run agent:sidecar`.
 * The recorded bodies below are copied from real `curl` output.
 *
 * What is actually being defended:
 *
 *   - "sidecar down" and "model said nonsense" must never collapse into one
 *     status. The orchestrator shows completely different UI for them, and the
 *     remedies (start a process / ask the user to rephrase) share nothing.
 *   - `raw` must always survive to the caller, so a bad answer can be read in a
 *     log rather than guessed at.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NEEDLE_DEFAULT_BASE_URL,
  callNeedle,
  needleBaseUrl,
  needleHealth,
} from "@/lib/agent/needle-client";

/** A `fetch` stand-in returning one recorded JSON response. */
function jsonFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

/** What Node's `fetch` actually throws when nothing is listening on the port. */
function connectionRefused() {
  return vi.fn(async () => {
    const error = new TypeError("fetch failed");
    (error as { cause?: unknown }).cause = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:8765"),
      { code: "ECONNREFUSED" },
    );
    throw error;
  }) as unknown as typeof fetch;
}

const TOOLS = '[{"name":"add_transaction","description":"…","parameters":{}}]';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("needleBaseUrl", () => {
  it("defaults to loopback", () => {
    vi.stubEnv("NEEDLE_URL", "");
    expect(needleBaseUrl()).toBe(NEEDLE_DEFAULT_BASE_URL);
    expect(NEEDLE_DEFAULT_BASE_URL).toContain("127.0.0.1");
  });

  it("honours NEEDLE_URL and strips a trailing slash", () => {
    vi.stubEnv("NEEDLE_URL", "http://127.0.0.1:9999/");
    expect(needleBaseUrl()).toBe("http://127.0.0.1:9999");
  });
});

describe("callNeedle — well-formed response", () => {
  it("returns parsed calls, the raw string and the elapsed ms", async () => {
    const raw = '[{"name":"add_transaction","arguments":{"amount":"10","category":"Food"}}]';
    const fetchImpl = jsonFetch(200, { ok: true, raw, calls: [], ms: 4312 });

    const result = await callNeedle("10 food", TOOLS, { fetchImpl });

    expect(result).toEqual({
      status: "ok",
      calls: [{ name: "add_transaction", arguments: { amount: "10", category: "Food" } }],
      raw,
      ms: 4312,
    });
  });

  it("POSTs the query and tools to /call as a JSON string field", async () => {
    const fetchImpl = jsonFetch(200, { ok: true, raw: "[]", ms: 1 });
    await callNeedle("10 food", TOOLS, { fetchImpl, baseUrl: "http://127.0.0.1:8765" });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8765/call");
    expect(init.method).toBe("POST");
    // `tools` is a STRING, not a nested array — that is Needle's own input shape.
    expect(JSON.parse(init.body as string)).toEqual({ query: "10 food", tools: TOOLS });
  });

  it('reports an empty "[]" answer as unparseable, per parseToolCalls', async () => {
    // Pinning a contract inherited from `parseToolCalls`, which deliberately
    // rejects an empty array (`ok = list.length > 0`) rather than returning zero
    // calls. So "the model chose no tool" arrives as `unparseable`, NOT as
    // `{status:"ok", calls:[]}` — and the orchestrator's unparseable branch
    // (ask a clarifying question) is the right handling for it either way.
    const fetchImpl = jsonFetch(200, { ok: true, raw: "[]", ms: 900 });
    const result = await callNeedle("hello", TOOLS, { fetchImpl });
    expect(result).toEqual({ status: "unparseable", raw: "[]" });
  });
});

describe("callNeedle — a bare object still parses", () => {
  it("accepts a single call object instead of a one-element array", async () => {
    // Observed deviation from a 26M model; `parseToolCalls` already tolerates it,
    // and this test pins that we route through that parser rather than a second one.
    const raw = '{"name":"list_recent","arguments":{"limit":5}}';
    const fetchImpl = jsonFetch(200, { ok: true, raw, ms: 2000 });

    const result = await callNeedle("show recent", TOOLS, { fetchImpl });

    expect(result).toMatchObject({
      status: "ok",
      calls: [{ name: "list_recent", arguments: { limit: 5 } }],
    });
  });

  it("accepts a fenced code block around the JSON", async () => {
    const raw = '```json\n[{"name":"get_balances","arguments":{}}]\n```';
    const fetchImpl = jsonFetch(200, { ok: true, raw, ms: 2000 });

    const result = await callNeedle("balances?", TOOLS, { fetchImpl });
    expect(result).toMatchObject({ status: "ok", calls: [{ name: "get_balances", arguments: {} }] });
  });

  it("ignores the sidecar's advisory `calls` field and re-parses `raw`", async () => {
    // The Python side's parse is for humans reading curl output. If the two ever
    // disagree, the app's own parser wins — otherwise the sidecar could inject a
    // call shape `parseToolCalls` would have rejected.
    const raw = '[{"name":"add_transaction","arguments":{"amount":"10"}}]';
    const fetchImpl = jsonFetch(200, {
      ok: true,
      raw,
      calls: [{ name: "SOMETHING_ELSE", arguments: { danger: true } }],
      ms: 10,
    });

    const result = await callNeedle("10 food", TOOLS, { fetchImpl });
    expect(result).toMatchObject({ status: "ok", calls: [{ name: "add_transaction" } as never] });
  });
});

describe("callNeedle — model failed inside a healthy sidecar", () => {
  it("maps HTTP 200 + ok:false to model-error", async () => {
    const fetchImpl = jsonFetch(200, {
      ok: false,
      error: "XlaRuntimeError: INTERNAL: Failed to get configs for 3 of 7 instructions",
    });

    const result = await callNeedle("10 food", TOOLS, { fetchImpl });

    expect(result.status).toBe("model-error");
    // The underlying error text has to survive: it is the only clue on a 26M model.
    expect(result).toMatchObject({ reason: expect.stringContaining("XlaRuntimeError") });
  });
});

describe("callNeedle — sidecar unreachable", () => {
  it("maps a refused connection to unavailable, naming the fix", async () => {
    const result = await callNeedle("10 food", TOOLS, { fetchImpl: connectionRefused() });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") throw new Error("unreachable");
    // ECONNREFUSED is buried in `error.cause`; a bare "fetch failed" is useless.
    expect(result.reason).toContain("no Needle sidecar listening");
    expect(result.reason).toContain("agent:sidecar");
  });

  it("maps a timeout to unavailable with the budget in the reason", async () => {
    // A fetch that never resolves until aborted — exactly a sidecar mid-JIT.
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("This operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    ) as unknown as typeof fetch;

    const result = await callNeedle("10 food", TOOLS, { fetchImpl: hang, timeoutMs: 5 });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toContain("timed out after 5ms");
    // The reason must hint at the cold-start cost, or this reads as a dead process.
    expect(result.reason).toContain("JIT");
  });

  it("maps a non-2xx HTTP response to unavailable, not model-error", async () => {
    // A 404 means we are talking to something that is not this sidecar (or a
    // version mismatch). That is not the model failing.
    const fetchImpl = jsonFetch(404, { ok: false, error: "no such endpoint: /call" });
    const result = await callNeedle("10 food", TOOLS, { fetchImpl });
    expect(result.status).toBe("unavailable");
  });

  it("maps a non-JSON body to unavailable", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>proxy error</html>", { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await callNeedle("10 food", TOOLS, { fetchImpl });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toContain("non-JSON");
  });
});

describe("callNeedle — unparseable model output", () => {
  it("returns unparseable with the raw text preserved verbatim", async () => {
    const raw = "I think you should add a transaction for ten dollars of food.";
    const fetchImpl = jsonFetch(200, { ok: true, raw, ms: 3100 });

    const result = await callNeedle("10 food", TOOLS, { fetchImpl });

    expect(result).toEqual({ status: "unparseable", raw });
  });

  it("does not accept JSON that is the wrong shape", async () => {
    // Valid JSON, no `name` — a plausible small-model failure. Guessing a tool
    // here would mean writing a made-up row to the user's ledger.
    const raw = '[{"amount":"10","category":"Food"}]';
    const fetchImpl = jsonFetch(200, { ok: true, raw, ms: 3100 });

    const result = await callNeedle("10 food", TOOLS, { fetchImpl });
    expect(result).toEqual({ status: "unparseable", raw });
  });

  it("treats an empty string answer as unparseable rather than as zero calls", async () => {
    const fetchImpl = jsonFetch(200, { ok: true, raw: "", ms: 12 });
    const result = await callNeedle("???", TOOLS, { fetchImpl });
    expect(result).toEqual({ status: "unparseable", raw: "" });
  });
});

describe("needleHealth", () => {
  it("reports the loaded checkpoint and platform", async () => {
    const fetchImpl = jsonFetch(200, {
      ok: true,
      checkpoint: "needle_finetuned_20260728233756_4188039_12_512_best.pkl",
      platform: "cpu",
      busy: false,
    });

    const result = await needleHealth({ fetchImpl });

    expect(result).toEqual({
      status: "ok",
      checkpoint: "needle_finetuned_20260728233756_4188039_12_512_best.pkl",
      platform: "cpu",
    });
  });

  it("is unavailable when nothing is listening", async () => {
    const result = await needleHealth({ fetchImpl: connectionRefused() });
    expect(result.status).toBe("unavailable");
  });

  it("GETs /health and never posts a query", async () => {
    const fetchImpl = jsonFetch(200, { ok: true, checkpoint: "x.pkl", platform: "cpu" });
    await needleHealth({ fetchImpl, baseUrl: "http://127.0.0.1:8765" });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8765/health");
    expect(init.method).toBe("GET");
    // Readiness must be checkable without paying for an inference.
    expect(init.body).toBeUndefined();
  });
});
