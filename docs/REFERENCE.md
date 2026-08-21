# LocalFi code reference

Use the [README](../README.md) to run LocalFi and
[DECISIONS.md](DECISIONS.md) for architecture rationale. Update this map when
code moves.

## Code map

| Area | Location | Boundary |
| --- | --- | --- |
| App shell | `app/layout.tsx`, `app/providers.tsx`, `app/(dashboard)/layout.tsx` | Providers, sidebar, and page frame |
| Request gate | `proxy.ts`, `lib/vault/proxy-session.ts` | Optimistic stale-session redirect; not authorization |
| Dashboard routes | `app/(dashboard)/` | Data loading and page composition |
| Server Actions | `app/actions/` | UI read/write boundary |
| Feature UI | `components/<feature>/` | Rendering and local interaction |
| UI primitives | `components/ui/` | shadcn and mapcn components; avoid feature logic here |
| Domain rules | `lib/` | Pure calculations and validation |
| Ledger | `lib/ledger/` | Events, movements, integrity, and projections |
| Investments | `lib/investments/` | Instruments, positions, observations, and purchases |
| Database | `lib/db/` | Client, migrations, recovery, and schema utilities |
| Vault | `lib/vault/` | Encryption, paths, secrets, and sessions |
| Schema | `lib/db/schema/` | Drizzle table definitions |
| Migrations | `drizzle/migrations/` | Generated SQL journal and snapshots |
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
| `/settings` | `app/(dashboard)/settings/page.tsx` | Local preferences, inactivity timeout, and developer controls |

## HTTP surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/snapshot` | Confirm the configured snapshot endpoint is available |
| `POST` | `/api/snapshot` | Record the current daily snapshot |
| `GET` | `/api/vault/status` | Read the local vault state without unlocking it |
| `POST` | `/api/vault/setup` | Create or explicitly convert the single-owner vault |
| `POST` | `/api/vault/unlock` | Unlock with the vault passphrase and issue an opaque local session |
| `POST` | `/api/vault/lock` | Lock, close the in-memory database, and clear the session |
| `POST` | `/api/vault/recovery` | Reset the passphrase with the recovery secret and rotate recovery material |

The UI uses Server Actions, not a public REST API. `/api/snapshot` requires an
`AGENT_API_TOKEN` bearer token.

## Extension checklist

| Change | Required work |
| --- | --- |
| Persisted field | Update `lib/db/schema/`; generate and review a migration; add an upgrade verifier and migration test; wire actions and UI. |
| Financial behavior | Put the rule in a pure `lib/` module; call it from an action; append ledger events for confirmed facts; test logic and action. |
| Feature UI | Keep routes for loading/composition; put controls in `components/<feature>/`; extract testable `*-logic.ts`; reuse shared primitives and privacy behavior. |

## Operational boundaries

| Concern | Source of truth |
| --- | --- |
| Data model | `lib/db/schema/` and `drizzle/migrations/meta/_journal.json` |
| Financial balances | `lib/cash-balance.ts` and ledger projections |
| Ledger integrity | `lib/ledger/verify.ts`, `bun run ledger:verify` |
| Database upgrades | `lib/db/upgrade.ts`, `bun run db:upgrade` |
| Rebuildable projections | `lib/ledger/rebuild.ts`, `bun run ledger:rebuild` |
| Local database path | `BUDGET_DB_PATH`, default `data/budget.db` |
| Vault envelope and permissions | `lib/vault/envelope.ts`, `lib/vault/paths.ts` |
| Vault session and timeout | `lib/vault/session.ts`, `settings.idle_timeout_minutes` |
| Stale-session redirect | `proxy.ts`, `GET /api/vault/status` |
| Export disclosure boundary | `components/exports/export-disclosure.tsx`, `app/actions/export.ts` |
| Owner setup | Browser `/vault` flow with one-use `LOCALFI_VAULT_BOOTSTRAP_TOKEN` |
| Headless authorization | `authorizeDatabaseVaultFromEnvironment` around supported CLI callers |
| Compose permissions | `data-permissions` one-shot service in `docker-compose.yml` |

LocalFi is single-owner and loopback-only, not an internet authentication
system. See [SECURITY.md](SECURITY.md).
