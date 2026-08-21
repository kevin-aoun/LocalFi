# Contributing to LocalFi

LocalFi is a local-first finance application. Contributions should preserve
the single-user, loopback-bound privacy model and must not include real
financial data, database files, credentials, or model checkpoints.

## Customizing your own LocalFi

Personal customization is part of adopting LocalFi, not the upstream
contribution policy. Start with [Customize your LocalFi](README.md#customize-your-localfi)
for an agent-ready prompt, extension points, privacy boundaries, and validation
expectations. Return here when you want to propose the result to the shared
project.

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

## Handling Dependabot pull requests

Dependabot proposes dependency changes; it does not establish that they are
compatible or safe to merge. For this repository:

1. Make sure the `verify` workflow is green on `main` before evaluating an
   update. A failing baseline means every Dependabot branch can fail for an
   unrelated reason.
2. Activate the existing `main` ruleset if it is still disabled. Require a pull
   request and the `verify` status check, require the branch to be up to date,
   and keep force-push and deletion protection. A solo maintainer should require
   zero approvals because a pull-request author cannot approve their own change;
   require one approval only when a trusted collaborator can review it.
3. Close the existing `tailwind-merge` 3.x pull request (#5). LocalFi uses
   Tailwind CSS 3, which requires `tailwind-merge` 2.6.x; Dependabot is configured
   to stop proposing that incompatible major.
4. Ask Dependabot to update or rebase each remaining branch, then merge one
   green pull request at a time. Let `main` rerun before moving to the next so a
   regression has one obvious cause.
5. Give the `date-fns` update (#3) the normal checks plus `bun run test:tz`.
   Treat action-version updates and other major-version changes as reviewed code
   changes, not routine lockfile refreshes.

Do not enable blind auto-merge for major updates. If automation is added later,
start with reviewed patch updates and keep the same required checks.

By contributing, you agree that your contribution is provided under the MIT
License in [LICENSE](LICENSE).
