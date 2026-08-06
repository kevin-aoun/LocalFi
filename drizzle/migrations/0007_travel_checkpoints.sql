CREATE TABLE `travel_checkpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`country_code` text NOT NULL,
	`city_name` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`visited_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`country_code`) REFERENCES `visited_countries`(`country_code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `travel_checkpoints_country_city_unique` ON `travel_checkpoints` (`country_code`,`city_name`);