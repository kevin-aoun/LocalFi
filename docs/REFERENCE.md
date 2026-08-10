# LocalFi reference

The [README](../README.md) is the human-facing project hub. This document records the stable code boundaries contributors should use when extending it; see [DECISIONS.md](DECISIONS.md) for why those boundaries exist.

| Area | Owner | Extension point |
| --- | --- | --- |
| Routes and pages | `app/(dashboard)/` | Add a page and keep data access in actions. |
| Server actions | `app/actions/` | Validate input, perform slow network work first, then write once. |
| Domain rules | `lib/` | Prefer pure, tested helpers for money, dates, balances, reports, and prices. |
| Database | `lib/db/` and `drizzle/migrations/` | Add a journaled migration and temporary-database tests. |
| Ledger kernel | `lib/ledger/` and `lib/db/schema/ledger.ts` | Post balanced events through `post-event.ts`; never mutate journal rows. Use `verify.ts` and `rebuild.ts` for checks and projections. |
| Ledger explorer | `app/(dashboard)/ledger/`, `app/actions/ledger.ts`, `components/ledger/ledger-explorer.tsx` | Keep route reads read-only; query with cursor pagination and validated filters. |
| UI features | `components/<feature>/` | Keep render wiring small; extract testable logic to `*-logic.ts`. |
| Optional AI | `agent/`, `lib/agent/`, `app/api/agent/` | Deferred subsystem; do not couple core startup to it. |

The durable database is `BUDGET_DB_PATH`, defaulting to `data/budget.db`.
Application and migration code resolve the same path. First access acquires a
cross-process writer lease, backs up when migration is pending, applies and
verifies the raw `drizzle/migrations` journal, and only then exposes the handle.
The standalone image therefore includes those raw migration files. Personal
data, backups, exports, credentials, and checkpoints are intentionally ignored.

Spreadsheet input is bounded before persistence: CSV/XLSX input is at most 5
MiB and 5,000 data rows, XLSX central-directory metadata may declare at most 50
MiB expanded, and server deduplication includes account, currency, and stored
direction in addition to the source row facts.

## Ledger invariants

`ledger_events` is one global append-only chain. UUIDs identify events; the
database `sequence` orders them; `previous_hash` links each row to its
predecessor; Node SHA-256 hashes the canonical payload. `ledger_movements` carry
signed positive/negative amounts covered by that canonical payload hash; they
are not cryptographically signed. Every event balances to zero per currency.
The sequence plus `previous_hash` is the durable linked structure, not a second
JavaScript list.

Pending drafts are mutable, visible only in the Transactions UI and pending
queue, and eventless. They do not enter `ledger_events` until confirmation;
confirmation creates the first event; confirmed changes and deletes append
corrections. Balances, category spend, and instrument positions are derived;
account and category definitions are metadata. Observations carry market value.
`assets` and `asset_history` are compatibility projections.
Integrity is tamper-evident rather than independently tamper-proof because a
full database writer can recompute a suffix.
Legacy holdings remain independent imported instrument identities even when
symbols match; new purchases use the canonical provider-symbol identity. Cash
is account-derived and excluded from instrument migration. Migration-generated
opening dates are local `DateKey`s with provenance. The Categories tab reads
the same journal category movements used for budget actuals.

The operational checks are `bun run ledger:verify` and
`bun run ledger:rebuild`. The rebuild is projection-only: it rebuilds confirmed
transaction rows and allocations, instrument positions, managed non-Cash asset
projections, and the first denomination-scoped derived Cash compatibility row.
Pending drafts, extra Cash rows, metadata definitions, events/movements, and
instrument observations are preserved. Verification reports a first-Cash
mismatch privately as a projection invariant. Already-journaled projection
damage is recoverable by rebuilding; unjournaled SQL-only adoption of 0012
fails closed.

## Explorer boundary

Settings → Developer tools → Show ledger explorer conditionally exposes the
read-only dynamic `/ledger` route and sidebar item. `lib/ledger/explorer.ts`
implements validated cursor pagination and date, currency, target-type, and
search filters. The client renders the vertical chain with TanStack Virtual,
shows corrections and verification results, and applies privacy masking to
financial values and canonical payload/metadata details. UUIDs, sequence,
hashes, and other structural diagnostics are not financial values.
Base cursor responses withhold canonical metadata and payload. A capped,
exact-event read occurs only when an event is expanded while privacy is off;
payloads are purged when privacy activates. Correction navigation can load an
off-page virtualized target.

## Code map

```
app/
  layout.tsx              root layout, Inter font, Providers
  providers.tsx           next-themes + accent-colour CSS var injection
  actions/                all database access ("use server") + __tests__/
  (dashboard)/
    layout.tsx            sidebar + scrollable main
    page.tsx              dashboard (client)
    accounts/             page.tsx (server) + accounts-client.tsx
    transactions/         ledger, filters, pending queue, transfers, import (client)
    ledger/               read-only event/hash-chain explorer
    recurring/            page.tsx (server) + recurring-client.tsx
    budgets/              page.tsx (server) + budgets-client.tsx
    reports/              page.tsx (server) + reports-client.tsx
    travel/               city itinerary UI + mapcn map
    settings/             profile, theme, accent, quick commands (client)
components/
  ui/                     shadcn primitives — regenerate, don't hand-edit
  accounts|assets|budgets|dashboard|ledger|recurring|reports|settings|transactions/
                          feature dialogs + *-logic.ts modules + __tests__/
  shared/                 sidebar, theme-toggle
lib/
  money.ts                Cents, parseAmount, formatMoney, sumCents
  dates.ts                DateKey, toDateKey, parseFlexibleDate
  cash-balance.ts         THE balance rule (cash, per-account, net worth)
  budgets.ts              periods, spend-vs-budget, history
  recurrence.ts           anchored occurrence math
  reports.ts              cash flow, savings rate, comparisons, CSV serializers
  prices.ts               provider registry (SwissQuote metals, CoinGecko crypto)
  revalidate.ts           revalidatePath that can't fail a successful write
  db/                     client, schema, setup, recovery, and migration helpers
  ledger/                 canonical payloads, posting, reads, verification,
                          projection rebuilds, and explorer queries
  stores/                 Zustand view state
  countries.ts            ISO country names and alpha codes
  utils.ts                cn() helper
drizzle/migrations/       generated SQL + meta/_journal.json
data/                     budget.db + budget.db.bak (gitignored),
                          backups/ (timestamped pre-migration copies),
                          *.json.backup (pre-SQLite era)
```

