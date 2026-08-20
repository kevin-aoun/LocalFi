---
paths:
  - "lib/db/**/*.ts"
  - "drizzle/**/*.sql"
  - "drizzle/**/*.json"
  - "scripts/db-*.ts"
  - "scripts/ledger-*.ts"
  - "scripts/backfill-history.ts"
---

# Persistence and migrations

- `lib/db/schema/` and `drizzle/migrations/meta/_journal.json` are the persisted
  model's source of truth. Keep schema, SQL migration, snapshot, and journal entry
  in one change.
- Generate migrations with `bun run db:generate`. Do not casually rewrite generated
  SQL or snapshots, renumber migrations, or repair the journal by hand.
- Every schema change needs an idempotent upgrade verifier in `lib/db/upgrade.ts`
  and a migration test under `lib/db/__tests__/` using a temporary database.
- Use `readDb` for reads and `withDb` for mutations. Keep each logical mutation and
  its projection updates inside one serialized callback.
- `sql.js` holds one in-memory image and flushes the whole file atomically. The
  writer lease is cross-process protection: never bypass it or open the same file
  from a sidecar, worker, or second app process.
- Never validate a write path against `data/budget.db`. Point `BUDGET_DB_PATH` at a
  disposable temporary file and close the cached database between test cases.
- Preserve fail-closed corruption checks, backup-before-replacement behavior,
  fsync/rename ordering, foreign-key enforcement, and migration replayability.
