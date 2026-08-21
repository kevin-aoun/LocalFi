import type { Database } from "sql.js";

import type { DateKey } from "@/lib/dates";
import {
  ensureInstrument,
  projectPositionHolding,
  recordInstrumentObservation,
} from "@/lib/investments";
import {
  buildProjectedTransactionMovements,
  buildTransactionProjection,
  postLedgerEventRaw,
  registerLedgerAccount,
  verifyLedgerRaw,
  type CurrentTransactionAllocation,
} from "@/lib/ledger";

import type { BudgetDb } from "./client";
import { syncCashAssetWithin } from "./sync-cash";

export const DEMO_ANCHOR_DATE: DateKey = "2026-08-15";
export const DEMO_RECORDED_AT = 1_776_249_600;

const categories = [
  [1, "Salary", "Income", null, 0, "Wallet", "#10b981"],
  [2, "Freelance", "Income", null, 1, "Laptop", "#34d399"],
  [3, "Gifts", "Income", null, 2, "Gift", "#6ee7b7"],
  [4, "Housing", "Expense", 135_000, 0, "Home", "#ef4444"],
  [5, "Groceries", "Expense", 50_000, 1, "ShoppingCart", "#f59e0b"],
  [6, "Dining", "Expense", 25_000, 2, "UtensilsCrossed", "#f97316"],
  [7, "Transport", "Expense", 18_000, 3, "Car", "#8b5cf6"],
  [8, "Utilities", "Expense", 30_000, 4, "Zap", "#06b6d4"],
  [9, "Healthcare", "Expense", 20_000, 5, "Heart", "#f43f5e"],
  [10, "Leisure", "Expense", 22_000, 6, "Film", "#ec4899"],
  [11, "Bank Fees", "Expense", 5_000, 7, "Receipt", "#64748b"],
  [12, "Long-Term Investing", "Investment", 120_000, 0, "TrendingUp", "#0ea5e9"],
] as const;

const accounts = [
  [1, "Olive Checking", "asset", "Checking"],
  [2, "Mountain Savings", "asset", "Savings"],
  [3, "Cedar Credit Card", "liability", "CreditCard"],
  [4, "Wallet Cash", "asset", "Cash"],
] as const;

type DemoTransaction = {
  id: number;
  date: DateKey;
  categoryId: number | null;
  accountId: number;
  transferAccountId?: number | null;
  amountCents: number;
  direction: "inflow" | "outflow" | "transfer";
  comment: string;
  instrumentId?: string | null;
  quantityDelta?: string | null;
  transferPrincipalAmountCents?: number | null;
  allocations?: CurrentTransactionAllocation[];
};

