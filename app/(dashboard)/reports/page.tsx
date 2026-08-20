import { getAccounts } from "@/app/actions/accounts";
import { getCategories } from "@/app/actions/categories";
import { getLedgerReportMovements } from "@/app/actions/transactions";
import { getInvestmentHistory } from "@/app/actions/assets";
import { todayKey } from "@/lib/dates";

import ReportsClient from "./reports-client";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const [transactions, categories, accounts, investmentHistory] = await Promise.all([
    getLedgerReportMovements(),
    getCategories(),
    getAccounts({ includeArchived: true }),
    getInvestmentHistory(),
  ]);

  const ledger = transactions;

  const keys = ledger.map((row) => row.dateKey).sort();

  return (
    <ReportsClient
      todayKey={todayKey()}
      transactions={ledger}
      categories={categories.map((category) => ({
        id: category.id,
        name: category.name,
        type: category.type,
        color: category.color,
      }))}
      accounts={accounts.map((account) => ({
        id: account.id,
        name: account.name,
        currency: account.currency,
      }))}
      investmentHistory={investmentHistory}
      bounds={{ earliestKey: keys[0] ?? null, latestKey: keys[keys.length - 1] ?? null }}
    />
  );
}
