# LocalFi agent guide

This file is the always-on contract for coding agents. Keep it concise. Detailed
rules are path-scoped in `.claude/rules/`; they apply to every agent even when a
client does not auto-load Claude rules.

## Product boundary

- LocalFi is a single-user, local-first finance app. Preserve the loopback-only,
  unauthenticated default; do not make cloud services required or transmit financial
  data by default.
- Treat `data/`, database files, exports, backups, credentials, and real ledger
  values as private. Never inspect, copy, log, seed from, or commit them.
- Preserve pre-existing work. Check `git status` before editing and do not rewrite
  unrelated changes in a dirty worktree.

## Read before changing code

- Start with `README.md` for the runtime and `docs/REFERENCE.md` for code ownership.
- Read `docs/DECISIONS.md` before changing an architectural boundary.
- `docs/AGENT.md` describes the optional chat-capture runtime; it is not repository
  guidance.
- Read every matching canonical rule before editing:
  - `.claude/rules/persistence.md` for `lib/db/`, migrations, and DB/ledger scripts.
  - `.claude/rules/financial-domain.md` for actions, money, dates, ledger, reports,
    recurrence, prices, and investments.
  - `.claude/rules/frontend.md` for dashboard routes, components, and global UI.
  - `.claude/rules/agent-runtime.md` for `lib/agent/`, `app/api/agent/`, `agent/`,
    the agent CLI, and evals.
  - `.claude/rules/testing.md` when adding or changing tests.

## Non-negotiable invariants

- Money is integer cents. Parse at boundaries with `lib/money.ts`; never use float
  arithmetic or truthiness to distinguish zero from missing.
- Calendar days are local `YYYY-MM-DD` `DateKey`s. Do not derive them with
  `toISOString()` or parse ambiguous date strings with `new Date(string)`.
- Confirmed financial facts are append-only ledger events. Corrections and deletes
  append balancing events; transfers are neither income nor expense.
- Only one process may write a database file. Never run app and maintenance writers
  against the same path, and never use a real/default database for tests.
- Server Actions are the UI read/write boundary. Keep deterministic rules in pure
  `lib/` modules and interactive wiring in feature components.
- Any new surface that shows financial values must honor privacy mode.

## Change discipline

1. Run commands from the repository root with the pinned Bun toolchain; do not
   introduce npm/yarn lockfiles or silently change the package manager.
2. Trace callers, invariants, and nearby regression tests before editing.
3. Make the smallest coherent change; do not mix deferred agent work into product
   work or refactor unrelated code.
4. Add or update a regression test for behavior changes. The test environment is
   Node, not jsdom; extract render-independent component logic into `*-logic.ts`.
5. Generate migrations with `bun run db:generate`; do not hand-author generated SQL
   or snapshots. Add upgrade verification and temporary-database migration tests.
6. Update `docs/REFERENCE.md` when code ownership moves and `docs/DECISIONS.md` when
   an architectural decision changes.

## Validation

- After meaningful code or configuration changes, run
  `bun run validate:agent -- <each-file-you-changed>`. Pass explicit paths so a
  dirty worktree is not mistaken for your work.
- The validator chooses focused lint/tests/type checks and escalates for database,
  ledger, date, build, or Compose changes. Guidance-only edits receive structural
  validation without the application-wide suite.
- Run `bun run validate:agent -- --full` before a release or after broad,
  cross-cutting work. Report exactly what ran and any check you could not run.
