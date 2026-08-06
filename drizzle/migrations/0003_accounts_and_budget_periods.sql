/*
 0003 — the core domain model of a budget tracker.

 Adds, in dependency order:
   accounts                 both halves of the balance sheet, discriminated by `kind`
   recurring_transactions   templates for rent / salary / subscriptions
   transactions (rebuilt)   account_id, transfer_account_id, nullable category_id,
                            recurring_id + recurring_occurrence
   budgets                  per-category limits with a period and effective dates
   net_worth_snapshots      day-resolution net-worth history

 THREE THINGS THIS MIGRATION DELIBERATELY DOES TO EXISTING DATA:

 1. Seeds one default account ("Main", asset/Checking, opening balance 0) and
    points every existing transaction at it. Without this, 71 real transactions
    would be orphaned from the new per-account model.

 2. REPAIRS two long-standing orphans. transactions id 17 ($24.00) and id 40
    ($5.00) carried `category_id = 0`, referencing a category that had been
    deleted — a real referential bug that `PRAGMA foreign_key_check` has been
    reporting. Because `category_id` becomes NULLABLE here, they are set to NULL
    rather than pointed at an invented "Uncategorized" category. NULL was chosen
    over a placeholder category on purpose: lib/cash-balance.ts contributes
    NOTHING for a row with no category, exactly as it already contributed nothing
    for a row whose category was missing, so the derived cash balance stays
    EXACTLY 449618 cents ($4,496.18). Attaching them to a real Expense category
    would instead have silently moved the user's balance by $29.00. The amounts,
    dates and comments are untouched, so no total changes.

 3. Copies every non-null `categories.monthly_limit_cents` into a `budgets` row
    (period 'monthly', rollover off, effective from the first day of the month of
    the earliest transaction, so historical performance covers the whole ledger).
    The legacy column is KEPT and still read — see `budgetsFromLegacyLimits` in
    lib/budgets.ts — so nothing that depends on it regresses.

 SQLite cannot add a foreign key, drop NOT NULL, or add a CHECK constraint in
 place, so `transactions` is rebuilt with the usual create/copy/drop/rename dance.
 That dance is bracketed by PRAGMA foreign_keys=OFF/ON: `asset_history.asset_id`
 REFERENCES assets ON DELETE CASCADE, and dropping a table with FK enforcement on
 can either fail or cascade real rows away. `assets` and `asset_history` are not
 touched here at all, and the migration is verified with `PRAGMA foreign_key_check`
 before and after (see lib/db/migrate-to-accounts.ts).
*/
PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`type` text NOT NULL,
	`opening_balance_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `accounts_kind_valid` CHECK(`kind` IN ('asset', 'liability'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_name_unique` ON `accounts` (`name`);--> statement-breakpoint
CREATE INDEX `accounts_kind_idx` ON `accounts` (`kind`);--> statement-breakpoint

/* The default account every pre-0003 transaction is attached to. */
INSERT INTO `accounts` (`id`, `name`, `kind`, `type`, `opening_balance_cents`, `currency`, `archived`)
VALUES (1, 'Main', 'asset', 'Checking', 0, 'USD', 0);
--> statement-breakpoint

