---
paths:
  - "lib/agent/**/*.ts"
  - "app/api/agent/**/*.ts"
  - "agent/**/*.py"
  - "agent/Dockerfile"
  - "scripts/agent-cli.ts"
  - "eval/**/*"
  - "docs/AGENT.md"
---

# Local chat-capture runtime

- Read `docs/AGENT.md` first. Needle is a single-shot function router, not a
  conversational planner; one message may propose at most one tool call.
- Keep deterministic quick commands and the simple grammar ahead of model routing.
  Do not use a model where exact parsing can decide safely.
- The Python sidecar may load the model, but it must never open the database or call
  write logic. Only the Next.js process uses shared handlers/actions and owns the DB.
- Treat every model response as untrusted. Parse it through the Zod contract, then
  resolve names deterministically. Reject unknown, ambiguous, or malformed values.
- Keep tool capability narrow by omission: no arbitrary SQL, generic filesystem,
  category/account deletion, or unbounded list operation. Preserve confirmations,
  chat-ID/API authorization, bounded limits, and `undo_last` behavior.
- All transports call the same `handle`/`execute` path so validation and policy do
  not drift. Tool dialects must continue to derive from the same Zod definitions.
- Do not send ledger text to a cloud model in the default path or make the optional
  agent runtime required for the core app to start.
- Update schema/parser/execute tests and the labelled eval corpus when routing or
  tool semantics change; measure accuracy rather than assuming model behavior.