const confirmedTransactions: DemoTransaction[] = [
  { id: 1, date: "2025-12-31", categoryId: 2, accountId: 1, amountCents: 1_200_000, direction: "inflow", comment: "Website launch project" },
  { id: 2, date: "2026-01-02", categoryId: 1, accountId: 1, amountCents: 420_000, direction: "inflow", comment: "January salary" },
  { id: 3, date: "2026-01-05", categoryId: 4, accountId: 1, amountCents: 135_000, direction: "outflow", comment: "Mar Mikhaël apartment rent" },
  { id: 4, date: "2026-01-10", categoryId: 5, accountId: 1, amountCents: 42_650, direction: "outflow", comment: "Saturday souk groceries" },
  { id: 5, date: "2026-01-16", categoryId: 6, accountId: 3, amountCents: 18_400, direction: "outflow", comment: "Dinner in Gemmayzeh" },
  { id: 6, date: "2026-01-20", categoryId: null, accountId: 1, transferAccountId: 2, amountCents: 250_000, direction: "transfer", comment: "Monthly savings transfer" },
  { id: 7, date: "2026-02-02", categoryId: 1, accountId: 1, amountCents: 420_000, direction: "inflow", comment: "February salary" },
  { id: 8, date: "2026-02-08", categoryId: 8, accountId: 1, amountCents: 22_100, direction: "outflow", comment: "Electricity, generator, and internet" },
  { id: 9, date: "2026-02-19", categoryId: 9, accountId: 3, amountCents: 7_500, direction: "outflow", comment: "Neighborhood pharmacy" },
  { id: 10, date: "2026-03-02", categoryId: 1, accountId: 1, amountCents: 420_000, direction: "inflow", comment: "March salary" },
  { id: 11, date: "2026-03-15", categoryId: 12, accountId: 1, amountCents: 120_000, direction: "outflow", comment: "Global equity fund purchase", instrumentId: "instrument:local:aurx", quantityDelta: "12" },
  { id: 12, date: "2026-03-22", categoryId: 10, accountId: 3, amountCents: 8_900, direction: "outflow", comment: "Cinema night" },
  { id: 13, date: "2026-04-02", categoryId: 1, accountId: 1, amountCents: 420_000, direction: "inflow", comment: "April salary" },
  { id: 14, date: "2026-04-05", categoryId: 4, accountId: 1, amountCents: 135_000, direction: "outflow", comment: "Mar Mikhaël apartment rent" },
  { id: 15, date: "2026-04-18", categoryId: null, accountId: 1, transferAccountId: 2, amountCents: 150_500, direction: "transfer", comment: "Savings transfer with bank fee", transferPrincipalAmountCents: 150_000, allocations: [{ categoryId: 11, amountCents: 500 }] },
  { id: 16, date: "2026-05-02", categoryId: 1, accountId: 1, amountCents: 420_000, direction: "inflow", comment: "May salary" },
  { id: 17, date: "2026-05-11", categoryId: 5, accountId: 1, amountCents: 46_820, direction: "outflow", comment: "Monthly groceries" },
  { id: 18, date: "2026-05-24", categoryId: 7, accountId: 4, amountCents: 6_200, direction: "outflow", comment: "Service taxi and bus fares" },
  { id: 19, date: "2026-06-02", categoryId: 1, accountId: 1, amountCents: 420_000, direction: "inflow", comment: "June salary" },
  { id: 20, date: "2026-06-05", categoryId: 4, accountId: 1, amountCents: 135_000, direction: "outflow", comment: "Mar Mikhaël apartment rent" },
  { id: 21, date: "2026-06-21", categoryId: 6, accountId: 3, amountCents: 21_300, direction: "outflow", comment: "Lunches and café visits" },
  { id: 22, date: "2026-07-02", categoryId: 1, accountId: 1, amountCents: 420_000, direction: "inflow", comment: "July salary" },
  { id: 23, date: "2026-07-14", categoryId: 9, accountId: 3, amountCents: 12_400, direction: "outflow", comment: "Dental checkup" },
  { id: 24, date: "2026-08-02", categoryId: 1, accountId: 1, amountCents: 420_000, direction: "inflow", comment: "August salary" },
  { id: 25, date: "2026-08-09", categoryId: 5, accountId: 1, amountCents: 48_750, direction: "outflow", comment: "Monthly groceries" },
  { id: 26, date: "2026-08-13", categoryId: 6, accountId: 3, amountCents: 1_750, direction: "outflow", comment: "Corniche coffee and kaak" },
];

const pendingTransactions: DemoTransaction[] = [
  { id: 27, date: "2026-08-16", categoryId: 8, accountId: 1, amountCents: 23_400, direction: "outflow", comment: "Pending utility bill" },
  { id: 28, date: "2026-08-18", categoryId: 3, accountId: 1, amountCents: 35_000, direction: "inflow", comment: "Pending birthday gift" },
];

function scalar(raw: Database, sql: string): number {
  return Number(raw.exec(sql)[0]?.values[0]?.[0] ?? 0);
}

function dateEpoch(dateKey: DateKey): number {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const day = Number(dateKey.slice(8, 10));
  return Math.floor(Date.UTC(year, month - 1, day, 12) / 1_000);
}

function eventId(serial: number): string {
  return `10000000-0000-4000-8000-${String(serial).padStart(12, "0")}`;
}

