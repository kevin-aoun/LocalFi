# Chat capture with an on-device function-calling model

Status: **design, partially built.** The tool contract and schema converter exist
and are tested (`lib/agent/`, 29 tests). Nothing calls a model yet.

Goal: send `10 groceries` to a Telegram chat and have it land on the ledger,
without opening a laptop, without the app leaving the desktop, and without a
cloud model seeing the spending stream.

---

## 1. What Needle actually is, and what that constrains

Verified against the repo and the release post, not assumed:

| Fact | Consequence for us |
| --- | --- |
| 26M params, 14 MB INT4, MIT licensed | Fits anywhere; no license friction for an open-source repo. |
| Distilled from Gemini Flash **for function calling only** | It is a router, not an assistant. It cannot answer, summarize, or converse. |
| Attention-only (MLP/FFN stripped); 8-layer decoder, 12-layer encoder, d=512 | No factual knowledge to draw on. It pattern-matches a query against a tool list. Do not expect it to know what a "budget" is. |
| **Single-shot.** Explicitly "not conversational" | No agent loop, no multi-step planning, no follow-up turns. One message → at most one tool call. Anything needing composition must be **one** tool, not two chained. |
| Runtime is **Python** (`from needle import …`) + a CLI (`needle run`, `needle playground`, `needle finetune`) | Our app is TypeScript. This forces a process boundary — see §3. |
| Checkpoints are `.pkl`, auto-pulled from HF `Cactus-Compute/needle` | Pin the revision. A pickle is executable code; treat the download as a supply-chain input. |
| Tool schema dialect is **not JSON Schema** | Needs a converter. Built: `lib/agent/tool-schema.ts`. |
| Authors' own words: small models "can be finicky"; **120 examples per tool** (100/10/10) recommended to finetune | Budget for evaluation and probably finetuning. Zero-shot quality is an open question, not a given — see §7. |
| Context window: **undocumented** | Our 9 tools render to ~4.2 KB of JSON. That may be most of the budget. See §6. |

The two facts that shape everything else: **it is single-shot**, and **it is
Python**.

---

## 2. The pipeline — the model is the fallback, not the front door

```
Telegram message
      │
      ├─ 1. quick command?      "/coffee"          → deterministic → execute
      ├─ 2. simple grammar?     "10 groceries"     → regex + fuzzy → execute
      │                          (amount + category name; ~90% of real traffic)
      │
      └─ 3. anything else       "spent 43.50 at the pharmacy yesterday"
                │
                ▼
         Needle (tool list + message)  ──▶  [{"name":…,"arguments":{…}}]
                │
                ▼
         zod parse (lib/agent/tools.ts)   ← REJECTS here, loudly
                │
                ▼
         resolve names → real ids (exact → normalized → unique prefix → ask)
                │
                ▼
         confirm?  (write ≥ $200, or ambiguous resolution)
                │
                ▼
         call the SAME server action the UI calls
                │
                ▼
         reply with the budget impact: "Added $10.00 → Groceries.
                                        $37.50 left of $100 this month."
```

Step 2 matters more than step 3. `10 groceries` is a two-token grammar; a regex
plus a fuzzy match against 15 category names handles it with no latency, no model,
and no possibility of a hallucinated amount. Reserve the model for the messages
that genuinely have structure to extract. This also means the whole feature
degrades to "still works" if the model is unavailable.

The reply echoing **budget impact** is the actual product: instant feedback at the
moment of spending is the behavioural point of the app, and it surfaces a
misparse while the user still remembers the purchase.

---

## 3. Process topology — and the one rule that must not be broken

> **Only one process may ever open `data/budget.db`.**

`lib/db/client.ts` serializes work with an in-process FIFO promise chain and
holds a cross-process writer lease while the SQLite image is open. Persistence
still publishes a complete encrypted generation via temp→fsync→rename, so the
lease is a hard boundary: a CLI, app process, or maintenance command that targets
an already-open database fails rather than competing for the whole image.

So:

```
┌───────────────┐   getUpdates (outbound long-poll, HTTPS)
│  Telegram     │◀──────────────────────────────────────┐
└───────────────┘                                       │
                                                        │
┌───────────────────────────────────────────────────────┴──────────┐
│ desktop                                                          │
│                                                                  │
│  ┌──────────────┐  stdio/JSON   ┌──────────────┐                 │
│  │ needle       │◀─────────────▶│ bot worker   │                 │
│  │ (python)     │   one call    │ (node)       │                 │
│  └──────────────┘               └──────┬───────┘                 │
│                                        │ localhost HTTP           │
│                                        ▼                          │
│                              ┌────────────────────┐               │
│                              │ Next.js app        │               │
│                              │ SOLE DB WRITER     │──▶ budget.db  │
│                              └────────────────────┘               │
└──────────────────────────────────────────────────────────────────┘
```

