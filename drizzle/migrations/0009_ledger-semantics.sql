/*
 0009 — immutable ledger meaning (DECISION: DEC-003).

 Transactions now carry their own cash direction and currency. Accounts carry
 the calendar day on which their opening balance becomes effective. Both money
 columns are rebuilt with non-negative magnitude checks.

 Existing transaction effects are preserved when a historical negative amount
 is encountered: non-transfer direction is inverted, while a negative transfer
 has its two account legs swapped. Currency is copied from the source account,
 falling back to USD only for legacy unassigned rows. Opening-balance dates use
 the UTC creation day as deterministic migration provenance.
*/
PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `__new_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`type` text NOT NULL,
	`opening_balance_cents` integer DEFAULT 0 NOT NULL,
	`opening_balance_date` text DEFAULT (date('now', 'localtime')) NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `accounts_kind_valid` CHECK(`kind` IN ('asset', 'liability')),
	CONSTRAINT `accounts_opening_balance_magnitude` CHECK(typeof(`opening_balance_cents`) = 'integer' AND `opening_balance_cents` >= 0),
	CONSTRAINT `accounts_opening_balance_date_valid` CHECK(`opening_balance_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(`opening_balance_date`, '+0 days') = `opening_balance_date`),
	CONSTRAINT `accounts_currency_valid` CHECK(`currency` GLOB '[A-Z][A-Z][A-Z]')
);--> statement-breakpoint
INSERT INTO `__new_accounts`
	(`id`, `name`, `kind`, `type`, `opening_balance_cents`, `opening_balance_date`, `currency`, `archived`, `created_at`, `updated_at`)
SELECT
	`id`,
	`name`,
	`kind`,
	`type`,
	ABS(`opening_balance_cents`),
	strftime('%Y-%m-%d', `created_at`, 'unixepoch', 'localtime'),
	UPPER(COALESCE(NULLIF(TRIM(`currency`), ''), 'USD')),
	`archived`,
	`created_at`,
	`updated_at`
FROM `accounts`;--> statement-breakpoint
DROP TABLE `accounts`;--> statement-breakpoint
ALTER TABLE `__new_accounts` RENAME TO `accounts`;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_name_unique` ON `accounts` (`name`);--> statement-breakpoint
CREATE INDEX `accounts_kind_idx` ON `accounts` (`kind`);--> statement-breakpoint

CREATE TABLE `__new_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` integer DEFAULT (unixepoch()) NOT NULL,
	`category_id` integer,
	`account_id` integer,
	`transfer_account_id` integer,
	`amount_cents` integer NOT NULL,
	`direction` text DEFAULT 'legacy' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
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
	CONSTRAINT `transactions_transfer_distinct` CHECK(`transfer_account_id` IS NULL OR `transfer_account_id` <> `account_id`),
	CONSTRAINT `transactions_amount_magnitude` CHECK(typeof(`amount_cents`) = 'integer' AND `amount_cents` >= 0),
	CONSTRAINT `transactions_direction_valid` CHECK(`direction` IN ('inflow', 'outflow', 'transfer', 'legacy')),
	CONSTRAINT `transactions_direction_shape` CHECK(
		`direction` = 'legacy' OR
		(`direction` = 'transfer' AND `transfer_account_id` IS NOT NULL AND `category_id` IS NULL) OR
		(`direction` IN ('inflow', 'outflow') AND `transfer_account_id` IS NULL)
	),
	CONSTRAINT `transactions_currency_valid` CHECK(`currency` GLOB '[A-Z][A-Z][A-Z]')
);--> statement-breakpoint
INSERT INTO `__new_transactions`
	(`id`, `date`, `category_id`, `account_id`, `transfer_account_id`, `amount_cents`, `direction`, `currency`, `comment`, `pending`, `recurring_id`, `recurring_occurrence`, `created_at`, `updated_at`)
SELECT
	`t`.`id`,
	`t`.`date`,
	`t`.`category_id`,
	CASE WHEN `t`.`transfer_account_id` IS NOT NULL AND `t`.`amount_cents` < 0
		THEN `t`.`transfer_account_id` ELSE `t`.`account_id` END,
	CASE WHEN `t`.`transfer_account_id` IS NOT NULL AND `t`.`amount_cents` < 0
		THEN `t`.`account_id` ELSE `t`.`transfer_account_id` END,
	ABS(`t`.`amount_cents`),
	CASE
		WHEN `t`.`transfer_account_id` IS NOT NULL THEN 'transfer'
		WHEN (`c`.`type` = 'Income' AND `t`.`amount_cents` >= 0)
			OR (`c`.`type` IN ('Expense', 'Investment') AND `t`.`amount_cents` < 0) THEN 'inflow'
		ELSE 'outflow'
	END,
	UPPER(COALESCE(NULLIF(TRIM(`a`.`currency`), ''), 'USD')),
	`t`.`comment`,
	`t`.`pending`,
	`t`.`recurring_id`,
	`t`.`recurring_occurrence`,
	`t`.`created_at`,
	`t`.`updated_at`
FROM `transactions` `t`
LEFT JOIN `categories` `c` ON `c`.`id` = `t`.`category_id`
LEFT JOIN `accounts` `a` ON `a`.`id` = CASE
	WHEN `t`.`transfer_account_id` IS NOT NULL AND `t`.`amount_cents` < 0
		THEN `t`.`transfer_account_id` ELSE `t`.`account_id` END;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
CREATE INDEX `transactions_account_idx` ON `transactions` (`account_id`);--> statement-breakpoint
CREATE INDEX `transactions_category_idx` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_recurring_occurrence_unique` ON `transactions` (`recurring_id`, `recurring_occurrence`) WHERE `recurring_id` IS NOT NULL;--> statement-breakpoint

