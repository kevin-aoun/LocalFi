---
paths:
  - "app/(dashboard)/**/*.ts"
  - "app/(dashboard)/**/*.tsx"
  - "app/globals.css"
  - "app/providers.tsx"
  - "components/**/*.ts"
  - "components/**/*.tsx"
---

# Frontend and privacy surfaces

- Keep route pages focused on server-side loading and composition. Add `"use client"`
  only to components that require hooks, browser APIs, or interactive state.
- Put feature UI in `components/<feature>/`; keep `components/ui/` reusable and free
  of finance-specific behavior. Reuse existing shadcn primitives and styling.
- Move deterministic form, chart, filter, and transformation logic into a nearby
  `*-logic.ts` module once it needs tests. The suite runs in Node without jsdom.
- Use shared money/date helpers rather than formatting, rounding, or date conversion
  inline. Do not duplicate server-side financial calculations in components.
- Surface actionable Server Action errors and preserve loading/disabled behavior;
  do not swallow failures or show success before the mutation completes.
- Any new amount, balance, price, quantity, or canonical ledger payload must honor
  the shared privacy state. Purge already-loaded sensitive details when privacy is
  enabled, not only mask the next render.
- Keep keyboard access, focus behavior, and explicit drag handles when adding
  interactive or sortable controls.