function normalizeFreshSchemaBootstrap(raw: Database): void {
  const populated = [
    "asset_history",
    "budgets",
    "categories",
    "ledger_events",
    "net_worth_snapshots",
    "quick_commands",
    "recurring_transactions",
    "settings",
    "transactions",
    "travel_checkpoints",
    "visited_countries",
  ].filter((table) => scalar(raw, `SELECT COUNT(*) FROM ${table}`) !== 0);
  if (populated.length > 0) {
    throw new Error(`Demo data requires an empty database; found rows in ${populated.join(", ")}`);
  }
  const accountRows = raw.exec(
    "SELECT id, name, kind, type, opening_balance_cents, currency FROM accounts ORDER BY id",
  )[0]?.values ?? [];
  const assetRows = raw.exec(
    "SELECT id, category, current_value_cents, currency, instrument_id FROM assets ORDER BY id",
  )[0]?.values ?? [];
  const projectionRows = raw.exec(
    "SELECT projection FROM ledger_projection_state ORDER BY projection",
  )[0]?.values ?? [];
  const instrumentRows = raw.exec(
    "SELECT id, kind, label, symbol, unit, category, price_source, price_currency FROM instruments",
  )[0]?.values ?? [];
  const targetRows = raw.exec(
    "SELECT id, target_type, target_ref, currency, instrument_id FROM ledger_accounts",
  )[0]?.values ?? [];
  const isDefaultAccount = accountRows.length === 1 &&
    JSON.stringify(accountRows[0]) === JSON.stringify([1, "Main", "asset", "Checking", 0, "USD"]);
  const isBootstrapCash = assetRows.length === 0 ||
    (assetRows.length === 1 && assetRows[0][1] === "Cash" &&
      assetRows[0][2] === 0 && assetRows[0][3] === "USD" && assetRows[0][4] === null);
  const isBootstrapProjection = projectionRows.length === 0 ||
    (projectionRows.length === 1 && /^cash:USD:[1-9]\d*$/.test(String(projectionRows[0][0])));
  const isCurrencyInstrument = instrumentRows.length === 0 ||
    (instrumentRows.length === 1 && JSON.stringify(instrumentRows[0]) ===
      JSON.stringify(["currency:USD", "currency", "USD", "USD", "minor", null, null, "USD"]));
  const isDefaultTarget = targetRows.length === 0 ||
    (targetRows.length === 1 && JSON.stringify(targetRows[0]) ===
      JSON.stringify(["real_account:1:USD", "real_account", "1", "USD", null]));
  if (
    !isDefaultAccount || !isBootstrapCash || !isBootstrapProjection ||
    !isCurrencyInstrument || !isDefaultTarget
  ) {
    throw new Error("Demo data requires a pristine newly migrated database");
  }
  raw.run("DELETE FROM ledger_projection_state");
  raw.run("DELETE FROM assets");
  raw.run("DELETE FROM ledger_accounts");
  raw.run("DELETE FROM instruments");
  raw.run("DELETE FROM accounts");
}