- **The worker never imports the DB client.** It calls the app over
  `127.0.0.1`. The app stays the only writer, and the worker can crash and
  restart without touching data.
- **Needle runs as a sidecar** — a small Python process holding the model in
  memory, spoken to over stdio (or a loopback socket). Not spawned per message:
  process start would dominate a 14 MB model's inference time.
- **Long-polling is outbound only.** `getUpdates` means the desktop dials
  Telegram; no inbound port, no webhook, no public URL, no tunnel. That preserves
  the pull-only property this app is built around.

You mentioned this resembles Temporal — the useful borrowing is **durable
idempotent steps**, not the machinery. Telegram redelivers an update until the
offset advances, so a crash between "wrote the transaction" and "acked the
update" double-posts on restart. The fix is the same shape already used for
recurring transactions: persist the `update_id` and dedupe on it, in the same
write as the transaction.

---

## 4. The trust boundary is zod, and it is the whole security model

A 26M model will produce plausible-but-wrong arguments. The defence is that **the
model cannot write anything** — it emits a proposal, and every proposal is parsed
by the schema in `lib/agent/tools.ts` before it reaches a server action:

- money coerces through `parseAmount` → exact integer cents, or a **rejection**.
  Never a silent `0` (this app has had four separate falsy-zero bugs; the pattern
  is real).
- dates coerce through `parseFlexibleDate` → a `DateKey`, or a rejection. Never
  `new Date(string)`, which reads `01/02/2026` as January 2nd.
- `list_recent.limit` is clamped 1–20 regardless of what the model asks for.
- **No enum is exposed to the model.** Needle's dialect has no enum keyword, and a
  tiny model asked to reproduce one of fifteen exact category names will get it
  wrong. Category and account arrive as free strings and are resolved
  deterministically afterwards: exact → normalized → unique prefix → else ask.
  Resolution is our job.

And the blast radius is bounded by **omission**: there is no delete-category,
delete-account, delete-transaction, run-sql, or import tool. A chat message must
not be able to drop a category — that is how two transactions in this database
were orphaned once already. A test asserts those names stay absent.

`undo_last` is what makes the write tools acceptable. Chat is a typo-prone medium.

**Access control is the Telegram chat-ID allowlist.** A bot replies to anyone who
discovers its username, so without an allowlist a stranger can write to the
ledger. This is not app authentication — it is "only my chat may act".

---

## 5. What exists today

| File | What it is |
| --- | --- |
| `lib/agent/tools.ts` | The contract: 9 tools, zod parameter schemas, `read`/`write` kind, confirmation policy. Pure — imports no server action, so it is testable and renderable from anywhere. |
| `lib/agent/tool-schema.ts` | `toNeedleTool()` → Needle's flat dialect; `toJsonSchemaTool()` → real JSON Schema for a cloud fallback; `parseToolCalls()` → tolerant parser for what the model emits. |
| `lib/agent/__tests__/tool-schema.test.ts` | 29 tests: dialect shape, transform unwrapping, rejection of hallucinated args, absent-forbidden-tool assertions. |

The two dialects come from one zod definition, so a parameter cannot be described
to a model in a shape the validator won't accept. Both emitters agree on
requiredness — asserted.

Note `zod` was already a dependency with **zero imports**; this gives it a job.

## 6. Open questions I'd want measured before building further

1. **Context budget.** 9 tools render to ~4.2 KB. Needle's window is
   undocumented. If it is tight, prune the tool list per message (e.g. send write
   tools only when the message contains a digit) — but measure first.
2. **Zero-shot accuracy on our schema.** Unknown. Build a labelled set of ~100
   real messages first and measure tool-selection and argument accuracy *before*
   deciding whether finetuning is needed. `needle playground` (localhost:7860)
   makes this cheap to eyeball.
3. **Finetuning cost.** 120 examples/tool × 9 tools ≈ 1,080 examples. Mostly
   synthesizable, but it is real work; only do it for the tools that measurably
   misfire.
4. **Privacy of the transport.** Regular Telegram chats are not end-to-end
   encrypted, so the spending stream lives on Telegram's servers — an asymmetry
   with "the database is a file you own". Local model, cloud transport. Worth a
   deliberate decision; Matrix or a local-only quick-entry surface are the
   alternatives.

## 7. Not doing

- No agent loop. Needle is single-shot; a loop would be pretending otherwise.
- No cloud model in the default path. A keyed provider would put spending data in
  a second third party and break offline operation. The JSON Schema emitter exists
  so that choice stays *available*, not because it is planned.
- No `run_sql`-style escape hatch, ever.
