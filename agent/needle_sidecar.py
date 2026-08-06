#!/usr/bin/env python
"""
A long-lived, loopback-only HTTP sidecar around Cactus Needle (26M function-calling
model), so the Next.js app can ask a local model which tool to call.

    npm run agent:sidecar          # or see agent/README.md

## Why a sidecar and not a subprocess per request

Three costs, in increasing order of annoyance:

  1. importing jax + flax and loading the checkpoint takes a few seconds;
  2. the first `generate()` pays an XLA JIT compile of ~12s;
  3. every inference after that is ~2-5s on CPU.

A process-per-request design pays (1) and (2) on *every* message, which turns a
3-second reply into a 15-second one. So: load once, hold the model in memory,
answer requests until killed.

## Why CPU by default

GPU inference on this machine intermittently dies inside XLA autotuning with
`INTERNAL: Failed to get configs for N of M instructions`, mid-run and
non-deterministically — which for a chat feature means random hard failures. CPU
is slow but boring: 65 sequential inferences measured at ~280s (~4.3s each),
which is fine for one-message-at-a-time chat. Override with NEEDLE_PLATFORM=cuda
if you want to gamble.

## Security posture

This service tells the app to write to the user's real financial database, so it
binds **loopback only** and is never exposed. It also sends no CORS headers and
refuses any request carrying an `Origin` header, so a random web page open in the
user's browser cannot drive it.

Endpoints
---------
GET  /health  -> {"ok":true,"checkpoint":"...","platform":"cpu"}
POST /call    -> {"ok":true,"raw":"<verbatim model output>","calls":[...],"ms":123}
                 {"ok":false,"error":"..."}   (HTTP 200 — model failed, sidecar fine)

Environment
-----------
NEEDLE_HOME        default ~/.local/share/cactus-needle
NEEDLE_CHECKPOINT  default newest checkpoints/needle_finetuned_*_best.pkl
NEEDLE_HOST        default 127.0.0.1  (refuses anything non-loopback)
NEEDLE_PORT        default 8765
NEEDLE_PLATFORM    default cpu        (sets JAX_PLATFORMS)
"""
import argparse
import glob
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# Configuration. All of this must happen BEFORE jax is imported, because
# JAX_PLATFORMS is read once at import time.
# ---------------------------------------------------------------------------

DEFAULT_NEEDLE_HOME = os.path.expanduser("~/.local/share/cactus-needle")
NEEDLE_HOME = os.environ.get("NEEDLE_HOME") or DEFAULT_NEEDLE_HOME

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

#: Needle's encoder length (`DEFAULT_MAX_ENC_LEN` in needle/dataset/dataset.py).
#: Overflow is truncated SILENTLY — `tool_tokens[:remaining]`, no error — so the
#: tail of an oversized tool list simply becomes invisible to the model. Hence
#: the explicit warning in `run_inference`.
MAX_ENC_TOKENS = 1024

#: Cap on a request body. Nothing legitimate is near this; it stops a stray
#: client from making us buffer gigabytes.
MAX_BODY_BYTES = 512 * 1024

_LOCK = threading.Lock()

_STATE = {
    "model": None,
    "params": None,
    "tokenizer": None,
    "checkpoint": "",
    "platform": "",
}


def log(message: str) -> None:
    """Timestamped line on stdout.

    A 26M model is opaque; these logs are the only window into what it actually
    said, so they are unconditional rather than behind a verbosity flag.
    """
    print(f"[needle {time.strftime('%H:%M:%S')}] {message}", flush=True)


def resolve_checkpoint(explicit: str | None) -> str:
    """Pick the checkpoint to load.

    Defaults to the NEWEST finetuned checkpoint, not the base weights: on this
    repo's eval the base model scores 65% on tool selection and the finetuned one
    94%, so silently falling back to base would look like a broken feature.
    """
    if explicit:
        if not os.path.exists(explicit):
            raise SystemExit(f"NEEDLE_CHECKPOINT does not exist: {explicit}")
        return explicit

    pattern = os.path.join(NEEDLE_HOME, "checkpoints", "needle_finetuned_*_best.pkl")
    matches = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    if matches:
        return matches[0]

    raise SystemExit(
        f"No finetuned checkpoint matched {pattern}\n"
        "Finetune first (see eval/needle-finetune.py) or point NEEDLE_CHECKPOINT at a .pkl."
    )


