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

## Agent access

The shared `scripts/agent-private-path-guard.mjs` rejects direct tool, shell,
and MCP attempts involving `data/`, backups, exports, credentials, database
suffixes, Docker, SQLite, or the guard configuration itself. Each supported
harness uses its documented project control:

| Harness | Project control | One-time user action |
| --- | --- | --- |
| [Cursor](https://docs.cursor.com/cli/reference/permissions) | `.cursor/cli.json`, `.cursor/hooks.json` | Trust the project and keep hooks enabled |
| [Claude Code](https://code.claude.com/docs/en/hooks) | `.claude/settings.json` deny rules, sandbox, and `PreToolUse` | Approve the project hook; never use bypass-permissions mode |
| [Codex](https://learn.chatgpt.com/docs/permissions) | `.codex/config.toml` filesystem permission profile | Trust the project so project config loads |
| [Gemini CLI](https://geminicli.com/docs/hooks/reference/) | `.gemini/settings.json` `BeforeTool` hook | Trust the folder; verify it in `/hooks panel` |
| [OpenCode](https://opencode.ai/v2/docs/permissions) | `.opencode/opencode.json` V2 permissions | Keep project configuration enabled; shell is denied |
| [Windsurf](https://docs.windsurf.com/windsurf/cascade/hooks) | `.windsurf/hooks.json` pre-read/write/command/MCP hooks | Trust the workspace hooks |
| [Cline](https://docs.cline.bot/customization/hooks) | `.clinerules/hooks/PreToolUse` | Enable Hooks in Cline, or run `cline config set hooks-enabled=true` |
| [Pi](https://pi.dev/docs/latest/extensions) | `.pi/extensions/private-finance-guard.ts` tool interceptor | Trust the project so the extension loads |

Install Node.js 20+ before opening the repository in a harness; hooks fail
closed when Node is unavailable where the harness supports fail-closed hooks.
On Windows, use WSL or put Git's `sh` on `PATH`; Cline also includes a PowerShell hook.
Test the active harness by asking it to read `data/blocked-canary.db`. It must
refuse before any file operation. Do not create that file or use a real path for
the test.

These controls govern harness tools, not every process running as your OS user.
A same-user shell, disabled hook, ungoverned extension, or external MCP server
can bypass project policy. Never give an agent a passphrase, recovery secret,
database, export, backup, host Docker access, or a tool that can retrieve them.
For a hard boundary, use a separate OS account, VM, or container that never
receives owner data.

## Setup, secrets, and recovery

The three secrets have separate jobs:

| Secret | Purpose |
| --- | --- |
| Bootstrap token | Authorizes browser setup once; rejected after initialization |
| Passphrase | Unlocks the vault |
| Recovery secret | Resets a lost passphrase and rotates recovery material |

`./setup.sh` generates the Docker bootstrap token in an ignored, owner-only
`.env`. Compose validates it and prints a one-time setup link. The browser reads
the token from the URL fragment and removes the fragment from the address bar.
Local development exports the same variable only to the server process. Never
commit or share the token. Initialized vaults reject setup even when the variable
remains configured, so cleanup and a container restart are unnecessary.

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