CREATE TABLE `recurring_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`account_id` integer,
	`transfer_account_id` integer,
	`category_id` integer,
	`amount_cents` integer NOT NULL,
	`comment` text,
	`frequency` text NOT NULL,
	`interval` integer DEFAULT 1 NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`next_due` text,
	`last_generated` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transfer_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `recurring_frequency_valid` CHECK(`frequency` IN ('daily', 'weekly', 'monthly', 'yearly')),
	CONSTRAINT `recurring_interval_valid` CHECK(`interval` >= 1),
	CONSTRAINT `recurring_transfer_distinct` CHECK(`transfer_account_id` IS NULL OR `transfer_account_id` <> `account_id`)
);
--> statement-breakpoint
CREATE INDEX `recurring_next_due_idx` ON `recurring_transactions` (`next_due`);--> statement-breakpoint

CREATE TABLE `__new_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` integer DEFAULT (unixepoch()) NOT NULL,
	`category_id` integer,
	`account_id` integer,
	`transfer_account_id` integer,
	`amount_cents` integer NOT NULL,
	`comment` text,
	`pending` integer DEFAULT false NOT NULL,
	`recurring_id` integer,
	`recurring_occurrence` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transfer_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recurring_id`) REFERENCES `recurring_transactions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `transactions_transfer_distinct` CHECK(`transfer_account_id` IS NULL OR `transfer_account_id` <> `account_id`)
);
--> statement-breakpoint
/*
 category_id: keep it when it still resolves, NULL it when it does not. This is
 the repair for ids 17 and 40; every other row keeps the category it had.
 account_id: everything lands on the seeded default account.
*/
INSERT INTO `__new_transactions`
	(`id`, `date`, `category_id`, `account_id`, `transfer_account_id`, `amount_cents`, `comment`, `pending`, `recurring_id`, `recurring_occurrence`, `created_at`, `updated_at`)
SELECT
	`id`,
	`date`,
	CASE WHEN `category_id` IN (SELECT `id` FROM `categories`) THEN `category_id` ELSE NULL END,
	1,
	NULL,
	`amount_cents`,
	`comment`,
	`pending`,
	NULL,
	NULL,
	`created_at`,
	`updated_at`
FROM `transactions`;
--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
CREATE INDEX `transactions_account_idx` ON `transactions` (`account_id`);--> statement-breakpoint
CREATE INDEX `transactions_category_idx` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`date`);--> statement-breakpoint
/*
 The structural guarantee behind idempotent recurring-transaction generation:
 at most one transaction per (template, occurrence day). Partial, so the 71
 hand-entered rows (recurring_id IS NULL) are unaffected.
*/
CREATE UNIQUE INDEX `transactions_recurring_occurrence_unique` ON `transactions` (`recurring_id`, `recurring_occurrence`) WHERE `recurring_id` IS NOT NULL;--> statement-breakpoint

CREATE TABLE `budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer NOT NULL,
	`period` text NOT NULL,
	`limit_cents` integer NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`rollover` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `budgets_period_valid` CHECK(`period` IN ('weekly', 'monthly', 'yearly')),
	CONSTRAINT `budgets_window_valid` CHECK(`effective_to` IS NULL OR `effective_to` >= `effective_from`)
);
--> statement-breakpoint
CREATE INDEX `budgets_category_idx` ON `budgets` (`category_id`,`effective_from`);--> statement-breakpoint
CREATE INDEX `budgets_period_idx` ON `budgets` (`period`);--> statement-breakpoint
/*
 Legacy monthly limits -> real budget rows. `effective_from` is the first day of
 the month of the earliest transaction (UTC-derived on purpose: no 'localtime'
 modifier, so the result is identical on every machine, and an off-by-one can
 only make the date EARLIER, which merely adds empty leading periods).
*/
INSERT INTO `budgets` (`category_id`, `period`, `limit_cents`, `effective_from`, `effective_to`, `rollover`)
SELECT
	`c`.`id`,
	'monthly',
	`c`.`monthly_limit_cents`,
	COALESCE(
		(SELECT strftime('%Y-%m-01', MIN(`t`.`date`), 'unixepoch') FROM `transactions` `t`),
		strftime('%Y-%m-01', 'now')
	),
	NULL,
	0
FROM `categories` `c`
WHERE `c`.`monthly_limit_cents` IS NOT NULL
ORDER BY `c`.`id`;
--> statement-breakpoint

CREATE TABLE `net_worth_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`total_assets_cents` integer NOT NULL,
	`total_liabilities_cents` integer NOT NULL,
	`net_worth_cents` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `net_worth_snapshots_date_unique` ON `net_worth_snapshots` (`date`);--> statement-breakpoint

PRAGMA foreign_keys=ON;
