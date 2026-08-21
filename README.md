<h1 align="center">
  <img src="docs/images/localfi-title.png" alt="LocalFi — local-first finance with an immutable ledger" />
</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16.3-000000?style=for-the-badge&amp;logo=nextdotjs&amp;logoColor=white" alt="Next.js 16.3" />
  <img src="https://img.shields.io/badge/React-19.2-61DAFB?style=for-the-badge&amp;logo=react&amp;logoColor=082032" alt="React 19.2" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?style=for-the-badge&amp;logo=typescript&amp;logoColor=white" alt="TypeScript 5.7" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-3.4-06B6D4?style=for-the-badge&amp;logo=tailwindcss&amp;logoColor=white" alt="Tailwind CSS 3.4" />
  <br />
  <img src="https://img.shields.io/badge/SQLite-Portable-003B57?style=for-the-badge&amp;logo=sqlite&amp;logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/Drizzle_ORM-0.45-C5F74F?style=for-the-badge&amp;logo=drizzle&amp;logoColor=1A1A1A" alt="Drizzle ORM 0.45" />
  <img src="https://img.shields.io/badge/Bun-1.3-FBF0DF?style=for-the-badge&amp;logo=bun&amp;logoColor=14151A" alt="Bun 1.3" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&amp;logo=docker&amp;logoColor=white" alt="Docker Compose" />
</p>

<p align="center">
  <sub>Built with shadcn/ui, Radix UI, Recharts, MapLibre GL, and Vitest.</sub>
</p>

LocalFi is a local-first personal finance app for accounts, liabilities,
transactions, budgets, assets, investments, travel, and net-worth history.
Canonical application state is one portable SQLite image stored on your
machine as an authenticated encrypted LocalFi vault generation. LocalFi also
maintains an encrypted `<database>.bak` recovery generation beside it; both
files still contain sensitive financial data. Confirmed financial facts enter one
append-only, hash-linked ledger; balances, budgets, reports, and positions are
derived from that shared history instead of maintaining competing totals.

> **Local-only by design.** A single-owner vault passphrase protects access and
> encrypts the database at rest. Keep LocalFi on your machine; the default
> Docker setup binds only to `127.0.0.1`, and the vault is not a substitute for
> full-disk encryption or a hardened multi-user service.

## Customize your LocalFi

**Every single component is customizable.** Change the dashboard layout,
cards, colors, categories, reports, charts, budget behavior, transaction
workflows, travel map, data model, ledger projections, or local integrations.
LocalFi is intentionally source-first, so you can shape the whole experience
around the way you manage money instead of adapting your finances to a fixed
product.

Start your coding agent in the repository root with a concrete outcome. The
repository guidance will lead it through the relevant architecture, safety
rules, tests, and validation commands.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/dark/openai.png" />
    <img src="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/light/openai.png" width="48" height="48" alt="OpenAI" title="OpenAI" />
  </picture>&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/dark/claude-color.png" />
    <img src="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/light/claude-color.png" width="48" height="48" alt="Claude" title="Claude" />
  </picture>&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/dark/gemini-color.png" />
    <img src="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/light/gemini-color.png" width="48" height="48" alt="Google Gemini" title="Google Gemini" />
  </picture>&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/dark/cursor.png" />
    <img src="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/light/cursor.png" width="48" height="48" alt="Cursor" title="Cursor" />
  </picture>&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/dark/windsurf.png" />
    <img src="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/light/windsurf.png" width="48" height="48" alt="Windsurf" title="Windsurf" />
  </picture>&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/dark/githubcopilot.png" />
    <img src="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/light/githubcopilot.png" width="48" height="48" alt="GitHub Copilot" title="GitHub Copilot" />
  </picture>&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/dark/opencode.png" />
    <img src="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/light/opencode.png" width="48" height="48" alt="OpenCode" title="OpenCode" />
  </picture>&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/dark/pi.png" />
    <img src="https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-png/light/pi.png" width="48" height="48" alt="Pi" title="Pi" />
  </picture>
</p>

```text
Understand this LocalFi repository, then help me customize it by [describe the outcome you want]. Before editing, read AGENTS.md, every scoped rule it identifies for the files you expect to touch, and the relevant parts of README.md, docs/REFERENCE.md, and docs/DECISIONS.md. Trace the existing implementation, its callers, data flow, and nearby tests. Summarize the constraints you found and propose the smallest coherent plan; ask only about choices that would materially change the result. Preserve the local-only privacy model, integer-cents money, local calendar dates, and append-only ledger. Never inspect or derive examples from data/ or my real database; use fictional fixtures and explicit temporary database paths. Add or update regression tests, then validate every changed path with bun run validate:agent -- <changed paths> and run the full validator when the rules require it. Finish by reporting what changed, what was validated, and any remaining risks. Do not commit or push unless I explicitly ask.
```

