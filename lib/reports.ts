
import {
  isSpendable,
  isTransfer,
  transactionCashDirection,
  type CashLedgerCategory,
  type CashLedgerTransaction,
} from "./cash-balance";
import { periodContaining, periodsBetween, type BudgetPeriod, type PeriodRange } from "./budgets";
import { fromDateKey, isDateKey, toDateKey, type DateKey } from "./dates";
import { assertCents, negateCents, sumCents, type Cents } from "./money";

export type ReportTransaction = CashLedgerTransaction & {
  dateKey: DateKey;

  categoryMovementCents?: Cents;
};

export type ReportCategory = CashLedgerCategory & { name?: string | null };

export type ReportAccount = { id: number; name?: string | null; currency?: string | null };

export type ReportPeriod = BudgetPeriod;

export type FlowTotals = {

  incomeCents: Cents;

  expenseCents: Cents;

  investmentCents: Cents;

  consumptionCents: Cents;

  netCents: Cents;

  countedCount: number;

  uncategorizedCount: number;

  transferCount: number;

  pendingCount: number;

  pendingIncomeCents: Cents;

  pendingExpenseCents: Cents;
};

export function emptyFlowTotals(): FlowTotals {
  return {
    incomeCents: 0,
    expenseCents: 0,
    investmentCents: 0,
    consumptionCents: 0,
    netCents: 0,
    countedCount: 0,
    uncategorizedCount: 0,
    transferCount: 0,
    pendingCount: 0,
    pendingIncomeCents: 0,
    pendingExpenseCents: 0,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function assertKey(key: DateKey, label: string): DateKey {
  if (!isDateKey(key)) {
    throw new Error(
      `Invalid ${label}: expected 'YYYY-MM-DD' for a real calendar day, received ${JSON.stringify(key)}`,
    );
  }
  return key;
}

function categoryTypeIndex(categories: readonly ReportCategory[]): Map<number, string> {
  return new Map(categories.map((c) => [c.id, c.type]));
}


function knownType(
  tx: CashLedgerTransaction,
  typeOf: Map<number, string>,
): "Income" | "Expense" | "Investment" | undefined {
  if (tx.categoryId == null) return undefined;
  const type = typeOf.get(tx.categoryId);
  return type === "Income" || type === "Expense" || type === "Investment" ? type : undefined;
}






export function flowInRange(
  transactions: readonly ReportTransaction[],
  categories: readonly ReportCategory[],
  startKey: DateKey,
  endKey: DateKey,
): FlowTotals {
  assertKey(startKey, "start date key");
  assertKey(endKey, "end date key");

  const typeOf = categoryTypeIndex(categories);

  const income: Cents[] = [];
  const consumption: Cents[] = [];
  const investment: Cents[] = [];
  const pendingIncome: Cents[] = [];
  const pendingExpense: Cents[] = [];
  let countedCount = 0;
  let uncategorizedCount = 0;
  let transferCount = 0;
  let pendingCount = 0;

  for (const tx of transactions) {
    if (tx.dateKey < startKey || tx.dateKey > endKey) continue;
    assertCents(tx.amountCents, "amountCents");

    if (tx.categoryMovementCents !== undefined) {
      assertCents(tx.categoryMovementCents, "categoryMovementCents");
      const type = knownType(tx, typeOf);
      if (type === undefined) {
        uncategorizedCount += 1;
        continue;
      }
      countedCount += 1;
      if (type === "Income") income.push(negateCents(tx.categoryMovementCents));
      else if (type === "Investment") investment.push(tx.categoryMovementCents);
      else consumption.push(tx.categoryMovementCents);
      continue;
    }


    if (isTransfer(tx)) {
      transferCount += 1;
      continue;
    }

    const type = knownType(tx, typeOf);
    const direction = transactionCashDirection(tx, type);

    if (!isSpendable(tx)) {

      pendingCount += 1;
      if (direction === "inflow") pendingIncome.push(tx.amountCents);
      else if (direction === "outflow") pendingExpense.push(tx.amountCents);
      continue;
    }

    if (direction === "none") {


      uncategorizedCount += 1;
      continue;
    }

    countedCount += 1;
    if (direction === "inflow") income.push(tx.amountCents);
    else if (type === "Investment") investment.push(tx.amountCents);
    else consumption.push(tx.amountCents);
  }

  const incomeCents = sumCents(income);
  const investmentCents = sumCents(investment);
  const consumptionCents = sumCents(consumption);
  const expenseCents = sumCents([consumptionCents, investmentCents]);

  return {
    incomeCents,
    expenseCents,
    investmentCents,
    consumptionCents,
    netCents: sumCents([incomeCents, negateCents(expenseCents)]),
    countedCount,
    uncategorizedCount,
    transferCount,
    pendingCount,
    pendingIncomeCents: sumCents(pendingIncome),
    pendingExpenseCents: sumCents(pendingExpense),
  };
}

export type CashFlowRow = PeriodRange &
  FlowTotals & {

    savingsRate: number | null;
  };

export type CashFlowInput = {
  transactions: readonly ReportTransaction[];
  categories: readonly ReportCategory[];
  period: ReportPeriod;
  fromKey: DateKey;
  toKey: DateKey;
};


export function cashFlowByPeriod(input: CashFlowInput): CashFlowRow[] {
  const { transactions, categories, period } = input;
  const fromKey = assertKey(input.fromKey, "from date key");
  const toKey = assertKey(input.toKey, "to date key");
  if (fromKey > toKey) return [];



  return periodsBetween(period, fromKey, toKey).map((range) => {
    const totals = flowInRange(transactions, categories, range.startKey, range.endKey);
    return { ...range, ...totals, savingsRate: savingsRate(totals) };
  });
}






export function savingsRate(totals: Pick<FlowTotals, "incomeCents" | "expenseCents">): number | null {
  assertCents(totals.incomeCents, "incomeCents");
  assertCents(totals.expenseCents, "expenseCents");
  if (totals.incomeCents === 0) return null;
  const net = sumCents([totals.incomeCents, negateCents(totals.expenseCents)]);
  return net / totals.incomeCents;
}


export function savingsRateExcludingInvestments(
  totals: Pick<FlowTotals, "incomeCents" | "consumptionCents">,
): number | null {
  assertCents(totals.incomeCents, "incomeCents");
  assertCents(totals.consumptionCents, "consumptionCents");
  if (totals.incomeCents === 0) return null;
  const net = sumCents([totals.incomeCents, negateCents(totals.consumptionCents)]);
  return net / totals.incomeCents;
}


export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}


export function formatSavingsRate(rate: number | null | undefined): string {
  return formatPercent(rate);
}






function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}


