import { closeDb } from "../lib/db/client";
import { rebuildLedgerProjections } from "../lib/ledger/rebuild";

async function main() {
  if (!process.argv.slice(2).includes("--projection-only")) {
    console.error("Refusing rebuild without explicit --projection-only mode.");
    process.exitCode = 2;
    return;
  }
  const result = await rebuildLedgerProjections();
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch(() => {
    console.error("Ledger projection rebuild failed; journal rows were not changed.");
    process.exitCode = 1;
  })
  .finally(() => closeDb());