### The one-shot migration appliers

The `migrate-to-*.ts` scripts safely apply migrations to databases that already
hold real data. The SQL migration remains the source of truth; each applier
works on an in-memory copy, preserves existing row counts, checks foreign
keys, writes a timestamped backup before replacing the file, reopens and
verifies the result, and refuses to run twice.

```bash
node node_modules/tsx/dist/cli.mjs lib/db/migrate-to-accounts.ts --dry-run
node node_modules/tsx/dist/cli.mjs lib/db/migrate-to-accounts.ts [--db <path>]
node node_modules/tsx/dist/cli.mjs lib/db/migrate-to-budget-reallocations.ts --dry-run
node node_modules/tsx/dist/cli.mjs lib/db/migrate-to-budget-reallocations.ts [--db <path>]
```

`migrate-from-json.ts` and `verify-migration.ts` are older still — they moved
data from the app's original JSON files into SQLite. They expect
`data/categories.json` and friends, which now exist only as `*.json.backup`, so
they will not run as-is. Keep them as a record or delete them.

Migration 0012 deliberately splits schema and canonical-data work: its SQL
creates the instruments, observations, ledger accounts, events, movements,
projection tables, and linkage columns; `lib/db/migrate-to-immutable-ledger.ts`
performs the TypeScript UUID and canonical-payload backfill because those values
require application-level deterministic serialization and SHA-256. Do not
replace that backfill with SQL-only guesses. A populated SQL-only 0012 schema
fails closed instead of being adopted without that TypeScript phase. If the
recoverable `.bak` refresh fails, live replacement is aborted first.

### Scripts

| Script | Does |
| --- | --- |
| `bun run dev` | Dev server on `:1313` with Turbopack. |
| `bun run build` / `bun run start` | Webpack production build (standalone output) / serve it (port 3000 unless `PORT` is set). |
| `bun run typegen` / `bun run typecheck` | Generate Next App Router types / generate them and then run strict TypeScript. |
| `bun run lint` | ESLint (`next/core-web-vitals`). Not run during `build`; currently clean with no warnings. |
| `bun run test` / `bun run test:watch` | Vitest, one run / watch mode; configured discovery covers `lib`, `app`, `components`, `scripts`, and `eval`. |
| `bun run test:tz` | The suite twice, at UTC+14 and UTC−11. |
| `bun run db:setup` | `db:init` then `db:seed`. The one command a fresh checkout needs. |
| `bun run db:init` | Replay every migration in journal order onto a fresh file at `BUDGET_DB_PATH`. Refuses to clobber an existing non-empty database unless passed `--force`. |
| `bun run db:seed` | Insert the 15 default categories (`onConflictDoNothing`, so re-running is safe). |
| `bun run db:sample` | Add five example assets and six transactions. |
| `bun run db:upgrade` | Validate/apply pending startup migrations for the configured database, with backup and journal evidence. |
| `bun run db:restore` | Dry-run or apply the validated restore workflow; apply preserves the current generation first. |
| `bun run db:generate` | Generate a migration from schema changes. |
| `bun run db:studio` | Drizzle Studio on `:4983`. |
| `bun run db:push` | Push schema straight to the file, skipping migrations. Avoid — it leaves no history. |
| `bun run ledger:verify` | Verify event ordering, hash links/payloads, per-currency balance, immutability triggers, and projections; exits non-zero on failure. A managed-Cash mismatch is reported privately as a projection invariant. |
| `bun run ledger:rebuild` | Rebuild confirmed transaction rows and allocations, instrument positions, managed non-Cash asset projections, and the provenance-marked derived Cash compatibility row. Preserves pending drafts, extra Cash rows, metadata definitions, events/movements, and observations; journal rows are not changed. |

### Adding a feature end to end

Adding "tags on transactions" would touch, in order:

1. `lib/db/schema/transactions.ts` — add the column; the export flows through `schema/index.ts`.
2. `bun run db:generate` — writes a numbered SQL file and updates the journal. Add the corresponding startup verifier/backfill handling and migration tests before release; the standalone Docker image must carry the raw journal and SQL files.
3. `app/actions/transactions.ts` — read/write the field inside the existing `withDb`, then `revalidate(...)`.
4. `components/transactions/transaction-form-logic.ts` — parsing/validation, with a test in `components/transactions/__tests__/`.
5. `components/transactions/transaction-dialog.tsx` — the input, surfacing any `{ error }` the action returns.
6. `app/(dashboard)/transactions/page.tsx` + `lib/stores/transactions-store.ts` — display and filtering.
7. `bun run test && bun run test:tz` — the second one if a date is involved anywhere.

## Compose profiles

`docker compose up --build` starts only the core app and binds it to loopback.
The optional model sidecar is enabled with `docker compose --profile ai up`.
The snapshot scheduler is enabled with `docker compose --profile scheduler up`
and requires an explicitly configured token. Review both services before using
them with financial data.