export function shiftYears(key: DateKey, years: number): DateKey {
  assertKey(key, "date key");
  if (!Number.isInteger(years)) throw new Error(`shiftYears expects whole years, got ${years}`);
  const year = Number(key.slice(0, 4)) + years;
  const month = Number(key.slice(5, 7));
  const day = Math.min(Number(key.slice(8, 10)), daysInMonth(year, month));
  return `${year}-${pad2(month)}-${pad2(day)}`;
}


export function dayBefore(key: DateKey): DateKey {
  const d = fromDateKey(assertKey(key, "date key"));
  return toDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
}

export type KeyRange = { startKey: DateKey; endKey: DateKey };


export function previousPeriodRange(
  period: ReportPeriod,
  range: PeriodRange | KeyRange,
): PeriodRange {
  return periodContaining(period, dayBefore(assertKey(range.startKey, "start date key")));
}


export function sameRangeLastYear(range: KeyRange): KeyRange {
  return {
    startKey: shiftYears(range.startKey, -1),
    endKey: shiftYears(range.endKey, -1),
  };
}

export type PeriodDelta = {

  absoluteCents: Cents;

  ratio: number | null;
};

export type FlowComparison = {
  income: PeriodDelta;
  expense: PeriodDelta;
  net: PeriodDelta;

  savingsRatePoints: number | null;

  previousHasData: boolean;
};

function delta(currentCents: Cents, previousCents: Cents): PeriodDelta {
  const absoluteCents = sumCents([currentCents, negateCents(previousCents)]);
  return {
    absoluteCents,
    ratio: previousCents === 0 ? null : absoluteCents / Math.abs(previousCents),
  };
}


