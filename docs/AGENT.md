# On-device chat capture

Status: the tool contract, deterministic parser, executor, and optional Needle
sidecar integration exist. A Telegram transport does not.

Goal: turn a short message such as `10 groceries` into a validated ledger entry
without sending financial data to a cloud model.

## Model constraints

[Cactus Needle](https://github.com/cactus-compute/needle) is a 26M-parameter,
single-shot function router, not a conversational agent.

| Constraint | Design consequence |
| --- | --- |
| Python runtime | Run one long-lived sidecar; TypeScript calls it over loopback HTTP. |
| Single-shot | One message yields at most one tool call; no agent loop. |
| Function-calling only | Keep business rules and name resolution outside the model. |
| Custom tool dialect | Convert the zod registry with `lib/agent/tool-schema.ts`. |
| 1024-token encoder | Check the complete tool payload before inference. |
| `.pkl` checkpoint | Pin and review it as executable supply-chain input. |

## Pipeline

```text
message
  -> slash command or simple grammar
  -> Needle only when deterministic parsing cannot decide
  -> zod validation
  -> deterministic account/category resolution
  -> confirmation for risky or ambiguous writes
  -> the same application action used by the UI
  -> result with budget impact
```

The deterministic path is faster and cannot hallucinate an amount. Model output
is only a proposal; it never writes directly.

## Process boundary

Only the Next.js app may open the owner database. A chat worker must call the app
over `127.0.0.1`; it must never import the database client. The writer lease then
continues to protect the single SQLite image.

A future remote transport should poll outward instead of exposing an inbound
port. It must persist and deduplicate the transport message ID in the same write
as the transaction. Transport identity, such as a Telegram chat-ID allowlist,
is separate from vault authorization.

## Validation boundary

`lib/agent/tools.ts` is authoritative:

- amounts parse to integer cents or fail;
- dates parse to local `DateKey`s or fail;
- limits are bounded;
- model-provided names resolve deterministically;
- destructive or arbitrary-SQL tools do not exist;
- write tools support correction through `undo_last`.

Both Needle and JSON Schema descriptions derive from the same zod definitions,
so model input and runtime validation cannot drift.

## Implementation map

| Location | Role |
| --- | --- |
| `lib/agent/tools.ts` | Tool registry, schemas, kinds, and confirmation policy |
| `lib/agent/{slash,resolve,normalize-call}.ts` | Deterministic parsing and normalization |
| `lib/agent/{handle,execute,undo}.ts` | Routing, validated execution, and correction |
| `lib/agent/tool-schema.ts` | Needle/JSON Schema conversion, parsing, token budget |
| `lib/agent/needle-client.ts` | Typed loopback sidecar client |
| `agent/needle_sidecar.py` | Long-lived local model service |

## Before adding a transport

Measure tool selection and argument accuracy on fictional messages, cold/warm
latency, and payload size. Decide whether ordinary Telegram privacy is acceptable:
messages are not end-to-end encrypted and would live on Telegram's servers.

## Non-goals

- No model access to the database.
- No cloud model in the default path.
- No multi-step agent loop.
- No delete or `run_sql` escape hatch.