That prompt is the handshake, not the rulebook. `AGENTS.md` and the matching
files in `.claude/rules/` remain the durable constraints as a change crosses
different parts of the repository.

| What you want to customize | Start here |
| --- | --- |
| Dashboard composition, components, or visual language | `app/(dashboard)/`, `components/dashboard/`, `.claude/rules/frontend.md` |
| Reports or financial calculations | `app/actions/`, `lib/`, `.claude/rules/financial-domain.md` |
| Accounts, transactions, budgets, or investments | `docs/REFERENCE.md`, `lib/db/schema/`, `lib/ledger/` |
| A local integration or provider | The nearest service in `lib/`, its Server Action boundary, and the local-only product constraints |

Make customizations on a branch, keep your encrypted database and `.bak` recovery copy
outside Git, and review generated migrations before running them against a real
profile. If a customization is broadly useful, follow
[CONTRIBUTING.md](CONTRIBUTING.md) to propose it upstream.

## What it does

- Tracks assets and liabilities from one account model.
- Records transactions, transfers, recurring rules, and monthly budget moves.
- Maintains an append-only financial ledger for confirmed facts.
- Records daily net-worth and holding values, with optional live commodity and
  crypto pricing.
- Provides reports, privacy mode, and a developer ledger explorer.

## Showcase

Every value below comes from the deterministic fictional demo generator. No
personal database or real financial data is used to build these images.

### Dashboard — Your whole financial picture

See net worth, cash movement, holdings, liabilities, and recent activity together without stitching totals across tools.

<p align="center">
  <img src="docs/images/dark/dashboard.png" width="100%" alt="LocalFi Dashboard in dark mode with net-worth totals, history chart, liabilities, and cash overview" />
</p>

### Accounts — Balances with their history attached

Review assets and liabilities alongside the net-worth timeline derived from the same financial record.

<p align="center">
  <img src="docs/images/light/accounts.png" width="100%" alt="LocalFi Accounts in light mode with net-worth totals and detailed asset and liability balance tables" />
</p>

### Transactions — Every movement, easy to trace

Filter confirmed activity, inspect totals, and keep pending entries visible before they become financial facts.

<p align="center">
  <img src="docs/images/dark/transactions.png" width="100%" alt="LocalFi Transactions in dark mode with filters, totals, expense breakdown, and pending entries" />
</p>

### Budgets — Plans measured against reality

Compare category limits with ledger-derived spending and move money between priorities without losing the audit trail.

<p align="center">
  <img src="docs/images/light/budgets.png" width="100%" alt="LocalFi Budgets in light mode with category spending, monthly limits, remaining amounts, and budget moves" />
</p>

### Reports — Cash flow you can explain

Read income, expenses, savings rate, and category trends as projections of the same underlying ledger.

<p align="center">
  <img src="docs/images/dark/reports.png" width="100%" alt="LocalFi Reports in dark mode with cash-flow statement, savings rate, and spending breakdown" />
</p>

### Ledger — The immutable record behind every total

Verify the hash-linked event chain and open any entry to inspect its balanced movements and provenance.

<p align="center">
  <img src="docs/images/dark/ledger.png" width="100%" alt="LocalFi Ledger in dark mode with verified hash-linked events and balanced movement details" />
</p>

### Travel — A journey, not just a checklist

Map visited cities, connect each stop to its origin, and keep the full itinerary useful beside the route.

<p align="center">
  <img src="docs/images/dark/travel.png" width="100%" alt="LocalFi Travel in dark mode with an offline world globe, connected city route, and 11-city itinerary" />
</p>

## Ports and services

| Service | Port | Purpose |
| --- | --- | --- |
| LocalFi | `1313` | Next.js UI and Server Actions |

## Prerequisites

| Tool | Version | Check |
| --- | --- | --- |
| Node.js | 20+ | `node --version` |
| Bun | 1.3.14 | `bun --version` |
| Docker Compose | Current | `docker compose version` |

## Getting started

### Local development

```bash
bun install --frozen-lockfile
cp .env.example .env.local
export LOCALFI_VAULT_BOOTSTRAP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
printf 'One-time setup credential: %s\n' "$LOCALFI_VAULT_BOOTSTRAP_TOKEN"
bun run dev
```

On the first run, open <http://localhost:1313>, enter the printed bootstrap
credential, create the single-owner vault, and save the one-time recovery secret
somewhere separate from the device. The bootstrap credential only authorizes
that setup request; it is not the vault passphrase or recovery secret. Setup
consumes it inside the running server, so keep the server running and remove the
parent-shell copy with `unset LOCALFI_VAULT_BOOTSTRAP_TOKEN`. Never save the
credential in `.env.local` or another committed file.

