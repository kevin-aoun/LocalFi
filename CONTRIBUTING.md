# Contributing to LocalFi

Preserve LocalFi's single-owner, loopback-only model. Never include financial
data, database files, vault files, exports, backups, or credentials.

## Customizing your own LocalFi

Start with [Customize your LocalFi](README.md#customize-your-localfi). Use the
repository's harness hooks and permissions, and accept them when your coding
tool asks whether to trust the project. Never disable those controls or give an
agent a database, export, backup, passphrase, recovery secret, or Docker access.

## Before opening a pull request

1. Install Node.js 20+ and Bun 1.3.14; run `bun install --frozen-lockfile`.
2. Run `bun run lint`, `bun run typecheck`, and `bun run test`.
3. Run `bun run test:tz` for date or ledger changes.
4. Update affected docs and migration notes.

Keep changes focused. Schema changes need a journaled migration, idempotent
upgrade path, and temporary-database tests.

## Pull requests

Describe the change, validation, migration impact, and security implications.
Use minimal synthetic values in tests and never attach a database artifact.

## Handling Dependabot pull requests

Dependabot proposes updates; it does not prove compatibility. Require the
`verify` check, update branches before merge, and merge one green PR at a time.
Run `bun run test:tz` for date-library changes. Review majors and GitHub Action
updates as code changes; never auto-merge them blindly.

By contributing, you agree that your contribution is provided under the MIT
License in [LICENSE](LICENSE).
