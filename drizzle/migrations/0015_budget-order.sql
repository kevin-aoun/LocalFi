ALTER TABLE `budgets` ADD `display_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `budgets_display_order_idx` ON `budgets` (`display_order`,`id`);