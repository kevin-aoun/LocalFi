# LocalFi code reference

This is the map of the codebase, not a second product manual. Start with the
[README](../README.md) to run LocalFi and [DECISIONS.md](DECISIONS.md) for the
reasons behind its architecture. Keep this document current when code moves.

## Code map

| Area | Location | Boundary |
| --- | --- | --- |
| App shell | `app/layout.tsx`, `app/providers.tsx`, `app/(dashboard)/layout.tsx` | Global styles, providers, sidebar, and page frame |
| Dashboard routes | `app/(dashboard)/` | Route composition; server pages load data and pass it to client components |
| Server Actions | `app/actions/` | The application’s read/write boundary for UI features |
| Feature UI | `components/{accounts,assets,budgets,dashboard,ledger,recurring,reports,settings,transactions}/` | Rendering and local interaction state |
| UI primitives | `components/ui/` | shadcn and mapcn components; avoid feature logic here |
| Domain rules | `lib/{money,dates,cash-balance,budgets,recurrence,reports,prices}.ts` | Pure calculations and validation |
| Ledger | `lib/ledger/` | Canonical event construction, reads, integrity checks, and projections |
| Investments | `lib/investments/` | Instrument identity, positions, observations, and purchases |
| Database | `lib/db/` | sql.js client, migration startup, recovery, schema utilities |
| Schema | `lib/db/schema/` | Drizzle table definitions |
| Migrations | `drizzle/migrations/` | Ordered SQL journal and snapshots; generated, not hand-edited |
| Tests | `**/__tests__/` | Unit and action/database regression coverage |
| Scripts | `scripts/` | Explicit maintenance and recovery commands |

## Routes

| Route | Entry point | Purpose |
| --- | --- | --- |
| `/` | `app/(dashboard)/page.tsx` | Net worth, assets, and cash history |
| `/accounts` | `app/(dashboard)/accounts/` | Asset and liability accounts |
| `/transactions` | `app/(dashboard)/transactions/page.tsx` | Transactions, transfers, imports, and pending confirmations |
| `/recurring` | `app/(dashboard)/recurring/` | Recurring templates and generation |
| `/budgets` | `app/(dashboard)/budgets/` | Budget rules, history, reallocations, and categories |
| `/reports` | `app/(dashboard)/reports/` | Cash-flow and investment performance |
| `/travel` | `app/(dashboard)/travel/` | Visited-city map and route history |
| `/ledger` | `app/(dashboard)/ledger/` | Optional read-only ledger explorer |
| `/settings` | `app/(dashboard)/settings/page.tsx` | Local preferences and developer controls |

## HTTP surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/snapshot` | Confirm the configured snapshot endpoint is available |
| `POST` | `/api/snapshot` | Record the current daily snapshot |

The product UI uses Server Actions rather than a public REST API. Route handlers
exist only for operations that need an external caller. The snapshot route
requires a configured `AGENT_API_TOKEN` bearer token.

## Extension checklists

### Add a persisted field

1. Update the appropriate table in `lib/db/schema/`.
2. Generate a migration with `bun run db:generate`.
3. Add an upgrade verifier in `lib/db/upgrade.ts`.
4. Add a migration test in `lib/db/__tests__/`.
5. Update the action, form logic, UI, and nearby tests.

### Add a financial behavior

1. Put arithmetic and validation in a pure `lib/` module.
2. Call it from an action; do not recreate the rule in a page or component.
3. If it changes a confirmed fact, post a ledger event rather than mutating the
   event history.
4. Add action and pure-logic tests.

### Add a feature UI

1. Keep the route focused on data loading and composition.
2. Put controls and dialogs in `components/<feature>/`.
3. Extract non-render logic into a nearby `*-logic.ts` module when it needs
   tests.
4. Reuse `components/ui/` primitives and the shared privacy behavior.

## Operational boundaries

| Concern | Source of truth |
| --- | --- |
| Data model | `lib/db/schema/` and `drizzle/migrations/meta/_journal.json` |
| Financial balances | `lib/cash-balance.ts` and ledger projections |
| Ledger integrity | `lib/ledger/verify.ts`, `bun run ledger:verify` |
| Database upgrades | `lib/db/upgrade.ts`, `bun run db:upgrade` |
| Rebuildable projections | `lib/ledger/rebuild.ts`, `bun run ledger:rebuild` |
| Local database path | `BUDGET_DB_PATH`, default `data/budget.db` |

The default deployment is intentionally unauthenticated and loopback-only.
Never expose it directly to the internet.
