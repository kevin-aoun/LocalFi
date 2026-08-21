# Security policy

## Supported versions

Only the latest `main` is supported. Keep backups before upgrades.

## Reporting a vulnerability

Use the repository's private security-advisory form. Include impact, affected
versions, and reproduction steps using fictional data. Do not open a public
issue.

## Security posture

The vault encrypts data at rest but does not make LocalFi multi-user or safe for
network exposure. Keep the default `127.0.0.1:1313` binding, use full-disk
encryption, store the recovery secret separately, and protect plaintext
exports. See [docs/SECURITY.md](docs/SECURITY.md).
