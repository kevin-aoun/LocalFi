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

LocalFi is a local-first app for accounts, transactions, budgets, investments,
travel, and net worth. Its canonical SQLite database and `.bak` recovery copy
are encrypted on your machine. Confirmed financial facts enter one append-only,
hash-linked ledger that drives balances, budgets, reports, and positions.

> **Local-only by design.** The default Docker setup binds to `127.0.0.1`.
> LocalFi is not a hardened multi-user or internet-facing service.

## Customize your LocalFi

**Every component is customizable:** layout, colors, categories, reports,
workflows, data model, ledger projections, and local integrations.

For automated coding, use a source-only [Docker Sandbox](https://docs.docker.com/ai/sandboxes/):

```bash
bun run sandbox:source -- codex
```

The launcher requires a clean commit, copies only tracked source to a separate
directory, then enables clone isolation and disables shared skills. It never
mounts the owner checkout, databases, exports, backups, environment files, or
the host Docker socket. Do not run `sbx` directly from this checkout: even its
clone mode exposes ignored files in the source directory read-only.

Install `sbx` from Docker's [installation guide](https://docs.docker.com/ai/sandboxes/install/).
Replace `codex` with another supported template when needed. Commit work inside
the sandbox before removing it. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
project invariants and validation commands.

## What it does

- Tracks accounts, liabilities, transactions, transfers, budgets, and investments.
- Derives balances and reports from an append-only financial ledger.
- Records net-worth history, travel, and optional market prices.
- Includes privacy mode and a read-only ledger explorer.

## Showcase

All displayed values are synthetic and contain no personal database content.

### Dashboard — Your whole financial picture

See net worth, cash flow, holdings, liabilities, and recent activity together.

<p align="center">
  <img src="docs/images/dark/dashboard.png" width="100%" alt="LocalFi Dashboard in dark mode with net-worth totals, history chart, liabilities, and cash overview" />
</p>

### Accounts — Balances with their history attached

Review assets, liabilities, and their shared net-worth history.

<p align="center">
  <img src="docs/images/light/accounts.png" width="100%" alt="LocalFi Accounts in light mode with net-worth totals and detailed asset and liability balance tables" />
</p>

### Transactions — Every movement, easy to trace

Filter confirmed activity while pending entries remain clearly separate.

<p align="center">
  <img src="docs/images/dark/transactions.png" width="100%" alt="LocalFi Transactions in dark mode with filters, totals, expense breakdown, and pending entries" />
</p>

### Budgets — Plans measured against reality

Compare limits with ledger-derived spending and auditable reallocations.

<p align="center">
  <img src="docs/images/light/budgets.png" width="100%" alt="LocalFi Budgets in light mode with category spending, monthly limits, remaining amounts, and budget moves" />
</p>

### Reports — Cash flow you can explain

Explain income, expenses, savings rate, and category trends from one ledger.

<p align="center">
  <img src="docs/images/dark/reports.png" width="100%" alt="LocalFi Reports in dark mode with cash-flow statement, savings rate, and spending breakdown" />
</p>

### Ledger — The immutable record behind every total

Verify the hash chain and inspect each event's balanced movements.

<p align="center">
  <img src="docs/images/dark/ledger.png" width="100%" alt="LocalFi Ledger in dark mode with verified hash-linked events and balanced movement details" />
</p>

### Travel — A journey, not just a checklist

Map a chronological itinerary with connected stops and country flags.

<p align="center">
  <img src="docs/images/dark/travel.png" width="100%" alt="LocalFi Travel in dark mode with an offline world globe, connected city route, and 11-city itinerary" />
</p>

## Prerequisites

| Tool | Version | Check |
| --- | --- | --- |
| Node.js | 20+ | `node --version` |
| Bun | 1.3.14 | `bun --version` |
| Docker Compose | Current | `docker compose version` |
| Docker Sandboxes | Optional | `sbx version` |

LocalFi serves the UI and Server Actions at `127.0.0.1:1313`.

## Getting started

### Local development

```bash
bun install --frozen-lockfile
cp .env.example .env.local
export LOCALFI_VAULT_BOOTSTRAP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
printf 'One-time setup credential: %s\n' "$LOCALFI_VAULT_BOOTSTRAP_TOKEN"
bun run dev
```

Open <http://localhost:1313>, enter the printed setup credential, choose a vault
passphrase, and save the one-time recovery secret off-device. The credential
authorizes setup once; it is not your passphrase. After setup, keep the server
running and run `unset LOCALFI_VAULT_BOOTSTRAP_TOKEN`. Never save the token in a
committed file. Existing vaults start without it.

Setup is browser-only so LocalFi can show the recovery secret exactly once. It
also converts valid same-owner legacy databases and tightens permissions to
`0700` directories and `0600` files. Unsafe paths fail closed.

### Docker

```bash
export LOCALFI_VAULT_BOOTSTRAP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
printf 'One-time setup credential: %s\n' "$LOCALFI_VAULT_BOOTSTRAP_TOKEN"
docker compose up -d --build
```

Open <http://localhost:1313>, complete setup, save the recovery secret, then
remove the shell copy of the token without restarting:

```bash
unset LOCALFI_VAULT_BOOTSTRAP_TOKEN
```

Verify with `docker compose ps -a`: `app` should be healthy and
`data-permissions` should exit successfully. That one-shot service assigns
`data/` to `${DOCKER_UID:-1000}:${DOCKER_GID:-1000}` and enforces private modes;
the app runs as that non-root owner. The next ordinary Compose start drops the
unset token from container configuration.

## Verification

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

Run `bun run test:tz` for calendar or ledger changes and
`bun audit --prod --audit-level=high` before release.

### Database command boundaries

Stop LocalFi before database maintenance. Scope `LOCALFI_VAULT_PASSPHRASE` to
one command and confirm the target path; supported commands use the vault gate
and writer lease. LocalFi omits Drizzle Studio and `db:push` because they bypass
those controls. Generate schema changes with `bun run db:generate`, review the
migration, then use the managed upgrade path.

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

## Where to put new code

| Change | Location |
| --- | --- |
| Page | `app/(dashboard)/<feature>/` |
| Server Action | `app/actions/` |
| Domain rule | `lib/` |
| Ledger behavior | `lib/ledger/` |
| Feature UI | `components/<feature>/` |
| Schema or migration | `lib/db/schema/`, `drizzle/migrations/`, `lib/db/upgrade.ts` |

## Invariants

- Money is stored and calculated as integer cents.
- Calendar days use local `YYYY-MM-DD` keys; never derive them with
  `toISOString()`.
- Confirmed financial changes append ledger events; they are not rewritten.
- The ledger is the source of truth for confirmed financial facts.
- Transfers are not income or expense.
- One LocalFi process writes a database file at a time.
- Never inspect, commit, or overwrite `data/` during development.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | No | SQLite URL; defaults to `file:./data/budget.db` |
| `BUDGET_DB_PATH` | No | Direct database-file override for scripts and tests |
| `LOCALFI_VAULT_BOOTSTRAP_TOKEN` | First setup or conversion | One-use, random 24–512 character browser setup credential |
| `LOCALFI_VAULT_PASSPHRASE` | Headless database commands | One-process vault authorization |
| `NEXT_PUBLIC_APP_URL` | No | LocalFi URL; defaults to `http://localhost:1313` |
| `DOCKER_UID` / `DOCKER_GID` | No | Host user IDs for the Docker bind mount |
| `NOMINATIM_URL` | No | Geocoding endpoint for travel locations |
| `NOMINATIM_USER_AGENT` | No | Geocoding user agent |
| `SNAPSHOT_API_TOKEN` | For `/api/snapshot` | Bearer token for the optional snapshot scheduler |

## Security and recovery

- Vault files are encrypted and owner-only (`0700` directories, `0600` files).
- Restart, lock, or 1–120 minutes of inactivity closes the vault.
- Store the one-time recovery secret offline and apart from the database.
- CSV and JSON exports are plaintext; database exports remain encrypted.
- Use full-disk encryption: privileged or compromised processes can read an
  unlocked vault from memory.

See the [security boundary and recovery guide](docs/SECURITY.md) before exposing
LocalFi beyond its loopback-only default or running database maintenance tools.

## Docs

- [docs/REFERENCE.md](docs/REFERENCE.md) — code map and extension points.
- [docs/DECISIONS.md](docs/DECISIONS.md) — architectural decisions.
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution workflow.
- [SECURITY.md](SECURITY.md) — vulnerability-reporting policy.
- [docs/SECURITY.md](docs/SECURITY.md) — vault, recovery, and exports.

Schema and migration files define persistence; the ledger defines confirmed
financial facts; the code reference defines extension points.
