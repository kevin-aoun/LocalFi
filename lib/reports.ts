/**
 * Report arithmetic: cash flow, income vs expense, savings rate, period-over-
 * period and year-over-year comparison, category breakdown — plus the pure
 * serializers behind the CSV export.
 *
 * ## Why this module exists at all
 *
 * The app had no reports. Adding them is dangerous in a specific way: a report is
 * a SECOND OPINION about the user's money, and a second opinion that disagrees
 * with the dashboard is worse than no report. So nothing here re-implements the
 * ledger rule:
 *
 *   - `isTransfer` / `isSpendable` (lib/cash-balance.ts) decide what counts;
 *   - `cashContributionCents` (components/dashboard/cash-series.ts) — the per-row
 *     form of that same rule, already pinned by a test that reproduces
 *     `deriveCashBalanceCents` exactly — decides the DIRECTION and magnitude;
 *   - `periodContaining` / `periodsBetween` (lib/budgets.ts) decide where a
 *     period starts and ends, so a report month and a budget month are the same
 *     month;
 *   - every calendar day is a 'YYYY-MM-DD' `DateKey` from lib/dates.ts.
 *
 * `reports.test.ts` asserts `flowInRange(...).netCents === deriveCashBalanceCents(...)`
 * over the same rows, so the reports page cannot drift away from the dashboard.
 *
 * (The import of `cashContributionCents` from components/ is a slightly odd
 * direction for a lib/ module. The alternative is copying the six lines that
 * decide "Income adds, Expense and Investment subtract" into a third place, which
 * is exactly the duplication that made the dashboard chart contradict its own
 * headline. One rule, imported.)
 *
 * ## The conventions, restated because reports are where they get broken
 *
 *   - Money is integer cents. `incomeCents` and `expenseCents` are POSITIVE
 *     MAGNITUDES; `netCents = incomeCents − expenseCents` is signed.
 *   - An Investment category is money OUT (that is the app-wide rule), so it is
 *     part of `expenseCents`. It is also reported on its own as
 *     `investmentCents`, and `consumptionCents = expenseCents − investmentCents`,
 *     because "expenses" that silently include your brokerage transfers makes the
 *     savings rate read low. Both savings-rate measures are offered and labelled.
 *   - PENDING rows are excluded, exactly as they are from the balance. They are
 *     counted and subtotalled (`pendingCount`, `pendingIncomeCents`,
 *     `pendingExpenseCents`) so the UI can say what it left out instead of
 *     quietly dropping it.
 *   - TRANSFERS are never income or expense, anywhere.
 *   - Ratios (savings rate, % change) are the only floats. They are `number | null`
 *     and `null` whenever the denominator is zero — never `NaN`, never `Infinity`.
 *   - There is NO FX in this app. `currencyScope` reports which currencies a range
 *     spans; a mixed range is shown one currency at a time with a caveat, never
 *     added together under a "$".
 */
import { isSpendable, isTransfer, type CashLedgerCategory, type CashLedgerTransaction } from "./cash-balance";
import { periodContaining, periodsBetween, type BudgetPeriod, type PeriodRange } from "./budgets";
import { fromDateKey, isDateKey, toDateKey, type DateKey } from "./dates";
import { assertCents, negateCents, sumCents, type Cents } from "./money";
import { cashContributionCents } from "@/components/dashboard/cash-series";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A transaction as the report engine sees it: a ledger row on a calendar day. */
export type ReportTransaction = CashLedgerTransaction & { dateKey: DateKey };

/** A category as the report engine sees it. `name` is for labels only. */
export type ReportCategory = CashLedgerCategory & { name?: string | null };

/** An account as the report engine sees it: an id and a currency. */
export type ReportAccount = { id: number; name?: string | null; currency?: string | null };

/** The report period lengths — the same set budgets use, deliberately. */
export type ReportPeriod = BudgetPeriod;

