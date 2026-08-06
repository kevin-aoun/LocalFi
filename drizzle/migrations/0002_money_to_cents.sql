/*
 Money columns: real (float64) -> integer minor units (cents).

 SQLite cannot retype a column in place, so each affected table is rebuilt:
 create the replacement, copy every row (converting the money column with
 CAST(ROUND(x * 100) AS integer)), drop the original, rename into place.
 Row counts and ids are preserved; a NULL monthly_limit stays NULL.

 `assets.quantity` stays `real` on purpose: it is a physical weight in troy
 ounces, not money, and rounding it to two decimals would lose precision.

 NOTE: the live database at data/budget.db is converted by
 lib/db/migrate-to-cents.ts, which computes the cents in JS with
 Math.round(value * 100) and asserts value conservation. This file exists so a
 database created by replaying the journal (lib/db/init.ts) ends up with the
 same schema, and so any other SQLite copy can be converted with plain SQL.
*/
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`monthly_limit_cents` integer,
	`icon` text NOT NULL,
	`color` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_categories`(`id`, `name`, `type`, `monthly_limit_cents`, `icon`, `color`, `created_at`, `updated_at`) SELECT `id`, `name`, `type`, CAST(ROUND(`monthly_limit` * 100) AS integer), `icon`, `color`, `created_at`, `updated_at` FROM `categories`;--> statement-breakpoint
DROP TABLE `categories`;--> statement-breakpoint
ALTER TABLE `__new_categories` RENAME TO `categories`;--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE TABLE `__new_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` integer DEFAULT (unixepoch()) NOT NULL,
	`category_id` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`comment` text,
	`pending` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_transactions`(`id`, `date`, `category_id`, `amount_cents`, `comment`, `pending`, `created_at`, `updated_at`) SELECT `id`, `date`, `category_id`, CAST(ROUND(`amount` * 100) AS integer), `comment`, `pending`, `created_at`, `updated_at` FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
CREATE TABLE `__new_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`current_value_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`notes` text,
	`commodity_type` text,
	`quantity` real,
	`unit` text,
	`linked_transaction_ids` text,
	`use_live_price` integer DEFAULT false,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_assets`(`id`, `category`, `current_value_cents`, `currency`, `notes`, `commodity_type`, `quantity`, `unit`, `linked_transaction_ids`, `use_live_price`, `created_at`, `updated_at`) SELECT `id`, `category`, CAST(ROUND(`current_value` * 100) AS integer), `currency`, `notes`, `commodity_type`, `quantity`, `unit`, `linked_transaction_ids`, `use_live_price`, `created_at`, `updated_at` FROM `assets`;--> statement-breakpoint
DROP TABLE `assets`;--> statement-breakpoint
ALTER TABLE `__new_assets` RENAME TO `assets`;--> statement-breakpoint
CREATE TABLE `__new_asset_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`value_cents` integer NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_asset_history`(`id`, `asset_id`, `value_cents`, `recorded_at`) SELECT `id`, `asset_id`, CAST(ROUND(`value` * 100) AS integer), `recorded_at` FROM `asset_history`;--> statement-breakpoint
DROP TABLE `asset_history`;--> statement-breakpoint
ALTER TABLE `__new_asset_history` RENAME TO `asset_history`;--> statement-breakpoint
CREATE TABLE `__new_quick_commands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`command` text NOT NULL,
	`category_name` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`comment` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_quick_commands`(`id`, `command`, `category_name`, `amount_cents`, `comment`, `created_at`, `updated_at`) SELECT `id`, `command`, `category_name`, CAST(ROUND(`amount` * 100) AS integer), `comment`, `created_at`, `updated_at` FROM `quick_commands`;--> statement-breakpoint
DROP TABLE `quick_commands`;--> statement-breakpoint
ALTER TABLE `__new_quick_commands` RENAME TO `quick_commands`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