Vault creation is intentionally UI-only: `bun run db:init` and
`bun run db:setup` refuse headless setup because a recovery secret printed
nowhere cannot be retrieved later. An existing encrypted vault does not require
a bootstrap credential when the application starts.

Existing plaintext databases are converted by this explicit setup flow after
validation. Setup tightens ordinary same-owner legacy directory/file modes to
`0700`/`0600`. Wrong-owner paths, symlinks, hard links, and non-regular database
files fail closed without changing data.

### Docker

```bash
export LOCALFI_VAULT_BOOTSTRAP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
printf 'One-time setup credential: %s\n' "$LOCALFI_VAULT_BOOTSTRAP_TOKEN"
docker compose up -d --build
```

Open <http://localhost:1313>, enter the printed credential, finish setup, and
save the recovery secret. Setup consumes the credential in the live application;
do not recreate the container or unlock again. Remove only the parent-shell copy:

```bash
unset LOCALFI_VAULT_BOOTSTRAP_TOKEN
```

The next ordinary `docker compose up -d` run with that variable absent reconciles
the container configuration. If you specifically want to purge the now-useless
configured value immediately, `docker compose up -d --force-recreate` is optional;
it will lock the vault and require one normal passphrase unlock afterward.

Verify with `docker compose ps -a`; `app` should be healthy and
`data-permissions` should have exited successfully. A fresh bind mount or legacy
conversion fails clearly when the credential is missing; an encrypted vault can
restart without it. Compose first runs that one-shot root preflight to assign the
bind-mounted `data/` directory to `${DOCKER_UID:-1000}:${DOCKER_GID:-1000}`, set
directories to `0700`, and set regular files to `0600`; the application then runs
as that non-root owner. Set `DOCKER_UID` and `DOCKER_GID` to the host IDs that
should own these private files. The directory holds encrypted live and recovery
generations, remains sensitive, and is ignored by Git and Docker build context.

### Fictional demo

Explore a populated app without using or replacing your own database:

```bash
LOCALFI_DEMO_DIR="$(mktemp -d)"
LOCALFI_DEMO_DB="$LOCALFI_DEMO_DIR/localfi-demo.db"
bun run db:demo -- --output "$LOCALFI_DEMO_DB"
BUDGET_DB_PATH="$LOCALFI_DEMO_DB" \
  DATABASE_URL="file:$LOCALFI_DEMO_DB" \
  LOCALFI_VAULT_TEST_MODE=plaintext \
  LOCALFI_DEMO_GENERATOR=1 \
  bun run dev
```

The generator creates a fresh, deterministic database, verifies its fictional
ledger, and refuses the default/configured owner database or an existing target.
To regenerate the public screenshots with system Chrome installed at
`/usr/bin/google-chrome`:

```bash
bun run showcase:capture -- --output-dir docs/images
```

That command creates its own temporary demo database, freezes the showcase clock
at the profile's anchor day, binds a child server to an isolated `127.0.0.1`
port, and builds and starts LocalFi in production mode. It validates all 14
light/dark images in a temporary staging directory before publishing them, then
removes only the temporary directory it created.

## Verification

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

Run `bun run test:tz` when changing calendar or ledger behavior. Run
`bun audit --prod --audit-level=high` before a release.

### Database command boundaries

Owner-vault maintenance commands require the app and Docker stack to be stopped,
and `LOCALFI_VAULT_PASSPHRASE` scoped to that one process. Confirm the displayed
or reported database path before proceeding; `BUDGET_DB_PATH` may override the
default owner path. `bun run agent`, `agent:once`, `db:seed`, `db:sample`, `db:upgrade`,
`db:restore`, `ledger:verify`, `ledger:rebuild`, and history backfill acquire the
same authorization seam and release it before exit. They fail nonzero when the
passphrase is absent, invalid, or the writer lease is held.

LocalFi does not expose Drizzle Studio or `db:push`: both bypass the vault,
writer lease, encrypted publication, and committed migration history. Change
the schema, generate and review a migration with `bun run db:generate`, then use
the managed upgrade path.

## Architecture

```mermaid
flowchart LR
  UI[App Router pages and feature components] --> Actions[Server Actions]
  Actions --> Domain[deterministic domain rules]
  Domain --> Ledger[append-only ledger events and movements]
  Ledger --> Projections[balances, budgets, reports, and positions]
  Actions --> Metadata[accounts, categories, settings, and drafts]
  Ledger --> DB[SQLite through Drizzle and sql.js]
  Projections --> DB
  Metadata --> DB
  DB --> Vault[(authenticated encrypted vault generation)]
  Vault -. encrypted recovery copy .-> Backup[(private .bak generation)]
```

