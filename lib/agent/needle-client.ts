/**
 * Typed client for the local Needle sidecar (`agent/needle_sidecar.py`).
 *
 * The sidecar holds a 26M function-calling model in memory and answers two
 * endpoints on loopback. This module is the ONLY place in the app that speaks to
 * it, and it exists mostly to keep four very different failures apart:
 *
 *   - the sidecar isn't running          -> "unavailable"   (tell the user to start it)
 *   - the sidecar ran, the model threw   -> "model-error"   (a bug; log it)
 *   - the model spoke, output was junk   -> "unparseable"   (ask a clarifying question)
 *   - it worked                          -> "ok"
 *
 * Conflating those is what makes a tiny-model feature undebuggable: "the agent
 * didn't work" could mean a dead process or a hallucinated tool name, and the
 * remedies share nothing.
 *
 * Two deliberate choices:
 *
 * 1. **Nothing here throws for an expected condition.** Every outcome above is a
 *    variant of `NeedleResult`. A thrown error from this module means a genuine
 *    programming bug, not "the model is down".
 * 2. **`raw` is the source of truth for parsing.** The sidecar also returns a
 *    `calls` array, but that is a Python best-effort parse kept for humans
 *    reading `curl` output. Here we run the real parser — `parseToolCalls()` from
 *    `tool-schema.ts` — over the verbatim string, so there is exactly one parsing
 *    implementation to reason about and the sidecar can never smuggle in a call
 *    shape the app's own parser would have rejected.
 */
import { parseToolCalls, type ToolCall } from "./tool-schema";

/** A tool call as the model proposed it. Structurally `ToolCall` from tool-schema. */
export type NeedleCall = ToolCall;

export type NeedleResult =
  /**
   * The model answered and `parseToolCalls` understood it. `calls` is non-empty
   * in practice: an empty `[]` from the model is rejected by `parseToolCalls`
   * (it requires at least one call) and therefore surfaces as `unparseable`.
   */
  | { status: "ok"; calls: NeedleCall[]; raw: string; ms: number }
  /** No usable sidecar: not started, wrong port, timed out, or answering nonsense HTTP. */
  | { status: "unavailable"; reason: string }
  /** Sidecar is up; `generate()` failed inside it. */
  | { status: "model-error"; reason: string }
  /** The model emitted something, but it is not a tool-call list. */
  | { status: "unparseable"; raw: string };

export type NeedleHealth =
  | { status: "ok"; checkpoint: string; platform: string }
  | { status: "unavailable"; reason: string };

export type NeedleOptions = {
  /**
   * Generous on purpose. A cold sidecar pays an XLA JIT compile on its first
   * `generate()` (~12s measured); warm calls are ~2-5s on CPU. A tight timeout
   * turns the first message of every session into a spurious failure.
   */
  timeoutMs?: number;
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

export const NEEDLE_DEFAULT_BASE_URL = "http://127.0.0.1:8765";
export const NEEDLE_DEFAULT_TIMEOUT_MS = 30_000;
/** Health is a constant-time answer; no reason to wait 30s for it. */
export const NEEDLE_HEALTH_TIMEOUT_MS = 2_000;

/** Where the sidecar lives. Loopback by default; the sidecar refuses to bind elsewhere. */
export function needleBaseUrl(): string {
  const configured = process.env.NEEDLE_URL?.trim();
  return configured && configured !== "" ? configured.replace(/\/+$/, "") : NEEDLE_DEFAULT_BASE_URL;
}

/**
 * Turn a thrown fetch/abort error into a human-actionable reason.
 *
 * `fetch` reports a refused connection as a bare `TypeError: fetch failed` and
 * hides ECONNREFUSED in `cause`, which is useless in a UI, so dig it out.
 */
function describeFailure(error: unknown, endpoint: string, timeoutMs: number): string {
  // A connection failure is about the host:port, not the path — quoting
  // ".../health" in "nothing is listening at …" reads as if the path were wrong.
  let url = endpoint;
  try {
    url = new URL(endpoint).origin;
  } catch {
    /* keep the raw string if it isn't a parseable URL */
  }

  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return `timed out after ${timeoutMs}ms waiting for the Needle sidecar at ${url} (a cold first inference pays a ~12s JIT cost; is it still loading?)`;
    }
    const cause = (error as { cause?: unknown }).cause;
    const code =
      cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code?: unknown }).code)
        : undefined;
    if (code === "ECONNREFUSED") {
      return `no Needle sidecar listening at ${url}; start it with \`npm run agent:sidecar\``;
    }
    const detail =
      cause instanceof Error ? cause.message : code ? code : error.message || String(error);
    return `could not reach the Needle sidecar at ${url}: ${detail}`;
  }
  return `could not reach the Needle sidecar at ${url}: ${String(error)}`;
}

