/*
 0011 — optional savings goals on monthly rollover budgets.

 DECISION: DEC-008 — goals label and target the existing rollover balance;
 they do not create contributions, transactions, or any second ledger.
*/
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer NOT NULL,
	`period` text NOT NULL,
	`limit_cents` integer NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`rollover` integer DEFAULT false NOT NULL,
	`goal_name` text,
	`goal_amount_cents` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "budgets_period_valid" CHECK("__new_budgets"."period" IN ('weekly', 'monthly', 'yearly')),
	CONSTRAINT "budgets_window_valid" CHECK("__new_budgets"."effective_to" IS NULL OR "__new_budgets"."effective_to" >= "__new_budgets"."effective_from"),
	CONSTRAINT "budgets_goal_valid" CHECK((
        "__new_budgets"."goal_name" IS NULL AND "__new_budgets"."goal_amount_cents" IS NULL
      ) OR (
        "__new_budgets"."goal_name" IS NOT NULL
        AND "__new_budgets"."goal_amount_cents" IS NOT NULL
        AND length(trim("__new_budgets"."goal_name")) > 0
        AND typeof("__new_budgets"."goal_amount_cents") = 'integer'
        AND "__new_budgets"."goal_amount_cents" > 0
        AND "__new_budgets"."period" = 'monthly'
        AND "__new_budgets"."rollover" = 1
      ))
);
--> statement-breakpoint
INSERT INTO `__new_budgets`("id", "category_id", "period", "limit_cents", "effective_from", "effective_to", "rollover", "goal_name", "goal_amount_cents", "created_at", "updated_at") SELECT "id", "category_id", "period", "limit_cents", "effective_from", "effective_to", "rollover", NULL, NULL, "created_at", "updated_at" FROM `budgets`;--> statement-breakpoint
DROP TABLE `budgets`;--> statement-breakpoint
ALTER TABLE `__new_budgets` RENAME TO `budgets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `budgets_category_idx` ON `budgets` (`category_id`,`effective_from`);--> statement-breakpoint
CREATE INDEX `budgets_period_idx` ON `budgets` (`period`);
