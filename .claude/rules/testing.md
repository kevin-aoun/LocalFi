---
paths:
  - "**/__tests__/**/*.ts"
  - "**/__tests__/**/*.tsx"
  - "vitest.config.ts"
---

# Tests and regression coverage

- Tests run in Vitest's Node environment. Do not introduce jsdom-dependent tests;
  extract pure component behavior into `*-logic.ts` and test that contract.
- Put regression tests in the nearest existing `__tests__/` directory and name them
  after the behavior or source module. Prefer a focused test over broad snapshots.
- Database tests must use the temporary-db helpers or an explicit disposable
  `BUDGET_DB_PATH`, close cached state, and never read or mutate the default database.
- Keep fixtures synthetic and deterministic. Do not include real ledger data,
  credentials, network calls, live prices, locale-dependent parsing, or current-time
  assumptions without an explicit clock/date input.
- Assert boundary failures as well as success: zero versus missing, invalid dates,
  atomic rollback, ledger balance/hash integrity, privacy masking, and error surfaces.
- Run `bun run validate:agent -- <changed paths>` after the change. Use `--full` only
  for broad/release validation; date and ledger changes automatically add `test:tz`.