def load_model(checkpoint: str) -> None:
    """Import needle and load the checkpoint into module state. Startup only."""
    if NEEDLE_HOME not in sys.path:
        sys.path.insert(0, NEEDLE_HOME)

    from needle import SimpleAttentionNetwork, get_tokenizer, load_checkpoint

    import jax

    params, config = load_checkpoint(checkpoint)
    _STATE["params"] = params
    _STATE["model"] = SimpleAttentionNetwork(config)
    _STATE["tokenizer"] = get_tokenizer()
    _STATE["checkpoint"] = os.path.basename(checkpoint)
    _STATE["platform"] = jax.default_backend()

    log(f"checkpoint : {checkpoint}")
    log(f"backend    : {jax.default_backend()}  devices={jax.devices()}")


def check_budget(query: str, tools: str) -> None:
    """Warn when the encoder will silently drop the tail of the tool list.

    Mirrors `_build_encoder_input`: the query is encoded first, one separator
    token is inserted, and the tool tokens get whatever is left. Nothing raises,
    nothing is logged by needle itself — the last tools just stop existing.
    """
    tokenizer = _STATE["tokenizer"]
    try:
        query_tokens = tokenizer.encode(query)
        tool_tokens = tokenizer.encode(tools)
    except Exception as exc:  # tokenizer should never fail; never break a request over it
        log(f"WARNING could not measure token budget: {exc!r}")
        return

    total = len(query_tokens) + len(tool_tokens)
    if total <= MAX_ENC_TOKENS:
        return

    remaining = MAX_ENC_TOKENS - len(query_tokens) - 1
    log(
        f"WARNING encoder overflow: query={len(query_tokens)} + tools={len(tool_tokens)} "
        f"= {total} tokens > {MAX_ENC_TOKENS}. Needle truncates tools to "
        f"{max(remaining, 0)} tokens SILENTLY; {len(tool_tokens) - max(remaining, 0)} "
        f"tool tokens will be dropped. Send fewer tools (see needleBudget() in "
        f"lib/agent/tool-schema.ts)."
    )

    # Name the casualties when we can — "refresh_prices is invisible" is far more
    # actionable than a token count.
    try:
        kept = tokenizer.decode(tool_tokens[: max(remaining, 0)])
        names = [t["name"] for t in json.loads(tools) if isinstance(t, dict) and "name" in t]
        lost = [n for n in names if f'"{n}"' not in kept]
        if lost:
            log(f"WARNING tools the model cannot see: {', '.join(lost)}")
    except Exception:
        pass


def best_effort_calls(raw: str) -> list:
    """Advisory parse of the model's output.

    The authoritative parser is `parseToolCalls()` in lib/agent/tool-schema.ts —
    the client validates `raw` itself and ignores this field for decisions. It
    exists so that `curl /call` is readable by a human.
    """
    text = (raw or "").strip()
    for candidate in (text, *_json_candidates(text)):
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        items = parsed if isinstance(parsed, list) else [parsed]
        if all(isinstance(i, dict) and isinstance(i.get("name"), str) for i in items) and items:
            return items
    return []


def _json_candidates(text: str) -> list:
    """The bracketed / braced substrings worth a JSON.parse attempt."""
    out = []
    for open_c, close_c in (("[", "]"), ("{", "}")):
        start, end = text.find(open_c), text.rfind(close_c)
        if 0 <= start < end:
            out.append(text[start : end + 1])
    return out


def run_inference(query: str, tools: str) -> dict:
    """One `generate()` call, serialized.

    The lock is not optional: `generate` mutates a module-level JIT cache and
    decodes token-by-token against one set of params, so two concurrent calls
    interleave into garbage rather than merely being slow.
    """
    from needle import generate

    check_budget(query, tools)

    started = time.perf_counter()
    with _LOCK:
        raw = generate(
            _STATE["model"],
            _STATE["params"],
            _STATE["tokenizer"],
            query=query,
            tools=tools,
            stream=False,
        )
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    return {"ok": True, "raw": raw, "calls": best_effort_calls(raw), "ms": elapsed_ms}