| Layer | Location | Role |
| --- | --- | --- |
| Routes | `app/(dashboard)/` | Page composition and feature entry points |
| Actions | `app/actions/` | Validation, reads, mutations, and revalidation |
| Domain | `lib/` | Money, dates, balances, budgets, reports, pricing, and recurrence |
| Ledger | `lib/ledger/` | Canonical events, movements, projections, and verification |
| Database | `lib/db/`, `lib/db/schema/`, `drizzle/migrations/` | Database lifecycle, schema, and migration history |
| UI | `components/<feature>/` | Feature controls; `components/ui/` contains shadcn primitives |

## Where to put new code

| Change | Location | Example |
| --- | --- | --- |
| Add a page | `app/(dashboard)/<feature>/` | `budgets/page.tsx` |
| Add a financial action | `app/actions/` | `transactions.ts` |
| Add deterministic business logic | `lib/` | `budgets.ts`, `cash-balance.ts` |
| Add a ledger projection or invariant | `lib/ledger/` | `verify.ts`, `rebuild.ts` |
| Add a UI workflow | `components/<feature>/` | `components/budgets/` |
| Add a schema field | `lib/db/schema/` then `bun run db:generate` | `schema/budgets.ts` |
| Add a migration check | `lib/db/upgrade.ts` and `lib/db/__tests__/` | `migration-0015.test.ts` |

## Invariants

- Money is stored and calculated as integer cents.
- Calendar days use local `YYYY-MM-DD` keys; never derive them with
  `toISOString()`.
- Confirmed financial changes append ledger events; they are not rewritten.
- The ledger is the application-level source of truth for confirmed financial
  facts; mutable tables are metadata, drafts, or rebuildable projections.
- Transfers are not income or expense.
- One LocalFi process writes a database file at a time.
- `data/` is personal data, including encrypted recovery generations. Never commit,
  copy it into an image, or overwrite it during development.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | No | SQLite URL; defaults to `file:./data/budget.db` |
| `BUDGET_DB_PATH` | No | Direct database-file override for scripts and tests |
| `LOCALFI_VAULT_BOOTSTRAP_TOKEN` | First setup or legacy conversion only | Random 24–512 character credential that authorizes browser setup once; it is not the vault passphrase and must be unset after setup |
| `LOCALFI_VAULT_PASSPHRASE` | Headless database commands | Passphrase boundary for explicit CLI operations; prefer a one-command environment assignment and remove it immediately afterward |
| `NEXT_PUBLIC_APP_URL` | No | LocalFi URL; defaults to `http://localhost:1313` |
| `DOCKER_UID` / `DOCKER_GID` | No | Host user IDs for the Docker bind mount |
| `NOMINATIM_URL` | No | Geocoding endpoint for travel locations |
| `NOMINATIM_USER_AGENT` | No | User agent for that geocoding endpoint |
| `AGENT_API_TOKEN` | For `/api/snapshot` | Bearer token for the optional snapshot scheduler |

## Security and recovery

- LocalFi encrypts the owner database and managed recovery generations at rest,
  and enforces owner-only `0700` directories and `0600` sensitive files on
  supported Unix filesystems.
- The vault locks on restart, explicit lock, or inactivity. The persisted
  timeout defaults to 15 minutes and can be set from 1–120 minutes in Settings;
  activity extends the current session.
- Save the one-time recovery secret offline and separate from the database. A
  recovery resets the passphrase and rotates recovery material across managed
  generations.
- Reports CSV and JSON downloads are plaintext outside vault protection. CSV is
  readable by Excel and similar tools. Database downloads remain encrypted but
  are still sensitive.
- Use full-disk encryption as defense in depth. An administrator/root process,
  debugger, or compromised process running while the vault is unlocked can
  access decrypted data in memory.

See the [security boundary and recovery guide](docs/SECURITY.md) before exposing
LocalFi beyond its loopback-only default or running database maintenance tools.

## Docs

- [docs/REFERENCE.md](docs/REFERENCE.md) — code map, routes, extension points,
  and operational boundaries. Keep this in sync when structure changes.
- [docs/DECISIONS.md](docs/DECISIONS.md) — durable architectural decisions and
  rejected alternatives.
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution workflow.
- [SECURITY.md](SECURITY.md) — vulnerability-reporting policy.
- [docs/SECURITY.md](docs/SECURITY.md) — vault, recovery, exports, and operational boundaries.

The schema files and migration journal define persisted structure. The
append-only ledger is the source of truth for confirmed financial facts. The
code reference is the source of truth for where new code belongs.
