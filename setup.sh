#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
env_file="$repository_root/.env"

if [ -L "$env_file" ] || { [ -e "$env_file" ] && [ ! -f "$env_file" ]; }; then
  echo "LocalFi setup refused: .env must be a regular file, not a link or directory." >&2
  exit 1
fi

if [ -f "$env_file" ]; then
  links=$(stat -c %h "$env_file" 2>/dev/null || stat -f %l "$env_file" 2>/dev/null || printf invalid)
  if [ "$links" != 1 ]; then
    echo "LocalFi setup refused: .env must have exactly one hard link." >&2
    exit 1
  fi
fi

umask 077
token=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
if [ "${#token}" -ne 64 ]; then
  echo "LocalFi setup could not generate a secure bootstrap token." >&2
  exit 1
fi

temporary=$(mktemp "$repository_root/.env.localfi.XXXXXX")
cleanup() {
  rm -f "$temporary"
}
trap cleanup 0 1 2 3 15

if [ -f "$env_file" ]; then
  awk '!/^LOCALFI_VAULT_BOOTSTRAP_TOKEN=/' "$env_file" > "$temporary"
fi
printf 'LOCALFI_VAULT_BOOTSTRAP_TOKEN=%s\n' "$token" >> "$temporary"
chmod 0600 "$temporary"
mv -f "$temporary" "$env_file"
trap - 0 1 2 3 15

printf '%s\n' \
  "LocalFi setup is ready. A secure one-time key was saved in .env." \
  "" \
  "Next, run:" \
  "  docker compose up --build" \
  "" \
  "Then open the 'LocalFi first-run setup' link shown in the terminal." \
  "If the link scrolls away, run:" \
  "  docker compose logs data-permissions"
