CREATE TABLE `budget_reallocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`from_category_id` integer NOT NULL,
	`to_category_id` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`input_mode` text NOT NULL,
	`input_value` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`from_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "budget_reallocations_amount_positive" CHECK("budget_reallocations"."amount_cents" > 0),
	CONSTRAINT "budget_reallocations_categories_different" CHECK("budget_reallocations"."from_category_id" <> "budget_reallocations"."to_category_id"),
	CONSTRAINT "budget_reallocations_mode_valid" CHECK("budget_reallocations"."input_mode" IN ('amount', 'percentage'))
);
--> statement-breakpoint
CREATE INDEX `budget_reallocations_month_idx` ON `budget_reallocations` (`month`);--> statement-breakpoint
CREATE INDEX `budget_reallocations_from_idx` ON `budget_reallocations` (`from_category_id`,`month`);--> statement-breakpoint
CREATE INDEX `budget_reallocations_to_idx` ON `budget_reallocations` (`to_category_id`,`month`);
