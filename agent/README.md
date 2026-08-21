# Needle sidecar

A loopback HTTP service that keeps the
[Cactus Needle](https://github.com/cactus-compute/needle) function-calling model
in memory. The TypeScript client is `lib/agent/needle-client.ts`.

## Run and verify

```bash
bun run agent:sidecar
curl -s http://127.0.0.1:8765/health
```

The port opens after the checkpoint loads, so a healthy response means inference
is ready. Stop with Ctrl-C or SIGTERM.

Test a call with LocalFi's tool payload:

```bash
node node_modules/tsx/dist/cli.mjs -e \
  'import {needleToolsJson} from "@/lib/agent/tool-schema"; process.stdout.write(needleToolsJson())' \
  > /tmp/tools.json

curl -s -X POST http://127.0.0.1:8765/call \
  -H 'Content-Type: application/json' \
  -d "$(jq -Rn --rawfile t /tmp/tools.json '{query:"10 food", tools:$t}')"
```

`tools` is a JSON string containing the tool array, as required by Needle.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/health` | Readiness, checkpoint, platform, and busy state |
| `POST` | `/call` | Raw model output, parsed calls, and elapsed time |

Model failures return HTTP 200 with `{"ok":false,"error":"…"}` so clients can
distinguish them from an unavailable sidecar. Malformed requests return 4xx.
LocalFi trusts `raw` only after its own `parseToolCalls()` validation.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEEDLE_HOME` | `~/.local/share/cactus-needle` | Checkout, venv, and checkpoints |
| `NEEDLE_CHECKPOINT` | Newest `needle_finetuned_*_best.pkl` | Required checkpoint |
| `NEEDLE_HOST` | `127.0.0.1` | Loopback-only bind |
| `NEEDLE_PORT` | `8765` | Sidecar port |
| `NEEDLE_PLATFORM` | `cpu` | JAX platform |
| `NEEDLE_URL` | `http://127.0.0.1:8765` | Node client URL |

`--host`, `--port`, and `--checkpoint` override environment values.

## Runtime choices

- The repo's finetuned checkpoint scored 94% tool selection versus 65% for the
  base checkpoint; missing finetuned weights therefore fail closed.
- CPU is the default because GPU autotuning was unstable. Warm calls take about
  2–6 seconds; a cold first call may take about 12 seconds.
- One long-lived process avoids repeated model loading and JIT compilation.
- Inference is serialized because model generation mutates shared state.
- The 1024-token encoder silently truncates excess tools. JavaScript checks with
  `needleBudget()`; Python logs overflow and hidden tool names. Never send an
  oversized payload.

## Security and failure behavior

- The sidecar refuses non-loopback binds, Origin-bearing browser requests, and
  request bodies over 512 KB. Never expose or port-forward it.
- It has no separate authentication; loopback is the boundary.
- A bad model call returns an error without terminating the process.
- `/health` remains available while inference is busy.
- Request logs contain queries and model output; treat them as sensitive.