function insertMetadata(raw: Database): void {
  for (const [id, name, type, monthlyLimit, displayOrder, icon, color] of categories) {
    raw.run(
      `INSERT INTO categories
        (id, name, type, monthly_limit_cents, display_order, icon, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, type, monthlyLimit, displayOrder, icon, color, DEMO_RECORDED_AT, DEMO_RECORDED_AT],
    );
  }
  for (const [id, name, kind, type] of accounts) {
    raw.run(
      `INSERT INTO accounts
        (id, name, kind, type, opening_balance_cents, opening_balance_date, currency,
         archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, '2025-12-31', 'USD', 0, ?, ?)`,
      [id, name, kind, type, DEMO_RECORDED_AT, DEMO_RECORDED_AT],
    );
  }
  raw.run(
    `INSERT INTO settings
      (id, user_name, accent_color, theme, show_ledger, created_at, updated_at)
     VALUES (1, 'Khalil Mansour', 'ocean', 'dark', 1, ?, ?)`,
    [DEMO_RECORDED_AT, DEMO_RECORDED_AT],
  );
  const commands = [
    [1, "coffee", "Dining", 650, "Morning coffee"],
    [2, "groceries", "Groceries", 8_500, "Weekly grocery run"],
    [3, "transit", "Transport", 350, "Service taxi fare"],
  ] as const;
  for (const command of commands) {
    raw.run(
      `INSERT INTO quick_commands
        (id, command, category_name, amount_cents, comment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [...command, DEMO_RECORDED_AT, DEMO_RECORDED_AT],
    );
  }
}

function registerStableTargets(raw: Database): void {
  for (const [id] of accounts) {
    registerLedgerAccount(raw, {
      targetType: "real_account",
      targetRef: id,
      currency: "USD",
      createdAt: DEMO_RECORDED_AT,
    });
  }
  for (const [id] of categories) {
    registerLedgerAccount(raw, {
      targetType: "category",
      targetRef: id,
      currency: "USD",
      createdAt: DEMO_RECORDED_AT,
    });
  }
  for (const targetRef of ["opening-position", "instrument-book:instrument:local:aurx"]) {
    registerLedgerAccount(raw, {
      targetType: "system",
      targetRef,
      currency: "USD",
      createdAt: DEMO_RECORDED_AT,
    });
  }
}

function postOpeningAsset(raw: Database, input: {
  assetId: number;
  serial: number;
  instrumentId: string;
  label: string;
  category: "Properties" | "Vehicles";
  bookAmountMinor: number;
  currentValueMinor: number;
}): void {
  ensureInstrument(raw, {
    id: input.instrumentId,
    kind: "manual",
    label: input.label,
    symbol: null,
    unit: "holding",
    category: input.category,
    priceSource: null,
    priceCurrency: "USD",
  }, DEMO_RECORDED_AT);
  raw.run(
    `INSERT INTO assets
      (id, category, current_value_cents, currency, instrument_id, notes, use_live_price,
       archived, created_at, updated_at)
     VALUES (?, ?, 0, 'USD', ?, ?, 0, 0, ?, ?)`,
    [input.assetId, input.category, input.instrumentId, input.label, DEMO_RECORDED_AT, DEMO_RECORDED_AT],
  );
  recordInstrumentObservation(raw, {
    instrumentId: input.instrumentId,
    observationKind: "valuation",
    observedDay: DEMO_ANCHOR_DATE,
    observedAt: DEMO_RECORDED_AT,
    amountMinor: input.currentValueMinor,
    currency: "USD",
    source: "manual-entry",
  });
  const instrumentTarget = registerLedgerAccount(raw, {
    targetType: "instrument",
    targetRef: `asset:${input.assetId}`,
    currency: "USD",
    instrumentId: input.instrumentId,
    createdAt: DEMO_RECORDED_AT,
  });
  const openingTarget = registerLedgerAccount(raw, {
    targetType: "system",
    targetRef: "opening-position",
    currency: "USD",
    createdAt: DEMO_RECORDED_AT,
  });
  postLedgerEventRaw(raw, {
    eventId: eventId(input.serial),
    effectiveDate: "2025-12-31",
    description: `Opening position for ${input.label}`,
    metadata: {
      fact: "opening-position",
      assetId: input.assetId,
      instrumentId: input.instrumentId,
      quantity: "1",
      bookAmountMinor: input.bookAmountMinor,
      currency: "USD",
      provenance: { source: "manual-entry" },
    },
    movements: [
      { ledgerAccountId: instrumentTarget, amountMinor: input.bookAmountMinor, currency: "USD", quantityDelta: "1" },
      { ledgerAccountId: openingTarget, amountMinor: -input.bookAmountMinor, currency: "USD" },
    ],
    recordedAt: DEMO_RECORDED_AT,
  });
  projectPositionHolding(raw, input.instrumentId, "USD");
  raw.run("UPDATE assets SET created_at = ?, updated_at = ? WHERE id = ?", [
    DEMO_RECORDED_AT,
    DEMO_RECORDED_AT,
    input.assetId,
  ]);
}

function insertTransaction(raw: Database, input: DemoTransaction, pending: boolean): void {
  const timestamp = dateEpoch(input.date);
  const transferAccountId = input.transferAccountId ?? null;
  const instrumentId = input.instrumentId ?? null;
  const quantityDelta = input.quantityDelta ?? null;
  const principal = input.transferPrincipalAmountCents ?? null;
  raw.run(
    `INSERT INTO transactions
      (id, date, category_id, account_id, transfer_account_id, amount_cents, direction,
       currency, current_event_id, instrument_id, quantity_delta,
       transfer_principal_amount_cents, comment, pending, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      timestamp,
      input.categoryId,
      input.accountId,
      transferAccountId,
      input.amountCents,
      input.direction,
      instrumentId,
      quantityDelta,
      principal,
      input.comment,
      pending ? 1 : 0,
      timestamp,
      timestamp,
    ],
  );
  const allocations = input.allocations ?? [];
  allocations.forEach((allocation, position) => {
    raw.run(
      `INSERT INTO transaction_allocations
        (transaction_id, position, category_id, amount_cents) VALUES (?, ?, ?, ?)`,
      [input.id, position, allocation.categoryId, allocation.amountCents],
    );
  });
  if (pending) return;
  const projection = {
    id: input.id,
    date: timestamp,
    categoryId: input.categoryId,
    accountId: input.accountId,
    transferAccountId,
    amountCents: input.amountCents,
    direction: input.direction,
    currency: "USD",
    comment: input.comment,
    recurringId: null,
    recurringOccurrence: null,
    instrumentId,
    quantityDelta,
    transferPrincipalAmountCents: principal,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const event = postLedgerEventRaw(raw, {
    eventId: eventId(100 + input.id),
    effectiveDate: input.date,
    description: input.comment,
    metadata: {
      projectionKey: input.id,
      transaction: buildTransactionProjection(projection, allocations),
      provenance: { source: "manual-entry" },
    },
    movements: buildProjectedTransactionMovements(raw, projection, allocations),
    recordedAt: timestamp,
  });
  raw.run("UPDATE transactions SET current_event_id = ? WHERE id = ?", [event.eventId, input.id]);
}

function insertBudgetsAndPlans(raw: Database): void {
  const rows = [
    [1, 4, "monthly", 135_000, "2026-01-01", null, 0, null, null, 0],
    [2, 5, "monthly", 45_000, "2026-01-01", "2026-03-31", 0, null, null, 1],
    [3, 5, "monthly", 50_000, "2026-04-01", null, 1, null, null, 1],
    [4, 6, "monthly", 25_000, "2026-01-01", null, 0, null, null, 2],
    [5, 7, "monthly", 18_000, "2026-01-01", null, 0, null, null, 3],
    [6, 8, "monthly", 30_000, "2026-01-01", null, 0, null, null, 4],
    [7, 9, "yearly", 240_000, "2026-01-01", null, 0, null, null, 5],
    [8, 10, "monthly", 22_000, "2026-01-01", null, 0, null, null, 6],
    [9, 12, "monthly", 120_000, "2026-01-01", null, 1, "Six-month reserve", 600_000, 7],
  ] as const;
  for (const row of rows) {
    raw.run(
      `INSERT INTO budgets
        (id, category_id, period, limit_cents, effective_from, effective_to, rollover,
         goal_name, goal_amount_cents, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...row, DEMO_RECORDED_AT, DEMO_RECORDED_AT],
    );
  }
  raw.run(
    `INSERT INTO budget_reallocations
      (id, month, from_category_id, to_category_id, amount_cents, input_mode, input_value, created_at)
     VALUES (1, '2026-08', 10, 5, 5000, 'amount', '50.00', ?)`,
    [DEMO_RECORDED_AT],
  );
  const recurring = [
    [1, "Monthly salary", 1, null, 1, 420_000, "Monthly payroll", "monthly", 1, "2026-01-02", null, "2026-09-02", "2026-08-02", 0],
    [2, "Apartment rent", 1, null, 4, 135_000, "Mar Mikhaël lease", "monthly", 1, "2026-01-05", null, "2026-09-05", "2026-08-05", 0],
    [3, "Weekly groceries", 1, null, 5, 11_000, "Saturday grocery plan", "weekly", 1, "2026-08-01", null, "2026-08-22", "2026-08-15", 0],
    [4, "Annual health insurance", 1, null, 9, 90_000, "Annual coverage renewal", "yearly", 1, "2026-10-01", null, "2026-10-01", null, 0],
  ] as const;
  for (const row of recurring) {
    raw.run(
      `INSERT INTO recurring_transactions
        (id, name, account_id, transfer_account_id, category_id, amount_cents, comment,
         frequency, interval, start_date, end_date, next_due, last_generated, archived,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...row, DEMO_RECORDED_AT, DEMO_RECORDED_AT],
    );
  }
}

function insertHistoryAndTravel(raw: Database): void {
  const snapshots = [
    ["2026-01-31", 27_650_000, 18_400, 27_631_600],
    ["2026-02-28", 27_912_000, 25_900, 27_886_100],
    ["2026-03-31", 28_146_000, 34_800, 28_111_200],
    ["2026-04-30", 28_435_000, 34_800, 28_400_200],
    ["2026-05-31", 28_712_000, 34_800, 28_677_200],
    ["2026-06-30", 28_985_000, 56_100, 28_928_900],
    ["2026-07-31", 29_301_000, 68_500, 29_232_500],
    [DEMO_ANCHOR_DATE, 29_584_000, 83_100, 29_500_900],
  ] as const;
  snapshots.forEach(([date, assets, liabilities, net], index) => {
    raw.run(
      `INSERT INTO net_worth_snapshots
        (id, date, currency, total_assets_cents, total_liabilities_cents, net_worth_cents,
         source, source_note, created_at, updated_at)
       VALUES (?, ?, 'USD', ?, ?, ?, 'reconstructed', 'Reconstructed monthly projection', ?, ?)`,
      [index + 1, date, assets, liabilities, net, DEMO_RECORDED_AT, DEMO_RECORDED_AT],
    );
  });
  const history = [
    [1, 1, 25_100_000, "2026-01-31"], [2, 1, 25_250_000, "2026-03-31"],
    [3, 1, 25_500_000, "2026-05-31"], [4, 1, 25_800_000, DEMO_ANCHOR_DATE],
    [5, 2, 1_650_000, "2026-01-31"], [6, 2, 1_550_000, "2026-04-30"],
    [7, 2, 1_450_000, DEMO_ANCHOR_DATE], [8, 3, 120_000, "2026-03-31"],
    [9, 3, 123_600, "2026-05-31"], [10, 3, 126_000, DEMO_ANCHOR_DATE],
  ] as const;
  for (const [id, assetId, value, day] of history) {
    raw.run(
      `INSERT INTO asset_history
        (id, asset_id, value_cents, currency, recorded_day, recorded_at)
       VALUES (?, ?, ?, 'USD', ?, ?)`,
      [id, assetId, value, day, DEMO_RECORDED_AT],
    );
  }
  raw.run(
    `INSERT INTO visited_countries (id, country_code, country_name, visited_at) VALUES
      (1, 'PT', 'Portugal', '2026-04-12'),
      (2, 'JP', 'Japan', '2026-07-08')`,
  );
  raw.run(
    `INSERT INTO travel_checkpoints
      (id, country_code, city_name, latitude, longitude, origin_city_id, visited_at) VALUES
      (1, 'PT', 'Lisbon', 38.7223, -9.1393, NULL, '2026-04-12'),
      (2, 'PT', 'Porto', 41.1579, -8.6291, 1, '2026-04-16'),
      (3, 'JP', 'Tokyo', 35.6762, 139.6503, 2, '2026-07-08')`,
  );
}

export type DemoDataSummary = {
  anchorDate: DateKey;
  accounts: number;
  assets: number;
  budgets: number;
  categories: number;
  confirmedTransactions: number;
  ledgerEvents: number;
  pendingTransactions: number;
  snapshots: number;
};

export async function populateDemoDataWithin(db: BudgetDb, raw: Database): Promise<DemoDataSummary> {
  normalizeFreshSchemaBootstrap(raw);
  insertMetadata(raw);
  registerStableTargets(raw);

  postOpeningAsset(raw, {
    assetId: 1,
    serial: 1,
    instrumentId: "instrument:local:mar-mikhael-apartment",
    label: "Mar Mikhaël Apartment",
    category: "Properties",
    bookAmountMinor: 24_000_000,
    currentValueMinor: 25_800_000,
  });
  postOpeningAsset(raw, {
    assetId: 2,
    serial: 2,
    instrumentId: "instrument:local:silver-hatchback",
    label: "Silver Hatchback",
    category: "Vehicles",
    bookAmountMinor: 1_800_000,
    currentValueMinor: 1_450_000,
  });
  ensureInstrument(raw, {
    id: "instrument:local:aurx",
    kind: "security",
    label: "Global Equity Fund",
    symbol: "AURX",
    unit: "shares",
    category: "Investments",
    priceSource: null,
    priceCurrency: "USD",
  }, DEMO_RECORDED_AT);
  recordInstrumentObservation(raw, {
    instrumentId: "instrument:local:aurx",
    observationKind: "price",
    observedDay: DEMO_ANCHOR_DATE,
    observedAt: DEMO_RECORDED_AT,
    amountMinor: 10_500,
    currency: "USD",
    source: "manual-entry",
  });
  registerLedgerAccount(raw, {
    targetType: "instrument",
    targetRef: "instrument:local:aurx",
    currency: "USD",
    instrumentId: "instrument:local:aurx",
    createdAt: DEMO_RECORDED_AT,
  });

  confirmedTransactions.forEach((transaction) => insertTransaction(raw, transaction, false));
  pendingTransactions.forEach((transaction) => insertTransaction(raw, transaction, true));
  projectPositionHolding(raw, "instrument:local:aurx", "USD");
  raw.run(
    "UPDATE assets SET created_at = ?, updated_at = ? WHERE instrument_id = 'instrument:local:aurx'",
    [DEMO_RECORDED_AT, DEMO_RECORDED_AT],
  );
  await syncCashAssetWithin(db);
  raw.run("UPDATE assets SET created_at = ?, updated_at = ? WHERE category = 'Cash'", [
    DEMO_RECORDED_AT,
    DEMO_RECORDED_AT,
  ]);

  insertBudgetsAndPlans(raw);
  insertHistoryAndTravel(raw);
  raw.run("UPDATE localfi_schema_journal SET applied_at = ?", [DEMO_RECORDED_AT]);

  const verification = verifyLedgerRaw(raw);
  if (!verification.ok) {
    throw new Error(`Generated demo ledger failed verification: ${JSON.stringify(verification.failures)}`);
  }
  return {
    anchorDate: DEMO_ANCHOR_DATE,
    accounts: scalar(raw, "SELECT COUNT(*) FROM accounts"),
    assets: scalar(raw, "SELECT COUNT(*) FROM assets"),
    budgets: scalar(raw, "SELECT COUNT(*) FROM budgets"),
    categories: scalar(raw, "SELECT COUNT(*) FROM categories"),
    confirmedTransactions: scalar(raw, "SELECT COUNT(*) FROM transactions WHERE pending = 0"),
    ledgerEvents: verification.counts.events,
    pendingTransactions: scalar(raw, "SELECT COUNT(*) FROM transactions WHERE pending = 1"),
    snapshots: scalar(raw, "SELECT COUNT(*) FROM net_worth_snapshots"),
  };
}
