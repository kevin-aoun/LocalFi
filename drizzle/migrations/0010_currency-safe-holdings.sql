/*
 0010 — currency-safe holdings and retained history.

 DECISION: DEC-004 — provider-priced rows are USD and aggregate snapshots name
 their single denomination.
 DECISION: DEC-006 — holdings archive by default; daily history is unique per
 holding/calendar day. Existing duplicates retain the newest recorded_at/id row.
*/
PRAGMA foreign_keys=OFF;--> statement-breakpoint

ALTER TABLE `assets` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint

/* Every current live quote came from a USD-only provider. Fix legacy labels. */
UPDATE `assets`
SET `currency` = 'USD'
WHERE `use_live_price` = 1 OR NULLIF(TRIM(`price_symbol`), '') IS NOT NULL;--> statement-breakpoint

CREATE TABLE `__new_asset_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`value_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`recorded_day` text NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `asset_history_currency_valid` CHECK(`currency` GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT `asset_history_recorded_day_valid` CHECK(
		`recorded_day` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
		AND date(`recorded_day`, '+0 days') = `recorded_day`
	)
);--> statement-breakpoint

INSERT INTO `__new_asset_history`
	(`id`, `asset_id`, `value_cents`, `currency`, `recorded_day`, `recorded_at`)
SELECT
	`h`.`id`,
	`h`.`asset_id`,
	`h`.`value_cents`,
	CASE
		WHEN `a`.`use_live_price` = 1 OR NULLIF(TRIM(`a`.`price_symbol`), '') IS NOT NULL THEN 'USD'
		ELSE UPPER(COALESCE(NULLIF(TRIM(`a`.`currency`), ''), 'USD'))
	END,
	strftime('%Y-%m-%d', `h`.`recorded_at`, 'unixepoch', 'localtime'),
	`h`.`recorded_at`
FROM `asset_history` `h`
JOIN `assets` `a` ON `a`.`id` = `h`.`asset_id`
WHERE `h`.`id` = (
	SELECT `newest`.`id`
	FROM `asset_history` `newest`
	WHERE `newest`.`asset_id` = `h`.`asset_id`
	  AND strftime('%Y-%m-%d', `newest`.`recorded_at`, 'unixepoch', 'localtime')
	      = strftime('%Y-%m-%d', `h`.`recorded_at`, 'unixepoch', 'localtime')
	ORDER BY `newest`.`recorded_at` DESC, `newest`.`id` DESC
	LIMIT 1
);--> statement-breakpoint

DROP TABLE `asset_history`;--> statement-breakpoint
ALTER TABLE `__new_asset_history` RENAME TO `asset_history`;--> statement-breakpoint
CREATE UNIQUE INDEX `asset_history_asset_day_unique`
	ON `asset_history` (`asset_id`, `recorded_day`);--> statement-breakpoint

ALTER TABLE `net_worth_snapshots` ADD `currency` text DEFAULT 'USD' NOT NULL;--> statement-breakpoint

PRAGMA foreign_keys=ON;