export type FlowTotals = {
  /** Money in, positive magnitude. Income categories only. */
  incomeCents: Cents;
  /** Money out, positive magnitude. Expense AND Investment categories. */
  expenseCents: Cents;
  /** The Investment slice of `expenseCents` — money out, but arguably saved. */
  investmentCents: Cents;
  /** `expenseCents − investmentCents`: money out that is genuinely spent. */
  consumptionCents: Cents;
  /** `incomeCents − expenseCents`. Equals the cash-balance delta for the range. */
  netCents: Cents;
  /** Rows that contributed to a total. */
  countedCount: number;
  /** Spendable rows whose category is missing/unknown: counted nowhere. */
  uncategorizedCount: number;
  /** Transfer rows seen in the range. Excluded from every total. */
  transferCount: number;
  /** Pending rows seen in the range. Excluded from every total. */
  pendingCount: number;
  /** What the pending rows WOULD have added to income, had they cleared. */
  pendingIncomeCents: Cents;
  /** What the pending rows WOULD have taken out, had they cleared. */
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

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

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

/** "Income" | "Expense" | "Investment", or undefined when the category is unknown. */
function knownType(
  tx: CashLedgerTransaction,
  typeOf: Map<number, string>,
): "Income" | "Expense" | "Investment" | undefined {
  if (tx.categoryId == null) return undefined;
  const type = typeOf.get(tx.categoryId);
  return type === "Income" || type === "Expense" || type === "Investment" ? type : undefined;
}

// ---------------------------------------------------------------------------
// Cash flow / income vs expense
// ---------------------------------------------------------------------------

/**
 * Income, expense and net over `[startKey, endKey]`, both ends INCLUSIVE.
 *
 * Every amount is asserted to be integer cents, including on the rows that are
 * excluded, so a leaked float fails loudly instead of quietly skewing a chart.
 */
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

    // Order matters: a pending transfer is a TRANSFER, not pending income.
    if (isTransfer(tx)) {
      transferCount += 1;
      continue;
    }

    const type = knownType(tx, typeOf);

    if (!isSpendable(tx)) {
      // The only remaining reason is `pending` (transfers left above).
      pendingCount += 1;
      if (type === "Income") pendingIncome.push(tx.amountCents);
      else if (type === "Expense" || type === "Investment") pendingExpense.push(tx.amountCents);
      continue;
    }

    if (type === undefined) {
      // A row whose category was deleted. It contributes to nothing — the same
      // rule as lib/cash-balance.ts — but it is real money the user entered, so
      // it is counted and surfaced rather than dropped in silence.
      uncategorizedCount += 1;
      continue;
    }

    countedCount += 1;
    // The signed effect comes from the shared per-row rule, not from a second
    // reading of `category.type`.
    const effect = cashContributionCents(tx, categories);
    if (type === "Income") income.push(effect);
    else if (type === "Investment") investment.push(negateCents(effect));
    else consumption.push(negateCents(effect));
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
    /** (income − expenses) / income, or null when the period had no income. */
    savingsRate: number | null;
  };

export type CashFlowInput = {
  transactions: readonly ReportTransaction[];
  categories: readonly ReportCategory[];
  period: ReportPeriod;
  fromKey: DateKey;
  toKey: DateKey;
};

/**
 * One row per period overlapping `[fromKey, toKey]`, in calendar order.
 *
 * A period with no activity gets a ZERO row rather than being skipped: a gap in a
 * cash-flow chart reads as "no data available", but "we earned and spent nothing
 * in April" is a fact worth showing.
 *
 * The periods themselves come from `lib/budgets.ts`, so a report month is exactly
 * a budget month (and a report week is Monday..Sunday, like a budget week).
 */