/** One JSON request with a timeout, never throwing. */
async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; body: unknown; httpStatus: number } | { ok: false; reason: string }> {
  // AbortSignal.timeout() is not present in every runtime this may run under
  // (and is awkward to fake in tests), so drive an AbortController ourselves.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        reason: `Needle sidecar at ${url} returned a non-JSON body (HTTP ${response.status})`,
      };
    }
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "error" in body
          ? String((body as { error?: unknown }).error)
          : `HTTP ${response.status}`;
      // A non-2xx is the sidecar itself misbehaving (bad route, bad request), not
      // a model failure — the model's own failures come back as 200 + ok:false.
      return { ok: false, reason: `Needle sidecar rejected the request: ${message}` };
    }
    return { ok: true, body, httpStatus: response.status };
  } catch (error) {
    return { ok: false, reason: describeFailure(error, url, timeoutMs) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is the sidecar up, and which checkpoint is it holding?
 *
 * The sidecar loads the model before it opens its socket, so a successful
 * response here means "ready for inference", not merely "process alive". Poll
 * this rather than sending a throwaway `/call`.
 */
export async function needleHealth(opts: NeedleOptions = {}): Promise<NeedleHealth> {
  const base = opts.baseUrl ?? needleBaseUrl();
  const timeoutMs = opts.timeoutMs ?? NEEDLE_HEALTH_TIMEOUT_MS;
  const result = await request(
    `${base}/health`,
    { method: "GET", headers: { Accept: "application/json" } },
    timeoutMs,
    opts.fetchImpl ?? fetch,
  );

  if (!result.ok) return { status: "unavailable", reason: result.reason };

  const body = (result.body ?? {}) as { ok?: unknown; checkpoint?: unknown; platform?: unknown };
  if (body.ok !== true) {
    return { status: "unavailable", reason: "Needle sidecar reported itself unhealthy" };
  }
  return {
    status: "ok",
    checkpoint: typeof body.checkpoint === "string" ? body.checkpoint : "unknown",
    platform: typeof body.platform === "string" ? body.platform : "unknown",
  };
}

/**
 * Ask the model which tools to call.
 *
 * @param query     the user's message, verbatim
 * @param toolsJson tools in NEEDLE's dialect as a JSON *string* — build it with
 *                  `needleToolsJson()`, and check `needleBudget()` first: an
 *                  oversized payload is truncated silently by the encoder and the
 *                  tools at the end of the array become uncallable.
 */
export async function callNeedle(
  query: string,
  toolsJson: string,
  opts: NeedleOptions = {},
): Promise<NeedleResult> {
  const base = opts.baseUrl ?? needleBaseUrl();
  const timeoutMs = opts.timeoutMs ?? NEEDLE_DEFAULT_TIMEOUT_MS;

  const result = await request(
    `${base}/call`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, tools: toolsJson }),
    },
    timeoutMs,
    opts.fetchImpl ?? fetch,
  );

  if (!result.ok) return { status: "unavailable", reason: result.reason };

  const body = (result.body ?? {}) as {
    ok?: unknown;
    raw?: unknown;
    error?: unknown;
    ms?: unknown;
  };

  // The sidecar answers a failed `generate()` with HTTP 200 + ok:false, precisely
  // so this case is distinguishable from an unreachable process.
  if (body.ok !== true) {
    const reason = typeof body.error === "string" && body.error !== "" ? body.error : "unknown";
    return { status: "model-error", reason: `Needle model failed: ${reason}` };
  }

  if (typeof body.raw !== "string") {
    return {
      status: "unavailable",
      reason: `Needle sidecar at ${base} returned no \`raw\` string, version mismatch?`,
    };
  }

  const calls = parseToolCalls(body.raw);
  if (calls === null) return { status: "unparseable", raw: body.raw };

  return {
    status: "ok",
    calls,
    raw: body.raw,
    ms: typeof body.ms === "number" && Number.isFinite(body.ms) ? body.ms : 0,
  };
}
