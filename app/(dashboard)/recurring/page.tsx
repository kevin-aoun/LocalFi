import {
  getRecurringFormOptions,
  getRecurringTransactions,
} from "@/app/actions/recurring";
import { todayKey } from "@/lib/dates";

import RecurringClient from "./recurring-client";

export const dynamic = "force-dynamic";

export default async function RecurringPage() {

  const [templates, options] = await Promise.all([
    getRecurringTransactions({ includeArchived: true }),
    getRecurringFormOptions(),
  ]);

  return (
    <RecurringClient
      initialTemplates={templates}
      accounts={options.accounts}
      categories={options.categories}

      initialToday={todayKey()}
    />
  );
}