export function cashFlowByPeriod(input: CashFlowInput): CashFlowRow[] {
  const { transactions, categories, period } = input;
  const fromKey = assertKey(input.fromKey, "from date key");
  const toKey = assertKey(input.toKey, "to date key");
  if (fromKey > toKey) return [];

  // `periodsBetween` throws rather than enumerate an absurd number of periods
  // (a weekly report anchored in 1970); that guard belongs to lib/budgets.ts.
  return periodsBetween(period, fromKey, toKey).map((range) => {
    const totals = flowInRange(transactions, categories, range.startKey, range.endKey);
    return { ...range, ...totals, savingsRate: savingsRate(totals) };
  });
}

// ---------------------------------------------------------------------------
// Ratios: savings rate and percentage change
// ---------------------------------------------------------------------------

/**
 * Savings rate as a FRACTION: `(income − expenses) / income`.
 *
 * `null` when there was no income at all. That is not a rounding decision: with
 * zero income the expression is 0/0 or −x/0, and "−Infinity%" or "NaN%" on a
 * finance dashboard is worse than an honest em dash. Negative rates are real and
 * are returned as-is (spending more than you earned).
 */
export function savingsRate(totals: Pick<FlowTotals, "incomeCents" | "expenseCents">): number | null {
  assertCents(totals.incomeCents, "incomeCents");
  assertCents(totals.expenseCents, "expenseCents");
  if (totals.incomeCents === 0) return null;
  const net = sumCents([totals.incomeCents, negateCents(totals.expenseCents)]);
  return net / totals.incomeCents;
}

/**
 * Savings rate counting money moved into Investment categories as SAVED rather
 * than spent: `(income − consumption) / income`.
 *
 * Both measures are shown on the page, labelled, because the app books an
 * Investment row as money out (so the cash balance falls) while most people would
 * call that saving. Picking one silently would misinform either way.
 */
export function savingsRateExcludingInvestments(
  totals: Pick<FlowTotals, "incomeCents" | "consumptionCents">,
): number | null {
  assertCents(totals.incomeCents, "incomeCents");
  assertCents(totals.consumptionCents, "consumptionCents");
  if (totals.incomeCents === 0) return null;
  const net = sumCents([totals.incomeCents, negateCents(totals.consumptionCents)]);
  return net / totals.incomeCents;
}

/**
 * A fraction as a percentage string, or "—" when there is no number to state.
 * The em dash covers null, NaN and ±Infinity: none of those may ever reach a
 * screen that is telling someone about their money.
 */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** `formatPercent`, named for the place it is used most. */
export function formatSavingsRate(rate: number | null | undefined): string {
  return formatPercent(rate);
}

// ---------------------------------------------------------------------------
// Period-over-period and year-over-year
// ---------------------------------------------------------------------------

/** Days in `month1` (1-12) of `year`, from local components only. */
function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}

/**
 * Shift a calendar day by whole years, CLAMPING to the last day of the month.
 *
 * 2024-02-29 minus one year is 2023-02-28, not 2023-03-01 — which is what
 * `new Date(y - 1, m, d)` silently produces, and exactly the kind of
 * wrong-but-plausible date this codebase has been bitten by before.
 */
