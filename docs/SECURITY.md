# Security boundary and recovery

LocalFi is a single-owner, local-first application. Its vault protects the
database at rest and gates access with a passphrase-backed local session. It is
not a multi-user authorization system and must remain on the loopback-only
default unless you independently harden and review the whole deployment.

## What the vault protects

- The canonical SQLite image is stored as an authenticated encrypted LocalFi
  vault generation. The automatic `.bak` generation and managed upgrade or
  restore backups use the same encrypted format.
- On supported Unix filesystems, LocalFi requires its vault directory to be
  owner-only mode `0700` and sensitive files to be regular, owner-owned,
  single-link files with mode `0600`.
- Atomic writes are validated as complete vault envelopes before publication.
  An encrypted database download snapshots that saved generation while the
  writer lock is held and validates its envelope before returning it.
- Restarting the process begins locked. An explicit lock or inactivity closes
  the in-memory database and destroys the active vault authorization. Activity
  extends the session; Settings persists a timeout from 1–120 minutes, with a
  default of 15 minutes. A shorter saved timeout affects the active session
  immediately.

Encryption at rest does not protect an unlocked process. LocalFi must decrypt
the SQLite image in memory to operate. A root/administrator process, debugger,
malicious same-user process, compromised dependency, swap capture, or crash
dump may access decrypted data while the vault is unlocked. Use operating-system
full-disk encryption to cover swap, temporary files, source checkouts, and other
data outside the managed vault. Lock the screen and LocalFi when stepping away.

## Passphrase and recovery

Choose a unique vault passphrase and save the one-time recovery secret offline,
separate from both the database and passphrase. LocalFi does not know or escrow
either secret. If the passphrase is lost, the recovery flow validates the
recovery secret, sets a new passphrase, re-encrypts all managed generations,
and issues replacement recovery material. Save the new recovery secret; the old
one no longer unlocks the rotated generations.

Create or convert an owner vault only through the browser setup page. Before the
first start, generate a random 24–512 character
`LOCALFI_VAULT_BOOTSTRAP_TOKEN`, pass it only in the server process environment,
and enter that value in the setup form. This bootstrap credential authorizes the
one setup request; it is not the vault passphrase or recovery secret. Setup
consumes the server-process value after success. Also remove it from the parent
shell or container configuration and restart the server so process supervisors
cannot restore it. Do not put it in a committed environment file.

The `db:init` and `db:setup` commands deliberately refuse headless
initialization: vault creation produces recovery material exactly once, and a
CLI that discarded or obscured it would leave no later way to retrieve it.

Keep more than one encrypted backup on media you control, and test recovery
with a disposable database path. The automatic `.bak` is a previous generation
beside the live file, not protection from disk failure, theft, or accidental
loss of the whole directory.

## Exports leave different boundaries

Every Reports download requires a confirmation that names its format and
protection:

- CSV is plaintext, readable by Excel and similar spreadsheet applications,
  and outside vault protection once downloaded.
- JSON is a plaintext export of the selected, non-restorable report data and is
  outside vault protection once downloaded.
- The database download is a portable encrypted LocalFi vault generation. It
  remains sensitive and still needs the passphrase or recovery secret to use.

The browser, operating system, synchronization clients, email tools, and cloud
backup services may retain downloaded files. Delete or encrypt plaintext
exports according to your own retention policy.

## Command-line maintenance

Headless database commands that need an unlocked vault accept the passphrase
through `LOCALFI_VAULT_PASSPHRASE`, acquire the same database authorization seam,
and clear their in-process key state before exit. Environment variables can be exposed to
the process owner, administrators, diagnostics, shell history when assigned
carelessly, and some process-launch tooling. Scope the variable to one command,
avoid command-line arguments or committed environment files, and remove it from
the environment afterward. Never print it in logs.

Use the repository commands for managed data:

- `bun run db:upgrade -- --db <path>` replays and verifies the committed
  migration journal under the writer lease.
- `bun run db:restore -- --from <backup> --db <target>` validates and previews;
  repeat with `--apply` only after reviewing the exact paths.
- `bun run ledger:verify`, `bun run ledger:rebuild`, `bun run agent`,
  `bun run db:seed`, `bun run db:sample`, and history backfill use the same
  one-process passphrase boundary. Stop the app and Docker stack first.

LocalFi does not expose `db:push` or Drizzle Studio because they bypass vault
authorization, encrypted-generation publication, backups, the writer lease,
and committed migration history. Use `bun run db:generate`, review the generated
migration, and apply it through the managed upgrade path. Never run the app and
a maintenance writer against the same path.

For Compose, a one-shot root preflight assigns the private bind mount to
`DOCKER_UID`/`DOCKER_GID`, makes directories `0700`, and makes regular files
`0600`; the long-running application remains non-root. Review those IDs before
starting on a shared host. A fresh bind mount or legacy conversion also requires
the bootstrap credential and fails clearly without it. After successful setup,
unset the host variable and force-recreate the Compose services so the credential
is no longer stored in their configured environment. Browser setup tightens
ordinary same-owner legacy `0755` directories and `0644` single-link files;
wrong-owner paths, symlinks, hard links, and non-regular files still fail closed.

## Network boundary

The default app binds to `127.0.0.1:1313`. Keep that loopback boundary: vault
cookies and same-origin checks reduce accidental local access but are not a
general-purpose internet authentication layer. Review optional AI, scheduler,
geocoding, price-provider, reverse-proxy, and snapshot integrations separately
before enabling them; do not send financial data to a service by default.
