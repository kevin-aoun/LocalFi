const message = [
  "Owner vault setup is available only in the LocalFi browser UI.",
  "Generate LOCALFI_VAULT_BOOTSTRAP_TOKEN as documented in README.md, start LocalFi,",
  "open http://localhost:1313, and save the one-time recovery secret",
  "before continuing. Headless setup is refused because a discarded recovery secret",
  "cannot be retrieved later.",
].join("\n");

console.error(message);
process.exitCode = 1;