export function shiftYears(key: DateKey, years: number): DateKey {
  assertKey(key, "date key");
  if (!Number.isInteger(years)) throw new Error(`shiftYears expects whole years, got ${years}`);
  const year = Number(key.slice(0, 4)) + years;
  const month = Number(key.slice(5, 7));
  const day = Math.min(Number(key.slice(8, 10)), daysInMonth(year, month));
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** The calendar day before `key`, built from local components. */
export function dayBefore(key: DateKey): DateKey {
  const d = fromDateKey(assertKey(key, "date key"));
  return toDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
}

export type KeyRange = { startKey: DateKey; endKey: DateKey };

/** The period of the same length immediately before `range`. */
export function previousPeriodRange(
  period: ReportPeriod,
  range: PeriodRange | KeyRange,
): PeriodRange {
  return periodContaining(period, dayBefore(assertKey(range.startKey, "start date key")));
}

/** The same calendar range one year earlier, with leap days clamped. */
export function sameRangeLastYear(range: KeyRange): KeyRange {
  return {
    startKey: shiftYears(range.startKey, -1),
    endKey: shiftYears(range.endKey, -1),
  };
}

export type PeriodDelta = {
  /** current − previous, in exact cents. */
  absoluteCents: Cents;
  /**
   * Relative change against the MAGNITUDE of the baseline, as a fraction.
   * `null` when the baseline is zero — "up from nothing" has no percentage.
   */
  ratio: number | null;
};

export type FlowComparison = {
  income: PeriodDelta;
  expense: PeriodDelta;
  net: PeriodDelta;
  /** Change in savings rate, in percentage POINTS. Null if either rate is null. */
  savingsRatePoints: number | null;
  /**
   * False when the baseline period holds no counted row at all. The UI must say
   * "no data for the comparison period" rather than imply a 100% improvement.
   */
  previousHasData: boolean;
};

function delta(currentCents: Cents, previousCents: Cents): PeriodDelta {
  const absoluteCents = sumCents([currentCents, negateCents(previousCents)]);
  return {
    absoluteCents,
    ratio: previousCents === 0 ? null : absoluteCents / Math.abs(previousCents),
  };
}

/** Current vs baseline. Use with `previousPeriodRange` or `sameRangeLastYear`. */
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

// ---------------------------------------------------------------------------
// Category breakdown
// ---------------------------------------------------------------------------

export type BreakdownDirection = "income" | "expense" | "all";

export type CategoryBreakdownRow = {
  /** The category id, or the unknown id a row still points at. */
  categoryId: number | null;
  name: string;
  /** "Income" | "Expense" | "Investment", or "Uncategorized". */
  type: string;
  /** Positive magnitude of money in (income) or out (expense/investment). */
  totalCents: Cents;
  count: number;
  /**
   * Share of the total for this row's DIRECTION, as a fraction. Null when the
   * direction total is zero, or when the row counts towards no direction.
   */
  share: number | null;
  /** True when the category is missing or was deleted: it counts towards nothing. */
  uncategorized: boolean;
};

export type CategoryBreakdownInput = {
  transactions: readonly ReportTransaction[];
  categories: readonly ReportCategory[];
  startKey: DateKey;
  endKey: DateKey;
  /** Default "expense" — the question people actually ask of a breakdown. */
  direction?: BreakdownDirection;
};

/**
 * Where the money went (or came from) over an arbitrary range, largest first.
 *
 * Transfers and pending rows are excluded, exactly as everywhere else. A row
 * whose category was deleted is reported as an explicit "Uncategorized" line
 * rather than dropped, because the money is real even though the label is gone —
 * this has already happened to the live database (see app/actions/categories.ts).
 */
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
    if (!isSpendable(tx)) continue; // transfers and pending rows, one rule

    const type = knownType(tx, typeOf);
    const isIncome = type === "Income";
    const isOut = type === "Expense" || type === "Investment";

    if (type === undefined) {
      // Money with no label. It belongs to no direction, so it appears only in
      // the "all" view — where dropping it would hide real money.
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
        type === undefined
          ? tx.categoryId == null
            ? "No category"
            : `Deleted category #${tx.categoryId}`
          : (nameOf.get(tx.categoryId as number) ?? `#${tx.categoryId}`),
      type: type ?? "Uncategorized",
      amounts: [],
      count: 0,
      uncategorized: type === undefined,
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

  // Shares are computed WITHIN a direction: an expense is a share of money out,
  // never a share of (income + expense), which is not a quantity.
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

// ---------------------------------------------------------------------------
// Currency scope — there is no FX in this app, and none is invented here
// ---------------------------------------------------------------------------

export function normalizeCurrencyCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return code === "" ? "USD" : code;
}

export type ReportCurrencyScope = {
  /** Every currency the counted rows touch, sorted. */
  currencies: string[];
  /** The currency to show first: most counted rows, ties broken alphabetically. */
  primary: string;
  mixed: boolean;
  /** Counted rows with no account, and therefore no currency of their own. */
  unassignedCount: number;
};

/**
 * Which currencies a set of counted rows spans.
 *
 * Transactions carry no currency; their ACCOUNT does. Pending rows and transfers
 * are ignored here for the same reason they are ignored everywhere else — they
 * are not part of any total, so they must not drag a currency into the report and
 * trigger a caveat about money that was never counted.
 */
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
    const code = tx.accountId == null ? undefined : currencyOfAccount.get(tx.accountId);
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

/**
 * Only the rows denominated in `currency`.
 *
 * A row with no account belongs to no currency; `includeUnassigned` decides
 * whether it joins the view being rendered (true only for the primary currency,
 * so it is never counted twice).
 */
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
    const code = tx.accountId == null ? undefined : currencyOfAccount.get(tx.accountId);
    if (code === undefined) return includeUnassigned;
    return code === wanted;
  });
}

