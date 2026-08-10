# Release decisions

This document records why LocalFi is shaped this way; return to the [README](../README.md) for the user-facing hub and see the [code reference](REFERENCE.md) for where the implementation lives.

## Local-only default deployment

The default Compose graph contains only the core LocalFi app and publishes it
on `127.0.0.1:1313`. Optional model and scheduler services are profile-gated;
their absence must not prevent the core app from starting. This preserves the
local-only alpha boundary and keeps deferred AI infrastructure out of the
default runtime.

## Dependency maintenance

Production dependency updates are applied through reviewed lockfile changes
and Dependabot pull requests. CI runs `bun audit --prod --audit-level=high`.
An advisory may be accepted only when the affected code path is unreachable,
the dependency is not shipped to production, or an upstream fix is not yet
available and the exception is documented in the pull request.

## Bun package management and builds

Local development, CI, and the Docker builder pin Bun 1.3.14 and use the
text-based `bun.lock`. The Dockerfile installs and builds in one cached stage,
which avoids copying the entire dependency tree between stages. Next's
standalone production output still runs on Node 20, preserving the established
runtime boundary. This change targets dependency installation and Docker layer
overhead; it does not claim to make webpack compilation itself instantaneous.

## Deterministic release gates

Strict typecheck generates Next App Router types first so it also works on a
clean checkout. Production builds explicitly use webpack, which avoids
Turbopack worker-port restrictions in sandboxed release environments while
still producing Next's optimized standalone output. The runner copies the raw
migration journal and SQL files because database readiness reads them at
startup; omitting them would make an otherwise valid image unable to upgrade an
existing ledger.

## Single local append-only ledger

Confirmed financial facts use one global `ledger_events` hash chain and ordered
`ledger_movements`. A UUID is event identity; the database sequence is chain
order. `previous_hash` and sequence are the durable linked structure, and each
event must balance independently in every currency. Movements carry signed
positive/negative amounts covered by the canonical payload hash; they are not
cryptographically signed. Pending drafts remain mutable, visible only in the
Transactions UI and pending queue, and eventless until confirmation. Confirmed
edits and deletes append corrections. Balances, category spend, and instrument
positions are ledger-derived; account and category definitions are metadata;
market value uses observations. `assets` and `asset_history` remain
compatibility projections.

Legacy holdings remain independent imported instrument identities even when
symbols match; new purchases use the canonical provider-symbol identity. This
avoids fabricated consolidation or row deletion. Cash is account-derived and
excluded from instrument migration. Migration-generated opening dates use
local `DateKey`s and retain provenance.

