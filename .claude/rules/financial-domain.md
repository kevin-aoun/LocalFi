---
paths:
  - "app/actions/**/*.ts"
  - "app/api/snapshot/**/*.ts"
  - "lib/money.ts"
  - "lib/dates.ts"
  - "lib/cash-balance.ts"
  - "lib/budgets.ts"
  - "lib/recurrence.ts"
  - "lib/reports.ts"
  - "lib/prices.ts"
  - "lib/privacy.ts"
  - "lib/ledger/**/*.ts"
  - "lib/investments/**/*.ts"
  - "lib/history/**/*.ts"
---

# Financial domain boundaries

- Parse external amounts with `parseAmount`/`tryParseAmount` and assert internal
  values with `assertCents`. Keep arithmetic in safe integer cents. Zero is valid;
  use nullish/explicit checks instead of truthiness defaults.
- Use `DateKey`, `MonthKey`, and helpers from `lib/dates.ts` for calendar semantics.
  Reject invalid or ambiguous input rather than letting JavaScript normalize it.
- Confirmed facts post balanced ledger movements per currency. Edits and deletes
  append correction events through the ledger helpers; do not mutate history or
  recreate balance math in a page, report, or action.
- Transfers move value between accounts and never count as income or expense.
  Compatibility tables are projections, not an alternate source of truth.
- Keep canonical payload, hash-chain, movement ordering, currency normalization,
  and exact-decimal investment quantity behavior deterministic.
- Server Actions validate untrusted form/input values, perform the complete write
  atomically, revalidate affected routes, and return useful failures to callers.
- Add pure domain tests and action-level regression coverage. Run timezone tests for
  changes involving dates, recurrence boundaries, or ledger effective dates.
