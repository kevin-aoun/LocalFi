import {
  getRecurringFormOptions,
  getRecurringTransactions,
} from "@/app/actions/recurring";
import { todayKey } from "@/lib/dates";

import RecurringClient from "./recurring-client";

export const dynamic = "force-dynamic";

export default async function RecurringPage() {
  // Archived templates are fetched too and hidden behind a toggle in the client,
  // so flipping that toggle costs no round trip.
  const [templates, options] = await Promise.all([
    getRecurringTransactions({ includeArchived: true }),
    getRecurringFormOptions(),
  ]);

  return (
    <RecurringClient
      initialTemplates={templates}
      accounts={options.accounts}
      categories={options.categories}
      // Passed in rather than computed during the client's first render, so
      // hydration cannot mismatch on a date boundary. The client re-reads its own
      // local day after mounting, which is the day the user actually sees.
      initialToday={todayKey()}
    />
  );
}
