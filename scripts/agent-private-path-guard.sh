#!/bin/sh
if ! command -v node >/dev/null 2>&1; then
  echo "Blocked by LocalFi: Node.js is required to evaluate the agent safety hook." >&2
  exit 2
fi
guard_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 2
repository_root=$(dirname -- "$guard_directory")
cd "$repository_root" || exit 2
exec node "$guard_directory/agent-private-path-guard.mjs" "$@"