export function compareFlows(current: FlowTotals, previous: FlowTotals): FlowComparison {
  const currentRate = savingsRate(current);
  const previousRate = savingsRate(previous);
  return {
    income: delta(current.incomeCents, previous.incomeCents),
    expense: delta(current.expenseCents, previous.expenseCents),
    net: delta(current.netCents, previous.netCents),
    savingsRatePoints:
      currentRate === null || previousRate === null ? null : currentRate - previousRate,
    previousHasData: previous.countedCount > 0,
  };
}





export type BreakdownDirection = "income" | "expense" | "all";

export type CategoryBreakdownRow = {

  categoryId: number | null;
  name: string;

  type: string;

  totalCents: Cents;
  count: number;

  share: number | null;

  uncategorized: boolean;
};

export type CategoryBreakdownInput = {
  transactions: readonly ReportTransaction[];
  categories: readonly ReportCategory[];
  startKey: DateKey;
  endKey: DateKey;

  direction?: BreakdownDirection;
};


export function categoryBreakdown(input: CategoryBreakdownInput): CategoryBreakdownRow[] {
  const { transactions, categories } = input;
  const direction = input.direction ?? "expense";
  const startKey = assertKey(input.startKey, "start date key");
  const endKey = assertKey(input.endKey, "end date key");

  const typeOf = categoryTypeIndex(categories);
  const nameOf = new Map(categories.map((c) => [c.id, (c.name ?? "").trim() || `#${c.id}`]));

  type Bucket = {
    categoryId: number | null;
    name: string;
    type: string;
    amounts: Cents[];
    count: number;
    uncategorized: boolean;
  };
  const buckets = new Map<string, Bucket>();

  for (const tx of transactions) {
    if (tx.dateKey < startKey || tx.dateKey > endKey) continue;
    assertCents(tx.amountCents, "amountCents");
    if (tx.categoryMovementCents !== undefined) {
      assertCents(tx.categoryMovementCents, "categoryMovementCents");
      const currentType = knownType(tx, typeOf);
      if (currentType === undefined) continue;
      const isIncome = currentType === "Income";
      if (direction === "income" && !isIncome) continue;
      if (direction === "expense" && isIncome) continue;
      const key = String(tx.categoryId);
      const bucket = buckets.get(key) ?? {
        categoryId: tx.categoryId ?? null,
        name: nameOf.get(tx.categoryId as number) ?? `#${tx.categoryId}`,
        type: currentType,
        amounts: [],
        count: 0,
        uncategorized: false,
      };
      bucket.amounts.push(
        (isIncome ? negateCents(tx.categoryMovementCents) : tx.categoryMovementCents) as Cents,
      );
      bucket.count += 1;
      buckets.set(key, bucket);
      continue;
    }
    if (!isSpendable(tx)) continue;

    const currentType = knownType(tx, typeOf);
    const cashDirection = transactionCashDirection(tx, currentType);
    const isIncome = cashDirection === "inflow";
    const isOut = cashDirection === "outflow";

    if (cashDirection === "none") {


      if (direction !== "all") continue;
    } else if (direction === "income" && !isIncome) {
      continue;
    } else if (direction === "expense" && !isOut) {
      continue;
    }

    const key = tx.categoryId == null ? "none" : String(tx.categoryId);
    const bucket = buckets.get(key) ?? {
      categoryId: tx.categoryId ?? null,
      name:
        cashDirection === "none"
          ? tx.categoryId == null
            ? "No category"
            : `Deleted category #${tx.categoryId}`
          : (nameOf.get(tx.categoryId as number) ?? `#${tx.categoryId}`),
      type:
        cashDirection === "none"
          ? "Uncategorized"
          : isIncome
            ? "Income"
            : currentType === "Investment"
              ? "Investment"
              : "Expense",
      amounts: [],
      count: 0,
      uncategorized: cashDirection === "none",
    };
    bucket.amounts.push(tx.amountCents);
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  const rows = [...buckets.values()].map((bucket) => ({
    categoryId: bucket.categoryId,
    name: bucket.name,
    type: bucket.type,
    totalCents: sumCents(bucket.amounts),
    count: bucket.count,
    share: null as number | null,
    uncategorized: bucket.uncategorized,
  }));



  const totalIn = sumCents(rows.filter((r) => r.type === "Income").map((r) => r.totalCents));
  const totalOut = sumCents(
    rows.filter((r) => r.type === "Expense" || r.type === "Investment").map((r) => r.totalCents),
  );

  for (const row of rows) {
    const denominator = row.type === "Income" ? totalIn : row.uncategorized ? 0 : totalOut;
    row.share = denominator === 0 ? null : row.totalCents / denominator;
  }

  return rows.sort((a, b) =>
    b.totalCents === a.totalCents ? a.name.localeCompare(b.name) : b.totalCents - a.totalCents,
  );
}





export function normalizeCurrencyCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return code === "" ? "USD" : code;
}