// ---------------------------------------------------------------------------
// Stored Date -> calendar day
// ---------------------------------------------------------------------------

export type WithDateKey<T> = Omit<T, "date"> & { dateKey: DateKey };

/**
 * A stored timestamp is turned into a calendar day HERE and nowhere else, using
 * local components (`toDateKey`). Never `toISOString()`: east of UTC that reads
 * back the previous day, which put month-boundary spend in the wrong month.
 */
function asDate(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  // A string here is a stored DateKey, never an argument for `new Date(string)`.
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

// ---------------------------------------------------------------------------
// Export serializers (pure — the action in app/actions/export.ts only feeds them)
// ---------------------------------------------------------------------------

/**
 * Integer cents -> an exact two-decimal string, with NO float arithmetic at all.
 *
 * `centsToDecimal` exists for chart axes and returns a float; a file the user
 * opens in a spreadsheet deserves better than `45.50000000000001`, so the digits
 * are assembled from the integer directly. `parseAmount(centsToDecimalString(c))
 * === c` is asserted for a spread of values, including the classic float traps.
 */
export function centsToDecimalString(cents: Cents): string {
  assertCents(cents, "cents");
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${pad2(abs % 100)}`;
}

/**
 * The header row, in this order. The first four names are exactly what
 * `components/transactions/import-logic.ts` looks for (`Date`, `Category`,
 * `Amount`, `Description`), so the app can read its own export back — see
 * lib/__tests__/reports-csv-roundtrip.test.ts. `Type` is recognised too. The
 * rest are context the importer ignores.
 */
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

/**
 * A UTF-8 BOM. Without it Excel mis-decodes non-ASCII descriptions; SheetJS
 * strips it on read, so it costs the round-trip nothing.
 */
export const CSV_BOM = "\uFEFF";

/** RFC 4180: quote a field containing a comma, a quote, CR or LF; double the quotes. */
export function toCsvField(value: string | null | undefined): string {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type CsvTransactionRow = {
  dateKey: DateKey;
  categoryName: string;
  categoryType: string;
  /** Stored magnitude in integer cents. Direction is carried by `categoryType`. */
  amountCents: Cents;
  description: string | null | undefined;
  accountName: string | null | undefined;
  pending: boolean;
  /** Set only for a transfer. Such a row has no category and cannot be re-imported. */
  transferAccountName: string | null | undefined;
  currency: string;
};

/**
 * A CSV of transactions, CRLF-terminated, that the app's own importer can read.
 *
 * The `Amount` column is the stored MAGNITUDE, not a signed figure: the importer
 * takes `absCents` of whatever it finds and derives the direction from the
 * category (see the sign rule in import-logic.ts), so a magnitude plus a category
 * is the only combination that round-trips exactly.
 */
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