class Handler(BaseHTTPRequestHandler):
    server_version = "needle-sidecar/1.0"
    protocol_version = "HTTP/1.1"

    # -- plumbing ----------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - stdlib name
        """Route BaseHTTPRequestHandler's own chatter through our logger."""
        log(f"http {fmt % args}")

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Deliberately NO Access-Control-Allow-Origin: a browser must not be able
        # to read this response even if it manages to send a request.
        self.end_headers()
        self.wfile.write(body)

    def _reject_browser(self) -> bool:
        """Refuse cross-origin browser traffic outright.

        The legitimate caller is the app's Node process, which sends no Origin.
        A page on the open internet cannot read our response anyway, but it can
        *send* requests to 127.0.0.1, and this service is an instruction source
        for database writes. Cheapest possible mitigation.
        """
        if self.headers.get("Origin"):
            self._send(403, {"ok": False, "error": "cross-origin requests are refused"})
            return True
        return False

    def _read_json(self) -> dict | None:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            self._send(413, {"ok": False, "error": f"body exceeds {MAX_BODY_BYTES} bytes"})
            return None
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError as exc:
            self._send(400, {"ok": False, "error": f"body is not JSON: {exc}"})
            return None
        if not isinstance(payload, dict):
            self._send(400, {"ok": False, "error": "body must be a JSON object"})
            return None
        return payload

    # -- routes ------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - stdlib name
        if self._reject_browser():
            return
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/health", "/"):
            # Answers WITHOUT touching the model, so a caller can poll this to
            # wait for readiness. Because the checkpoint is loaded before the
            # socket is opened, a successful /health means "model is loaded".
            self._send(
                200,
                {
                    "ok": True,
                    "checkpoint": _STATE["checkpoint"],
                    "platform": _STATE["platform"],
                    "busy": _LOCK.locked(),
                },
            )
            return
        self._send(404, {"ok": False, "error": f"no such endpoint: {path}"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib name
        if self._reject_browser():
            return
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path != "/call":
            self._send(404, {"ok": False, "error": f"no such endpoint: {path}"})
            return

        payload = self._read_json()
        if payload is None:
            return

        query = payload.get("query")
        tools = payload.get("tools", "[]")
        if not isinstance(query, str) or query.strip() == "":
            self._send(400, {"ok": False, "error": "query must be a non-empty string"})
            return
        if not isinstance(tools, str):
            self._send(
                400,
                {"ok": False, "error": "tools must be a JSON *string* (Needle's own format)"},
            )
            return

        log(f"query   : {query!r}")
        try:
            result = run_inference(query, tools)
        except Exception as exc:
            # One bad request must never take the process down — a restart costs
            # the caller another cold JIT. Report it as a model error at HTTP 200
            # so the client can tell "model failed" from "sidecar unreachable".
            log(f"ERROR   : {type(exc).__name__}: {exc}")
            self._send(200, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            return

        log(f"raw     : {result['raw']!r}  ({result['ms']}ms)")
        self._send(200, result)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--host", default=os.environ.get("NEEDLE_HOST", DEFAULT_HOST))
    ap.add_argument("--port", type=int, default=int(os.environ.get("NEEDLE_PORT", DEFAULT_PORT)))
    ap.add_argument("--checkpoint", default=os.environ.get("NEEDLE_CHECKPOINT"))
    args = ap.parse_args()

    # Loopback-only by DEFAULT, because this service is an instruction source for
    # writes to the user's financial database.
    #
    # Inside a container that rule is wrong in the letter and right in the spirit:
    # the process must bind 0.0.0.0 to be reachable from the app container at all,
    # while the compose file keeps it off the host by simply not publishing a port.
    # So the escape hatch is explicit and must be opted into, never inferred.
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        if os.environ.get("NEEDLE_ALLOW_NON_LOOPBACK") != "1":
            raise SystemExit(
                f"refusing to bind {args.host!r}: this service is an instruction source for "
                "writes to the user's financial database and must stay on loopback.\n"
                "If this really is a container whose port is NOT published to the host, "
                "set NEEDLE_ALLOW_NON_LOOPBACK=1 to override."
            )
        log(
            f"WARNING binding {args.host!r} (NEEDLE_ALLOW_NON_LOOPBACK=1). Anything that can "
            "reach this port can drive writes to the ledger — do not publish it to the host "
            "or to a shared network."
        )

    checkpoint = resolve_checkpoint(args.checkpoint)
    log(f"platform   : {os.environ['JAX_PLATFORMS']} (NEEDLE_PLATFORM to override)")
    load_model(checkpoint)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True

    def stop(signum, _frame):
        # shutdown() blocks until serve_forever() returns, so it cannot be called
        # from the thread running serve_forever — hand it to a helper thread.
        log(f"signal {signal.Signals(signum).name}, shutting down")
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    log(f"listening on http://{args.host}:{args.port}  (GET /health, POST /call)")
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        log("stopped")
    return 0


# JAX_PLATFORMS is read at jax import time, so it must be set before ANY import
# of needle happens — including the one inside main(). NEEDLE_PLATFORM wins, then
# an explicit JAX_PLATFORMS, else cpu (see the module docstring for why).
os.environ["JAX_PLATFORMS"] = (
    os.environ.get("NEEDLE_PLATFORM") or os.environ.get("JAX_PLATFORMS") or "cpu"
)
# Quieter XLA, and reuse compiled kernels between runs so the ~12s first-call JIT
# is mostly paid once per machine rather than once per restart.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", os.path.expanduser("~/.cache/jax"))

if __name__ == "__main__":
    raise SystemExit(main())
