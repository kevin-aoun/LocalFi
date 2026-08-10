# Contributing to LocalFi

LocalFi is a local-first finance application. Contributions should preserve
the single-user, loopback-bound privacy model and must not include real
financial data, database files, credentials, or model checkpoints.

## Before opening a pull request

1. Install Node.js 20+ and Bun 1.3.14, then run `bun install --frozen-lockfile`.
2. Run `bun run lint`, `bun run typecheck`, and `bun run test`.
3. For date or ledger changes, also run `bun run test:tz`.
4. Update the relevant documentation and migration notes when behavior or
   schema changes.

Keep changes focused. New database schema requires a journaled migration,
idempotent upgrade behavior, and tests using a temporary database. Do not edit
the deferred AI implementation as part of unrelated product work.

## Pull requests

Describe the user-visible change, verification commands, migration impact,
and any security or privacy considerations. Never paste personal ledger data
into issues, commits, logs, or test fixtures.

By contributing, you agree that your contribution is provided under the MIT
License in [LICENSE](LICENSE).
