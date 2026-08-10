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

LocalFi has no authentication or authorization. It is intended for one trusted
user on one machine. The default Compose deployment binds only to
`127.0.0.1:1313`; do not expose it to a LAN or public ingress. Optional AI and
snapshot services are disabled by default and must be reviewed separately
before enabling them.