/*
 Test fixtures and supported legacy tools historically omitted direction. Keep
 that compatibility at the SQL boundary, but normalize the sentinel immediately
 after insert so no stored row retains it. Application producers always provide
 direction explicitly.
*/
CREATE TRIGGER `transactions_fill_legacy_semantics`
AFTER INSERT ON `transactions`
WHEN NEW.`direction` = 'legacy'
BEGIN
	UPDATE `transactions`
	SET
		`direction` = CASE
			WHEN NEW.`transfer_account_id` IS NOT NULL THEN 'transfer'
			WHEN (SELECT `type` FROM `categories` WHERE `id` = NEW.`category_id`) = 'Income' THEN 'inflow'
			ELSE 'outflow'
		END,
		`currency` = UPPER(COALESCE(
			NULLIF(TRIM((SELECT `currency` FROM `accounts` WHERE `id` = NEW.`account_id`)), ''),
			NEW.`currency`,
			'USD'
		))
	WHERE `id` = NEW.`id`;
END;--> statement-breakpoint

/* The sentinel is insert-only compatibility; it can never become stored state. */
CREATE TRIGGER `transactions_reject_legacy_update`
BEFORE UPDATE OF `direction` ON `transactions`
WHEN NEW.`direction` = 'legacy'
BEGIN
	SELECT RAISE(ABORT, 'legacy transaction direction is insert-only');
END;--> statement-breakpoint

CREATE TRIGGER `transactions_reject_cross_currency_insert`
BEFORE INSERT ON `transactions`
WHEN NEW.`transfer_account_id` IS NOT NULL
  AND COALESCE((SELECT `currency` FROM `accounts` WHERE `id` = NEW.`account_id`), 'USD')
      <> COALESCE((SELECT `currency` FROM `accounts` WHERE `id` = NEW.`transfer_account_id`), 'USD')
BEGIN
	SELECT RAISE(ABORT, 'cross-currency transfers require an FX model');
END;--> statement-breakpoint

CREATE TRIGGER `transactions_reject_cross_currency_update`
BEFORE UPDATE OF `account_id`, `transfer_account_id` ON `transactions`
WHEN NEW.`transfer_account_id` IS NOT NULL
  AND COALESCE((SELECT `currency` FROM `accounts` WHERE `id` = NEW.`account_id`), 'USD')
      <> COALESCE((SELECT `currency` FROM `accounts` WHERE `id` = NEW.`transfer_account_id`), 'USD')
BEGIN
	SELECT RAISE(ABORT, 'cross-currency transfers require an FX model');
END;--> statement-breakpoint

CREATE TRIGGER `accounts_reject_active_currency_change`
BEFORE UPDATE OF `currency` ON `accounts`
WHEN NEW.`currency` <> OLD.`currency`
  AND EXISTS (
	SELECT 1 FROM `transactions`
	WHERE `account_id` = OLD.`id` OR `transfer_account_id` = OLD.`id`
  )
BEGIN
	SELECT RAISE(ABORT, 'account currency is immutable once transaction history exists');
END;--> statement-breakpoint

PRAGMA foreign_keys=ON;
