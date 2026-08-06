CREATE TABLE `visited_countries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`country_code` text NOT NULL,
	`country_name` text NOT NULL,
	`visited_at` text DEFAULT (current_timestamp)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visited_countries_country_code_unique` ON `visited_countries` (`country_code`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `pending` integer DEFAULT false NOT NULL;