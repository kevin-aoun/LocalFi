# Architecture decisions

This file records durable choices and rejected alternatives. See the
[README](../README.md) for setup and [SPECS.md](SPECS.md) for locations.

## Product boundary

- **Local and single-owner.** Compose runs only the core app on
  `127.0.0.1:1313`; optional services are profile-gated. LocalFi is not an
  internet or multi-user service.
- **Encrypted vault.** The live database and managed backups are authenticated
  encrypted generations. A passphrase-backed session holds the key only while
  unlocked. Restart, lock, or 1–120 minutes of inactivity clears it.
- **Three distinct secrets.** A one-use bootstrap credential authorizes browser
  setup, the passphrase unlocks, and the separately wrapped recovery
  secret resets the passphrase. Browser setup shows recovery material once;
  headless setup is refused.
- **Defense in depth.** Owner-only modes reduce accidental exposure but do not
  replace full-disk encryption. Privileged or compromised processes can inspect
  an unlocked vault.
- **Independent authorization.** `proxy.ts` improves stale-session UX; routes,
  actions, and database access still fail closed independently. Only explicit
  activity touches the idle deadline; background reads and snapshots do not.
  Resolve session authorization before entering the DB queue so locking can
  close the database without a circular wait.
- **Explicit export boundaries.** CSV and JSON are plaintext. Database exports
  remain encrypted. Each download states its boundary first.

## Data model

- **Integer cents.** String parsing prevents floating-point money drift.
- **Local `YYYY-MM-DD` dates.** Calendar dates never pass through UTC conversion.
- **One accounts table.** Assets and liabilities share an inventory; net worth
  is assets minus liabilities.
- **First-class transfers.** Transfers are neither income nor expense.
- **Separate transfer fees.** The transfer amount is what arrives in the destination;
  fees are paid on top from the source account as a separate Expense transaction.
  A unique `fee_for_transfer_id` links the fee to its transfer in projections and
  canonical event metadata. Create, edit, confirm, and delete keep both entries
  atomic; zero fees create no expense. Legacy embedded principal/expense splits
  remain readable and become separate entries when saved through the fee form.
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
- **Harness-native agent guards.** Project hooks and permission profiles reject
  direct access to owner data, financial file types, Docker, SQLite, and their
  own policy files. They are deterministic defense in depth, not OS isolation;
  same-user processes still require an encrypted vault and careful tool access.

## UI and integrations

- **Pure logic outside components.** Testable behavior lives in `lib/` or nearby
  `*-logic.ts`; components wire rendering and interaction.
- **Zustand for view state only.** Server Actions own server data.
- **Keyless price providers.** Default pricing needs no account or repository
  secret and is keyed by instrument symbol.
- **Shared priced investments.** Crypto and USD stock/ETF purchases share exact
  ledger quantities, position projections, and price refreshes. Stocks use
  `STOCK:<ticker>` symbols and Yahoo Finance's keyless chart endpoint; crypto
  retains CoinGecko. Only symbols leave the machine. Yahoo's endpoint is
  unofficial and quotes may be delayed; failures preserve stored values.
  The shared stock/crypto form always collects received units and the USD price
  per share or coin (up to four decimal places), without a pricing toggle or
  market preview. Exact decimal unit prices are retained in price observations
  alongside their legacy rounded cents; only the final units × price value is
  rounded to cents. Original acquisition prices live in append-only event metadata.
  Purchase writes never depend
  on a quote request; Home and Reports refresh market values independently.
  Provider aliases, such as CSPX to Yahoo's USD `CSPX.L` listing, affect quote
  requests only and preserve existing ledger instrument identities.
- **Transaction inventory supersedes opening snapshots.** Crypto quantities always
  exclude manual and migrated openings. For other instruments, posting purchases
  adds to opening positions; purchases never imply an opening is a duplicate.
  Crypto opening snapshots stay excluded even after purchases are deleted.
  Home, Reports, sidebar, and net worth value the same transaction quantities and
  cash purchase costs. Opening events and full position projections remain intact
  for audit and integrity verification. Crypto labels consistently use BTC/ETH.
- **Cash break-even includes fees.** A purchase posts principal plus fees as one
  cash outflow and instrument book amount. The original event records their
  split in `investmentCost` metadata. Reports derive each baseline from current
  ledger trade movements, including corrections, before filtering the display
  range. Manual opening valuations without a cash purchase have no cost basis.
- **One category-driven transaction form.** Categories configure optional stock,
  crypto, or commodity fields through `investment_kind`; renaming a category
  preserves that behavior. Stock, Crypto, and Commodities are supplied by default,
  reusing recognized existing investment categories on upgrade. Home creates no
  holdings; purchases and sales enter through Transactions with one category
  selection. Ordinary investment categories can still use amount-only entries.
- **Ledger sales.** A sale records a negative exact quantity and credits its
  receiving account with units × frozen price minus fees. Instrument cash amounts
  use the same sign as cash invested: buys add cost, sales subtract net proceeds.
  Reports plot market value against the weighted average cost of the units still
  held, including buy fees, so the gap is the unrealized gain. A sale releases
  its share of that cost and books the difference from net proceeds as realized
  gain; total return adds both. A net-cash baseline was rejected because it goes
  negative after profitable sales and double counts realized gains beside it.
  Unknown opening costs remain unknown. Trades on one calendar day use that day's
  pooled purchase cost before sales. A holding with zero units is worth zero, even
  after a positive manual valuation; it leaves Home and the sidebar while Reports
  keep its history, draw its drop to zero once, and report its realized gain. Create, correction, confirmation and deletion reject negative
  holdings at any effective calendar day, including later sales. Eventless trade
  drafts retain their price and fee split in `investment_draft` until confirmation
  moves those facts into immutable event metadata.
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