This is the right boundary for a single-owner, local-only app: SQLite supplies
atomic transactions and Node's [`crypto`](https://nodejs.org/api/crypto.html)
supplies SHA-256. See [SQLite atomic commit](https://sqlite.org/atomiccommit.html),
[SQLite transactions](https://sqlite.org/transactional.html), and the [Node
crypto API](https://nodejs.org/api/crypto.html).

The chain is tamper-evident, not independently tamper-proof. A user with full
database write access can recompute a suffix; signing or external anchoring can
be added later. We rejected [immudb](https://docs.immudb.io/master/immudb.html)
as an extra database/runtime, [Dolt](https://dolthub.com/docs/concepts/dolt/git/)
as branching/version-control semantics, and [Hyperledger ordering](https://hyperledger-fabric.readthedocs.io/en/latest/orderer/ordering_service.html)
and Solidity as multi-party consensus/smart-contract infrastructure.

## Read-only ledger explorer

Settings → Developer tools → Show ledger explorer conditionally exposes the
sidebar item and the dynamic `/ledger` route. The explorer uses cursor
pagination, date/currency/target/search filters, integrity verification,
correction links, and TanStack Virtual's vertical linked-chain rendering
([React virtualizer docs](https://tanstack.com/virtual/latest/docs/framework/react/react-virtual)).
It is read-only; privacy mode masks values and canonical payload details while
preserving structural diagnostics. The UI renders sequence and predecessor
hashes from SQLite; it does not maintain a duplicate JavaScript linked list.
Base cursor responses withhold canonical metadata and payload. A capped,
exact-event read occurs only on expansion while privacy is off; loaded payloads
are purged when privacy activates. Correction navigation can load an off-page
virtualized target.

## Migration safety and budget actuals

Migration 0012 is a schema-plus-TypeScript operation: a populated SQL-only
0012 schema fails closed rather than being adopted without the TypeScript
UUID/canonical-payload hash and backfill phase. A failed `.bak` refresh aborts
before live replacement. The Categories tab's spend uses the same journal
category movements as budget actuals, so the two surfaces cannot drift.

## Decision record

| Decision | Why | Rejected alternative |
| --- | --- | --- |
| sql.js (WebAssembly SQLite) | No native compilation, no `node-gyp`, identical behaviour on Windows/macOS/Linux and inside Alpine. | `better-sqlite3` — faster and supports real transactions, but needs a native build per platform. |
| One cached in-memory image, flushed atomically per mutation | Trivially correct for one user; the database stays a single portable file you can copy, back up, or email to yourself. SQLite transactions provide the atomic commit boundary before the file flush. See [SQLite atomic commit](https://sqlite.org/atomiccommit.html) and [SQLite transactions](https://sqlite.org/transactional.html). | A long-lived connection with WAL — better concurrency the app doesn't need. |
| Money as integer cents, everywhere | Float money drifts at the cent (`2.675 * 100 === 267.49999999999994`). Parsing is done on strings, so the drift is structurally impossible rather than merely unlikely. | `real` columns and rounding at the edges — which is what 0002 migrated away from. |
| Calendar days as `'YYYY-MM-DD'` strings | Sorts in calendar order, compares without a timezone, and cannot be shifted by `toISOString()`. A budget month and a report month are then the same month by construction. | Timestamps everywhere — which had already put a Beirut user's 28th into the 27th. |
| One `accounts` table for assets *and* liabilities | Net worth is `sum(assets) − sum(liabilities)`: one query over one table, so the halves cannot drift. | A parallel `liabilities` table — two inventories of money to reconcile by hand. |
| Transfers as first-class transactions | A transfer is not income or expense. Modelling it as a category ("Transfer") makes every total wrong in a way nobody notices. | Two mirrored transactions, or a magic category. |
| Server Actions instead of a REST/tRPC API | No client/server type drift, no fetch layer, no second surface to keep in sync. Note this does *not* mean "nothing to authenticate" — they are POST endpoints. | Route handlers under `app/api/` — needed only if a second client appears. |
| No authentication (for now) | Single user, loopback binding, one file on their own disk. Adding a real auth story is a project, not a checkbox, and a half-done one is worse than a documented absence. | Basic auth or a shared secret — security theatre that would invite exposing the port. |
| Balance derived from the ledger, in one module | One source of truth, so the dashboard, `/accounts`, `/budgets` and `/reports` cannot disagree. `reports.test.ts` asserts `flowInRange(...).netCents === deriveCashBalanceCents(...)` over the same rows. | Re-deriving totals per page — which is exactly how the dashboard chart once contradicted its own headline. |
| Compatibility transaction amounts stay positive; direction is snapshotted | The compatibility row stores a positive magnitude plus its historical direction; journal movements carry the signs. | Signed amounts in the compatibility transaction row. |
| Keyless price providers (SwissQuote, CoinGecko) | No API key, no signup, no secret to leak in an open-source repo, and the app stays runnable by anyone who clones it. | A keyed provider (metals-api and similar). |
| Pricing keyed by *symbol*, not by commodity type | BTC and ETH are not commodities and are not on a forex feed. Widening "commodity" until it meant "anything with a price" was the alternative. | `commodityTypes += "Bitcoin"` — a lie in the schema and a broken request to SwissQuote. |
| Zustand only for view state | Server Actions own server data; stores hold dialog/filter/sort state so pages don't drown in `useState`. | Caching server data client-side, which would fight `revalidatePath()`. |
| Drizzle migrations, replayed by a custom script | `drizzle-kit migrate` doesn't target sql.js, so `lib/db/init.ts` walks the journal itself. | `db:push` for schema sync — convenient, but leaves no migration history. |
| Component logic extracted to `*-logic.ts` | There is no jsdom, so components cannot be rendered in a test. Extracting the logic makes the interesting part testable and keeps the `.tsx` as wiring. | Adding jsdom + Testing Library — a large dependency and a slower suite for behaviour that is mostly arithmetic. |
| One global append-only ledger with SQLite sequence/hash links | The app is single-owner and local-only; SQLite supplies atomic transactions while Node supplies SHA-256 via [`crypto`](https://nodejs.org/api/crypto.html). A single journal keeps balances and corrections auditable without another runtime. | [immudb](https://docs.immudb.io/master/immudb.html) adds a database/runtime; [Dolt](https://dolthub.com/docs/concepts/dolt/git/) adds branching/version-control semantics; [Hyperledger ordering](https://hyperledger-fabric.readthedocs.io/en/latest/orderer/ordering_service.html) and Solidity add multi-party consensus/smart-contract infrastructure. |
| Durable links are database sequence plus `previous_hash` | The linked structure survives reloads and can be verified from SQLite rows; the explorer only renders those rows. | A duplicate JavaScript linked list, which would be non-durable and drift-prone. |
