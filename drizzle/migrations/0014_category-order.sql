ALTER TABLE `categories` ADD `display_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `categories_type_display_order_idx` ON `categories` (`type`,`display_order`,`id`);