import { closeDb } from "../lib/db/client";
import { verifyLedger } from "../lib/ledger/verify";

async function main() {
  const result = await verifyLedger();

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main()
  .catch(() => {
    console.error("Ledger verification failed before diagnostics could be produced.");
    process.exitCode = 1;
  })
  .finally(() => closeDb());
