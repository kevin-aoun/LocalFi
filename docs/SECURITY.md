# Security boundary and recovery

LocalFi is single-owner and local-first. The vault encrypts data at rest and
gates local access; it is not multi-user or internet authentication.

## Vault boundary

- The live SQLite image, `.bak`, and managed backups are authenticated encrypted
  vault generations.
- Supported Unix filesystems require `0700` vault directories and owner-owned,
  regular, single-link `0600` files.
- Writes and encrypted downloads are validated before publication.
- Restart, explicit lock, or inactivity closes the in-memory database. Settings
  stores a 1–120 minute timeout; the default is 15.

An unlocked process holds decrypted data in memory. Root, debuggers, compromised
same-user processes, swap, or crash dumps may expose it. Use full-disk encryption
and lock both the screen and vault when away.

## Setup, secrets, and recovery

The three secrets have separate jobs:

| Secret | Purpose |
| --- | --- |
| Bootstrap token | Authorizes browser setup once; consumed after success |
| Passphrase | Unlocks the vault |
| Recovery secret | Resets a lost passphrase and rotates recovery material |

Generate the 24–512 character `LOCALFI_VAULT_BOOTSTRAP_TOKEN` before first start,
pass it only to the server process, and enter it in `/vault`. Remove the shell
copy after setup without restarting. Never commit it. Initialized vaults reject
setup even if a supervisor later restores the variable.

Setup is browser-only because the recovery secret is shown once. Store it
offline, apart from the passphrase and database. Recovery issues a replacement;
the old secret then stops working. Keep independent encrypted backups: the local
`.bak` does not protect against disk loss or theft.

## Exports

| Export | Protection after download |
| --- | --- |
| CSV | Plaintext; spreadsheet-readable |
| JSON | Plaintext selected data; not restorable |
| Database | Encrypted vault generation; still sensitive |

Browsers, sync tools, email, and backups may retain downloads. Encrypt or delete
plaintext exports under your own retention policy.

## Maintenance

Stop LocalFi before maintenance. Scope `LOCALFI_VAULT_PASSPHRASE` to one process;
do not use command-line arguments, committed files, or logs. Supported commands
authorize through the vault and release key state on exit.

- `bun run db:upgrade -- --db <path>` applies and verifies committed migrations.
- `bun run db:restore -- --from <backup> --db <target>` previews; add `--apply`
  only after checking both paths.
- Ledger, seed, sample, and history commands use the same boundary.

LocalFi omits `db:push` and Drizzle Studio because they bypass migration history,
the vault, backups, and the writer lease. Use `bun run db:generate`, review the
migration, and apply it through the managed upgrade path.

Compose runs a root preflight that assigns `data/` to `DOCKER_UID`/`DOCKER_GID`
and enforces private modes; the app then runs non-root. Setup may tighten safe,
same-owner legacy paths. Wrong-owner paths, symlinks, hard links, and non-regular
files fail closed.

`proxy.ts` redirects stale browser sessions before dashboard rendering. It is a
UX guard only; routes, actions, and database access still authorize independently.

## Network boundary

Keep the default `127.0.0.1:1313` binding. Review scheduler, geocoding, pricing,
proxy, and snapshot integrations before enabling them. Do not send financial
data to external services by default.
