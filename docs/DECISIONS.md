# Architecture decisions

This file records durable choices and rejected alternatives. See the
[README](../README.md) for setup and [REFERENCE.md](REFERENCE.md) for locations.

## Product boundary

- **Local and single-owner.** Compose runs only the core app on
  `127.0.0.1:1313`; optional services are profile-gated. LocalFi is not an
  internet or multi-user service.
- **Encrypted vault.** The live database and managed backups are authenticated
  encrypted generations. A passphrase-backed session holds the key only while
  unlocked. Restart, lock, or 1–120 minutes of inactivity clears it.
- **Three distinct secrets.** A process-scoped bootstrap token authorizes one
  browser setup, the passphrase unlocks, and the separately wrapped recovery
  secret resets the passphrase. Browser setup shows recovery material once;
  headless setup is refused.
- **Defense in depth.** Owner-only modes reduce accidental exposure but do not
  replace full-disk encryption. Privileged or compromised processes can inspect
  an unlocked vault.
- **Independent authorization.** `proxy.ts` improves stale-session UX; routes,
  actions, and database access still fail closed independently.
- **Explicit export boundaries.** CSV and JSON are plaintext. Database exports
  remain encrypted. Each download states its boundary first.

## Data model

- **Integer cents.** String parsing prevents floating-point money drift.
- **Local `YYYY-MM-DD` dates.** Calendar dates never pass through UTC conversion.
- **One accounts table.** Assets and liabilities share an inventory; net worth
  is assets minus liabilities.
- **First-class transfers.** Transfers are neither income nor expense.
- **One append-only ledger.** Confirmed facts append global, UUID-identified
  `ledger_events` with sequence/`previous_hash` links and balanced ordered
  movements. Pending drafts stay mutable and eventless; corrections append.
- **Ledger-derived totals.** Balances, category spend, reports, and positions
  project from the ledger. Definitions are metadata; market values use
  observations. Compatibility tables remain rebuildable projections.
- **Tamper-evident, not tamper-proof.** A database owner can recompute a suffix.
  External signing or anchoring remains possible later.
- **Presentation metadata stays mutable.** Category and budget ordering does not
  append financial events or change semantic type.

## Runtime and delivery

- **sql.js.** WebAssembly SQLite avoids native builds across supported platforms.
- **One writer.** LocalFi mutates one cached SQLite image, then validates and
  atomically publishes an encrypted generation under a cross-process lease.
- **Server Actions.** The product has one UI client; external route handlers are
  reserved for operations that need them.
- **Managed migrations.** Generate with `bun run db:generate`; the vault lifecycle
  replays the committed journal. `db:push` and Studio are omitted because they
  bypass the vault, lease, backups, and history.
- **Bun build toolchain.** Bun 1.3.14 installs and builds; standalone production
  output runs on Node 20. CI uses webpack and packages migration files.
- **Reviewed dependencies.** Dependabot updates need green CI and production
  audit review; exceptions require a documented reachability decision.
- **Source-only coding sandboxes.** Automated coding starts from a clean,
  tracked-only snapshot in a Docker microVM. Owner data, ignored files, shared
  skills, credentials, and the host Docker daemon do not cross that boundary.

## UI and integrations

- **Pure logic outside components.** Testable behavior lives in `lib/` or nearby
  `*-logic.ts`; components wire rendering and interaction.
- **Zustand for view state only.** Server Actions own server data.
- **Keyless price providers.** Default pricing needs no account or repository
  secret and is keyed by instrument symbol.
- **Read-only ledger explorer.** The optional explorer renders durable SQLite
  links with cursor pagination and integrity checks. Privacy mode hides values
  and purges loaded payloads.

## Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| `better-sqlite3` | Requires platform-specific native builds. |
| WAL and multiple writers | Adds concurrency the single-owner vault does not need. |
| Float money or timestamps for calendar days | Introduces rounding and timezone drift. |
| Separate liability table or magic transfer category | Creates totals that can disagree. |
| REST/tRPC for the product UI | Adds a second client/server contract without a second client. |
| Basic auth or shared network secret | Does not encrypt data at rest or make internet exposure safe. |
| `db:push` or Drizzle Studio | Bypasses managed vault publication and migration history. |
| immudb, Dolt, Hyperledger, or Solidity | Adds server, branching, or consensus machinery for a local owner. |
| Duplicate JavaScript ledger links | Non-durable and drift-prone; SQLite rows are canonical. |
| jsdom for arithmetic-heavy component tests | Pure logic extraction is smaller and faster. |

## Migration constraints

Schema migrations with TypeScript backfills fail closed if only the SQL phase is
present. Backup publication must succeed before replacing live data. Budget and
category actuals use the same ledger movements so UI surfaces cannot drift.
