# Security policy

## Supported versions

Only the latest `main` branch is currently supported. LocalFi is alpha
software; keep backups of the database before upgrades.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Contact the
maintainers privately through the repository's security-advisory mechanism and
include reproduction steps, affected versions, and impact. Do not attach real
financial data; use a minimal synthetic database.

## Security posture

LocalFi uses a single-owner vault session and authenticated encryption for its
database at rest. The default Compose deployment binds only to
`127.0.0.1:1313`; the vault does not make LocalFi a hardened multi-user or
internet-facing service. Do not expose it to a LAN or public ingress. Optional
AI and snapshot services are disabled by default and must be reviewed
separately before enabling them.

Use full-disk encryption in addition to the vault, store the one-time recovery
secret separately, and treat plaintext CSV/JSON exports as sensitive. See the
[security boundary and recovery guide](docs/SECURITY.md) for the threat model,
UI-only first-run setup, Compose file-permission preflight, session timeout,
exports, and maintenance-tool limitations.
