-- DECISION: DEC-015 — this preference controls explorer visibility only.
ALTER TABLE `settings` ADD `show_ledger` integer DEFAULT false NOT NULL;
