# Needle sidecar

A long-lived local HTTP service holding [Cactus Needle](https://github.com/cactus-compute/needle)
— a 26M-parameter function-calling model — in memory, so the app can ask it which
tool a chat message maps to. Client side: `lib/agent/needle-client.ts`.

## Run it

```bash
npm run agent:sidecar
```

That runs `agent/needle_sidecar.py` with Needle's own venv python
(`~/.local/share/cactus-needle/.venv/bin/python`) — there are no pip dependencies
beyond Needle itself; the service is plain `http.server`.

Expect roughly:

```
[needle 11:15:32] platform   : cpu (NEEDLE_PLATFORM to override)
[needle 11:15:36] checkpoint : /home/you/.local/share/cactus-needle/checkpoints/needle_finetuned_20260728233756_4188039_12_512_best.pkl
[needle 11:15:36] backend    : cpu  devices=[CpuDevice(id=0)]
[needle 11:15:36] listening on http://127.0.0.1:8765  (GET /health, POST /call)
```

Leave it running. Ctrl-C (or SIGTERM) stops it cleanly.

## Check it

```bash
curl -s http://127.0.0.1:8765/health
# {"ok": true, "checkpoint": "needle_finetuned_20260728233756_4188039_12_512_best.pkl", "platform": "cpu", "busy": false}
```

The checkpoint is loaded **before** the socket opens, so a successful `/health`
means "ready for inference", not just "process alive". Poll it rather than sending
a throwaway `/call`.

A real inference, with the app's own tool payload:

```bash
node node_modules/tsx/dist/cli.mjs -e \
  'import {needleToolsJson} from "@/lib/agent/tool-schema"; process.stdout.write(needleToolsJson())' \
  > /tmp/tools.json

curl -s -X POST http://127.0.0.1:8765/call \
  -H 'Content-Type: application/json' \
  -d "$(jq -Rn --rawfile t /tmp/tools.json '{query:"10 food", tools:$t}')"
# {"ok": true,
#  "raw": "[{\"name\":\"add_transaction\",\"arguments\":{\"amount\":\"10\",\"category\":\"Food\"}}]",
#  "calls": [{"name": "add_transaction", "arguments": {"amount": "10", "category": "Food"}}],
#  "ms": 5757}
```

Note `tools` is a JSON **string** containing the tool array — that is Needle's own
input shape, not a nested array.

## Endpoints

| Method | Path      | Response |
| ------ | --------- | -------- |
| GET    | `/health` | `{"ok":true,"checkpoint":"…","platform":"cpu","busy":false}` |
| POST   | `/call`   | `{"ok":true,"raw":"…","calls":[…],"ms":1234}` |
| POST   | `/call`   | `{"ok":false,"error":"…"}` at **HTTP 200** when the model itself failed |

The model-failure case is deliberately HTTP 200: the client has to be able to tell
"the model blew up" from "there is no sidecar", and those need different messages
(file a bug vs. start the process). Malformed *requests* get a 4xx.

`raw` is the model's output **verbatim**, always. `calls` is a best-effort Python
parse kept there so `curl` output is readable — the app parses `raw` itself with
`parseToolCalls()` and ignores `calls`.

## Environment

| Variable            | Default                                              | Notes |
| ------------------- | ---------------------------------------------------- | ----- |
| `NEEDLE_HOME`       | `~/.local/share/cactus-needle`                       | Needle checkout + venv + checkpoints |
| `NEEDLE_CHECKPOINT` | newest `checkpoints/needle_finetuned_*_best.pkl`     | must exist; no silent fallback |
| `NEEDLE_HOST`       | `127.0.0.1`                                          | refuses to bind anything non-loopback |
| `NEEDLE_PORT`       | `8765`                                               | |
| `NEEDLE_PLATFORM`   | `cpu`                                                | sets `JAX_PLATFORMS` |
| `NEEDLE_URL`        | `http://127.0.0.1:8765`                              | read by the **Node client**, not the sidecar |

`--host`, `--port` and `--checkpoint` flags override the env vars.

## Which checkpoint, and why it matters

The default is the newest **finetuned** checkpoint from this repo's corpus
(`eval/needle-finetune.jsonl`, trained via `eval/needle-finetune.py`), matched with
`~/.local/share/cactus-needle/checkpoints/needle_finetuned_*_best.pkl` and sorted
by mtime.

Do not fall back to the base `needle.pkl`: on this repo's eval it scores **65%**
tool selection against the finetuned checkpoint's **94%**. If no finetuned
checkpoint matches, the sidecar exits with an error instead of quietly loading the
base weights — a 65% model looks like a broken feature, not a slower one.

The loaded filename is printed at startup and returned by `/health`, so you can
always tell which weights answered.

## CPU by default

Inference runs on CPU (`JAX_PLATFORMS=cpu`). GPU here fails intermittently inside
XLA autotuning with:

```
INTERNAL: Failed to get configs for 3 of 7 instructions
```

non-deterministically and mid-run, which for a chat feature means random hard
failures. CPU is boring: measured ~4-6s per call, and 65 sequential inferences in
~280s. Fine for one-message-at-a-time chat.

Set `NEEDLE_PLATFORM=cuda` if you want to try your luck.

Timing notes:

- model load ~4s (import + checkpoint), before the port opens;
- the first `generate()` pays an XLA JIT compile (~12s cold). The sidecar sets
  `JAX_COMPILATION_CACHE_DIR=~/.cache/jax`, so after the first ever run that drops
  to a few seconds;
- warm calls ~2-6s.

Hence: **one long-lived process**, not a subprocess per request. The client's
default timeout is 30s to cover a cold first call.

## The 1024-token cliff

Needle's encoder takes 1024 tokens as `[query…, <tools>, tools…]` and truncates
the overflow **silently** (`tool_tokens[:remaining]` — no error, no warning). An
oversized tool list therefore does not fail; the tools at the *end* of the array
just become uncallable.

Both sides guard it:

- JS: `needleBudget()` in `lib/agent/tool-schema.ts`, before sending;
- Python: the sidecar logs a warning per request and names the tools that fell off
  the end:

```
WARNING encoder overflow: query=2 + tools=2949 = 2951 tokens > 1024. Needle truncates
tools to 1021 tokens SILENTLY; 1928 tool tokens will be dropped.
WARNING tools the model cannot see: refresh_prices
```

If you see that, send fewer tools for the message — never pass it through.

## Security

The sidecar decides which write tools the app proposes against the user's real
financial database, so:

- it binds **loopback only** and refuses any other `--host`;
- it sends no CORS headers and rejects any request carrying an `Origin` header, so
  a page in the user's browser cannot drive it;
- request bodies are capped at 512 KB.

It is not authenticated beyond that, and must never be port-forwarded or exposed.

## Behaviour under load and failure

- Inference is serialized behind a lock: `generate()` mutates a module-level JIT
  cache and decodes against one set of params, so concurrent calls interleave into
  garbage rather than merely being slow. `/health` still answers while busy
  (`busy: true`).
- A single bad request never kills the process — it comes back as
  `{"ok":false,"error":…}` and the model stays loaded (a restart would cost another
  cold JIT).
- Every request logs its query, elapsed ms and raw output. That log is the only
  visibility into a 26M model's behaviour; read it when the agent does something
  strange.
