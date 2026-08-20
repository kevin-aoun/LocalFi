import {
  getAccountBalances,
  getLatestNetWorthSnapshot,
  getNetWorth,
} from "@/app/actions/accounts";
import { getTransactions } from "@/app/actions/transactions";

import AccountsClient from "./accounts-client";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {

  const [accounts, netWorth, latestSnapshot, transactions] = await Promise.all([
    getAccountBalances({ includeArchived: true }),
    getNetWorth(),
    getLatestNetWorthSnapshot(),
    getTransactions(),
  ]);

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
