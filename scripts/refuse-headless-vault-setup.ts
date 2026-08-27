const message = [
  "Owner vault setup is available only in the LocalFi browser UI.",
  "With Docker, run ./setup.sh, then open the one-time setup link printed by docker compose up.",
  "For local development, set LOCALFI_VAULT_BOOTSTRAP_TOKEN as documented in README.md.",
  "Save the one-time recovery secret",
  "before continuing. Headless setup is refused because a discarded recovery secret",
  "cannot be retrieved later.",
].join("\n");

console.error(message);
process.exitCode = 1;
