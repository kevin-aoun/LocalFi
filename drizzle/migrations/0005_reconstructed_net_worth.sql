/*
 0005 — a net-worth row says whether it was MEASURED or INFERRED.

 WHY. `snapshotNetWorth()` records TODAY's derived figures and deliberately
 refuses to file them under a past date: doing so would assert a net worth that
 was never true. That refusal is correct and stays.

 Reconstruction (lib/history/**) does the other, legitimate thing — it COMPUTES
 what net worth was on each past day: the cash side exactly, by replaying the
 ledger, and the holdings side from historical prices. The result is an ESTIMATE.
 It uses a PAX Gold proxy for XAU, carries prices across weekends, and for the
 owner's BTC/ETH rows it has to infer the acquisition date from
 `assets.created_at` because the Crypto category contains no transactions at all.

 Written into the same table with no marker, an estimate and an observation would
 be indistinguishable forever after. So:

   `source`      'recorded' (what snapshotNetWorth writes) | 'reconstructed'.
                 NOT NULL DEFAULT 'recorded', so every row that already exists —
                 all of which were recorded — is correctly labelled by the ALTER
                 itself, with no UPDATE and no guesswork.
   `source_note` WHY a given day is an estimate, in words, e.g.
                 "reconstructed from the ledger; XAU via pax-gold proxy priced on
                 2025-11-02; BTC price carried forward from 2025-11-01".
                 NULL for a recorded row: there is nothing to disclose.

 The reconstruction never overwrites a 'recorded' row — it skips it and reports
 how many it skipped. This column is what makes that possible.

 WHAT THIS DELIBERATELY DOES NOT DO

 - No CHECK constraint on `source`. SQLite cannot add one to an existing table
   without rebuilding it, and rebuilding a table to police a two-value string is
   a bad trade in a file that holds real financial history. The value is enforced
   in lib/db/schema/net-worth.ts (a typed enum) and by the only two writers.
 - No index. The table holds one row per day; a year is 365 rows.
 - Two nullable-or-defaulted ADD COLUMNs cannot lose a byte, so no table is
   rebuilt, nothing can cascade, and re-running the pair is the only thing that
   would error (SQLite rejects a duplicate column name) — which is why the
   one-shot script checks first.
*/
ALTER TABLE `net_worth_snapshots` ADD COLUMN `source` text DEFAULT 'recorded' NOT NULL;--> statement-breakpoint
ALTER TABLE `net_worth_snapshots` ADD COLUMN `source_note` text;
