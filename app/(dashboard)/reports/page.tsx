import { getAccounts } from "@/app/actions/accounts";
import { getCategories } from "@/app/actions/categories";
import { getTransactions } from "@/app/actions/transactions";
import { getInvestmentHistory } from "@/app/actions/assets";
import { todayKey } from "@/lib/dates";
import { toReportTransactions } from "@/lib/reports";

import ReportsClient from "./reports-client";

export const dynamic = "force-dynamic";

/**
 * Reports.
 *
 * The stored `date` timestamp is turned into a local calendar day HERE — once, on
 * the server, through `toReportTransactions` — so the browser never sees a Date it
 * could re-interpret in another timezone, and every figure downstream compares
 * 'YYYY-MM-DD' strings.
 *
 * Archived accounts are loaded on purpose: their transactions are still history, and
 * omitting them would make a report of last year disagree with last year.
 */
export default async function ReportsPage() {
  const [transactions, categories, accounts, investmentHistory] = await Promise.all([
    getTransactions(),
    getCategories(),
    getAccounts({ includeArchived: true }),
    getInvestmentHistory(),
  ]);

  const ledger = toReportTransactions(
    transactions.map((tx) => ({
      date: tx.date,
      amountCents: tx.amountCents,
      categoryId: tx.categoryId,
      accountId: tx.accountId,
      transferAccountId: tx.transferAccountId,
      pending: tx.pending,
    })),
  );

  // Bounds of the data itself, for the "All time" preset. Sorted lexicographically
  // because a DateKey sorts in calendar order by construction.
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