export type ReportCurrencyScope = {

  currencies: string[];

  primary: string;
  mixed: boolean;

  unassignedCount: number;
};


export function currencyScope(
  transactions: readonly ReportTransaction[],
  accounts: readonly ReportAccount[],
): ReportCurrencyScope {
  const currencyOfAccount = new Map(
    accounts.map((a) => [a.id, normalizeCurrencyCode(a.currency)] as const),
  );

  const counts = new Map<string, number>();
  let unassignedCount = 0;

  for (const tx of transactions) {
    if (!isSpendable(tx)) continue;
    const code =
      typeof tx.currency === "string" && tx.currency.trim() !== ""
        ? normalizeCurrencyCode(tx.currency)
        : tx.accountId == null
          ? undefined
          : currencyOfAccount.get(tx.accountId);
    if (code === undefined) {
      unassignedCount += 1;
      continue;
    }
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }

  const currencies = [...counts.keys()].sort();
  const primary =
    [...counts.entries()].sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))[0]?.[0] ??
    "USD";

  return { currencies, primary, mixed: currencies.length > 1, unassignedCount };
}


export function filterByCurrency<T extends ReportTransaction>(
  transactions: readonly T[],
  accounts: readonly ReportAccount[],
  currency: string,
  options?: { includeUnassigned?: boolean },
): T[] {
  const wanted = normalizeCurrencyCode(currency);
  const includeUnassigned = options?.includeUnassigned === true;
  const currencyOfAccount = new Map(
    accounts.map((a) => [a.id, normalizeCurrencyCode(a.currency)] as const),
  );

  return transactions.filter((tx) => {
    const code =
      typeof tx.currency === "string" && tx.currency.trim() !== ""
        ? normalizeCurrencyCode(tx.currency)
        : tx.accountId == null
          ? undefined
          : currencyOfAccount.get(tx.accountId);
    if (code === undefined) return includeUnassigned;
    return code === wanted;
  });
}





export type WithDateKey<T> = Omit<T, "date"> & { dateKey: DateKey };


function asDate(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);

  if (isDateKey(value)) return fromDateKey(value);
  throw new Error(`Unsupported transaction date: ${JSON.stringify(value)}`);
}

export function toReportTransactions<
  T extends CashLedgerTransaction & { date: Date | string | number },
>(rows: readonly T[]): Array<WithDateKey<T>> {
  return rows.map((row) => {
    const { date, ...rest } = row;
    return { ...rest, dateKey: toDateKey(asDate(date)) } as WithDateKey<T>;
  });
}






export function centsToDecimalString(cents: Cents): string {
  assertCents(cents, "cents");
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${pad2(abs % 100)}`;
}


export const CSV_HEADERS = [
  "Date",
  "Category",
  "Amount",
  "Description",
  "Type",
  "Account",
  "Pending",
  "Transfer To",
  "Currency",
] as const;


export const CSV_BOM = "\uFEFF";


export function toCsvField(value: string | null | undefined): string {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type CsvTransactionRow = {
  dateKey: DateKey;
  categoryName: string;
  categoryType: string;

  amountCents: Cents;
  description: string | null | undefined;
  accountName: string | null | undefined;
  pending: boolean;

  transferAccountName: string | null | undefined;
  currency: string;
};

export function buildTransactionsCsv(rows: readonly CsvTransactionRow[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const row of rows) {
    assertKey(row.dateKey, "transaction date key");
    lines.push(
      [
        toCsvField(row.dateKey),
        toCsvField(row.categoryName),
        toCsvField(centsToDecimalString(row.amountCents)),
        toCsvField(row.description),
        toCsvField(row.categoryType),
        toCsvField(row.accountName),
        toCsvField(row.pending ? "yes" : "no"),
        toCsvField(row.transferAccountName),
        toCsvField(normalizeCurrencyCode(row.currency)),
      ].join(","),
    );
  }
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}
