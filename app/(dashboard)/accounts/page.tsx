import {
  getAccountBalances,
  getLatestNetWorthSnapshot,
  getNetWorth,
} from "@/app/actions/accounts";
import { getTransactions } from "@/app/actions/transactions";

import AccountsClient from "./accounts-client";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  // Archived accounts are loaded too: they are hidden behind a toggle, but their
  // balances still count towards net worth, so the page must know about them.
  const [accounts, netWorth, latestSnapshot, transactions] = await Promise.all([
    getAccountBalances({ includeArchived: true }),
    getNetWorth(),
    getLatestNetWorthSnapshot(),
    getTransactions(),
  ]);

  // Transactions with no account at all. Counted here rather than read off
  // net worth's `accountId: null` bucket, because that bucket skips PENDING rows —
  // and a pending orphan still needs repairing.
  const orphanCount = transactions.filter(
    (tx: { accountId: number | null }) => tx.accountId === null || tx.accountId === undefined,
  ).length;

  return (
    <AccountsClient
      accounts={accounts}
      netWorth={netWorth}
      latestSnapshot={latestSnapshot}
      orphanCount={orphanCount}
    />
  );
}
